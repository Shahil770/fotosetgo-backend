import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const photos = await prisma.photo.findMany({
    where: { eventId: 'b3b14602-ac3c-49af-b4f8-8f3fbe0a2beb' },
    select: { id: true, filenameOriginal: true, status: true, isDeleted: true }
  });
  console.log('Total photos found for event:', photos.length);
  
  const nonReady = photos.filter(p => p.status !== 'READY');
  console.log('Non-ready photos:', nonReady);

  const deleted = photos.filter(p => p.isDeleted);
  console.log('Deleted photos:', deleted);
}

main().finally(() => prisma.$disconnect());
