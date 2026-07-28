const { PrismaClient } = require('@prisma/client');
const { S3Client, ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

const prisma = new PrismaClient();
const bucketName = process.env.R2_BUCKET_NAME || 'fotosetgo-photos';
const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT_URL || '',
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  },
  forcePathStyle: true,
});

async function migratePhotographerR2Keys(photographerId) {
  console.log(`\n======================================================`);
  console.log(`Starting R2 Migration for Photographer: ${photographerId}`);
  console.log(`======================================================`);

  let movedCount = 0;
  let isTruncated = true;
  let continuationToken = undefined;

  // 1. List all objects in bucket
  const allObjects = [];
  while (isTruncated) {
    const res = await s3Client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      ContinuationToken: continuationToken,
    }));
    if (res.Contents) {
      allObjects.push(...res.Contents);
    }
    isTruncated = res.IsTruncated || false;
    continuationToken = res.NextContinuationToken;
  }

  console.log(`Total objects in bucket: ${allObjects.length}`);

  for (const item of allObjects) {
    const oldKey = item.Key;
    if (!oldKey) continue;

    let newKey = null;

    if (oldKey.startsWith(`photographers/${photographerId}/`)) {
      // photographers/${photographerId}/... -> ${photographerId}/...
      newKey = oldKey.replace(`photographers/${photographerId}/`, `${photographerId}/`);
    } else if (oldKey.startsWith(`portfolio/showcase/${photographerId}/`)) {
      // portfolio/showcase/${photographerId}/... -> ${photographerId}/portfolio/showcase/...
      newKey = oldKey.replace(`portfolio/showcase/${photographerId}/`, `${photographerId}/portfolio/showcase/`);
    } else if (oldKey.startsWith(`portfolio/reels/${photographerId}_`)) {
      // portfolio/reels/${photographerId}_${filename} -> ${photographerId}/portfolio/reels/${filename}
      const filename = oldKey.replace(`portfolio/reels/${photographerId}_`, '');
      newKey = `${photographerId}/portfolio/reels/${filename}`;
    } else if (oldKey.startsWith(`portfolio/about/${photographerId}`)) {
      newKey = `${photographerId}/portfolio/about.png`;
    } else if (oldKey.startsWith(`portfolio/hero/${photographerId}`)) {
      newKey = `${photographerId}/portfolio/hero.png`;
    } else if (oldKey.startsWith(`branding/logos/${photographerId}`)) {
      newKey = `${photographerId}/branding/logo.png`;
    } else if (oldKey.startsWith(`branding/banners/${photographerId}`)) {
      newKey = `${photographerId}/branding/banner.png`;
    } else if (oldKey.startsWith(`watermarks/${photographerId}`)) {
      newKey = `${photographerId}/branding/watermark.png`;
    } else if (oldKey.startsWith(`events/`)) {
      // Legacy photo thumbnail: events/${eventId}/thumb/${photoId}.jpg
      const match = oldKey.match(/^events\/([^/]+)\/thumb\/([^/]+)$/);
      if (match) {
        const [, eventId, filename] = match;
        // Check if event belongs to this photographer
        const evt = await prisma.event.findFirst({ where: { id: eventId, photographerId } });
        if (evt) {
          newKey = `${photographerId}/events/${eventId}/thumbs/${filename}`;
        }
      }
    }

    if (newKey && newKey !== oldKey) {
      console.log(`[Migrate] Copying: "${oldKey}" -> "${newKey}"`);
      try {
        // Copy object to new key
        await s3Client.send(new CopyObjectCommand({
          Bucket: bucketName,
          CopySource: `${bucketName}/${oldKey}`,
          Key: newKey,
        }));

        // Delete old key
        await s3Client.send(new DeleteObjectCommand({
          Bucket: bucketName,
          Key: oldKey,
        }));

        movedCount++;

        // Update DB references pointing to oldKey
        await prisma.photo.updateMany({
          where: { r2KeyOriginal: oldKey },
          data: { r2KeyOriginal: newKey }
        });
        await prisma.photo.updateMany({
          where: { r2KeyThumb: oldKey },
          data: { r2KeyThumb: newKey }
        });
        await prisma.portfolioPhoto.updateMany({
          where: { r2KeyOriginal: oldKey },
          data: { r2KeyOriginal: newKey }
        });
        await prisma.portfolioPhoto.updateMany({
          where: { r2KeyThumb: oldKey },
          data: { r2KeyThumb: newKey }
        });
        await prisma.photographer.updateMany({
          where: { studioLogoKey: oldKey },
          data: { studioLogoKey: newKey }
        });
        await prisma.photographer.updateMany({
          where: { studioHeroBannerKey: oldKey },
          data: { studioHeroBannerKey: newKey }
        });
        await prisma.photographer.updateMany({
          where: { portfolioHeroImageKey: oldKey },
          data: { portfolioHeroImageKey: newKey }
        });
        await prisma.photographer.updateMany({
          where: { portfolioAboutImageKey: oldKey },
          data: { portfolioAboutImageKey: newKey }
        });
        await prisma.photographer.updateMany({
          where: { watermarkImageKey: oldKey },
          data: { watermarkImageKey: newKey }
        });
      } catch (err) {
        console.error(`[Migrate Error] Failed to move ${oldKey}:`, err);
      }
    }
  }

  console.log(`✅ Successfully migrated ${movedCount} objects to unified ${photographerId}/ structure.`);
}

async function main() {
  const photographers = await prisma.photographer.findMany();
  for (const p of photographers) {
    await migratePhotographerR2Keys(p.id);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
