import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const processingBatches = await prisma.uploadBatch.findMany({
    where: { status: 'PROCESSING' }
  });

  console.log(`Found ${processingBatches.length} processing batches in database.`);

  for (const batch of processingBatches) {
    const totalPhotosCount = await prisma.photo.count({
      where: { eventId: batch.eventId, uploadBatchId: batch.id }
    });

    const readyPhotosCount = await prisma.photo.count({
      where: { eventId: batch.eventId, uploadBatchId: batch.id, status: 'READY' }
    });

    console.log(`Batch ${batch.id}: totalPhotos=${totalPhotosCount}, readyPhotos=${readyPhotosCount}`);

    // If all uploaded/registered files are ready, force complete
    if (readyPhotosCount === totalPhotosCount || totalPhotosCount === 0) {
      await prisma.uploadBatch.update({
        where: { id: batch.id },
        data: {
          status: 'COMPLETED',
          uploadedFiles: totalPhotosCount,
          processedFiles: totalPhotosCount
        }
      });
      console.log(`Force completed batch ${batch.id}! 🎉`);
    }
  }
}

main().finally(() => prisma.$disconnect());
