import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const batches = await prisma.uploadBatch.findMany({
    select: { id: true, eventId: true, totalFiles: true, uploadedFiles: true, processedFiles: true, failedFiles: true, status: true }
  });
  console.log('Upload Batches:', batches);
}

main().finally(() => prisma.$disconnect());
