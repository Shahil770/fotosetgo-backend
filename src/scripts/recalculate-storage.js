/**
 * recalculate-storage.js
 * Recalculates actual storage used directly from Cloudflare R2 bucket object listings
 * for each photographer and updates photographer + subscription to the live R2 value.
 */
const { PrismaClient } = require('@prisma/client');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
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

async function getR2StorageForPhotographer(photographerId) {
  let totalBytes = BigInt(0);
  let isTruncated = true;
  let continuationToken = undefined;

  while (isTruncated) {
    try {
      const command = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: `${photographerId}/`,
        ContinuationToken: continuationToken,
      });

      const response = await s3Client.send(command);
      if (response.Contents) {
        for (const item of response.Contents) {
          if (item.Size) {
            totalBytes += BigInt(item.Size);
          }
        }
      }
      isTruncated = response.IsTruncated || false;
      continuationToken = response.NextContinuationToken;
    } catch (err) {
      console.error(`[R2StorageCalc] Error listing prefix ${photographerId}/:`, err.message);
      isTruncated = false;
    }
  }

  return totalBytes;
}


async function main() {
  const photographers = await prisma.photographer.findMany({
    select: { id: true, totalStorageUsedBytes: true }
  });

  for (const photographer of photographers) {
    // Live calculate total bytes directly from Cloudflare R2 bucket
    const actualBytes = await getR2StorageForPhotographer(photographer.id);
    const oldBytes = photographer.totalStorageUsedBytes;

    console.log(`Photographer: ${photographer.id}`);
    console.log(`  Old storage: ${oldBytes} bytes`);
    console.log(`  Live R2 storage: ${actualBytes} bytes`);

    // Update photographer
    await prisma.photographer.update({
      where: { id: photographer.id },
      data: { totalStorageUsedBytes: actualBytes }
    });

    // Update active subscription
    const activeSub = await prisma.subscription.findFirst({
      where: { photographerId: photographer.id, status: 'ACTIVE' },
      orderBy: { startsAt: 'desc' }
    });

    if (activeSub) {
      await prisma.subscription.update({
        where: { id: activeSub.id },
        data: { usedBytes: actualBytes }
      });
      console.log(`  Subscription ${activeSub.id} updated.`);
    }

    console.log(`  ✅ Storage corrected to ${actualBytes} bytes (${(Number(actualBytes) / 1024 / 1024).toFixed(2)} MB)`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

