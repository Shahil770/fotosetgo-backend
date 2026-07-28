const { PrismaClient } = require('@prisma/client');
const { S3Client, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
require('dotenv').config();

const prisma = new PrismaClient();
const bucketName = process.env.R2_BUCKET_NAME || 'fotosetgo-photos';
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT_URL,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

async function objectExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log('=================================================');
  console.log('Verifying photo URL generation end-to-end');
  console.log('=================================================\n');

  // Check 5 photos from each photographer
  const photographers = await prisma.photographer.findMany({ select: { id: true } });
  
  for (const pg of photographers) {
    console.log(`\nPhotographer: ${pg.id}`);
    const photos = await prisma.photo.findMany({
      where: { event: { photographerId: pg.id }, r2KeyOriginal: { not: '' } },
      take: 3,
      select: { id: true, r2KeyOriginal: true, r2KeyThumb: true },
    });

    if (photos.length === 0) {
      console.log('  No photos found');
      continue;
    }

    for (const photo of photos) {
      const originalExists = await objectExists(photo.r2KeyOriginal);
      const thumbExists = photo.r2KeyThumb ? await objectExists(photo.r2KeyThumb) : null;

      console.log(`\n  Photo: ${photo.id}`);
      console.log(`  r2KeyOriginal: ${photo.r2KeyOriginal}`);
      console.log(`  Original in R2: ${originalExists ? '✅ EXISTS' : '❌ NOT FOUND'}`);
      if (photo.r2KeyThumb) {
        console.log(`  r2KeyThumb: ${photo.r2KeyThumb}`);
        console.log(`  Thumb in R2: ${thumbExists ? '✅ EXISTS' : '❌ NOT FOUND'}`);
      }

      if (originalExists) {
        const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucketName, Key: photo.r2KeyOriginal }), { expiresIn: 60 });
        console.log(`  Signed URL: ${url.substring(0, 100)}...`);
      }
    }
  }

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
