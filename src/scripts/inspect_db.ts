import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const photos = await prisma.photo.groupBy({
    by: ['status'],
    _count: { id: true }
  });
  console.log('Photo Status Counts:', photos);

  const uploadingPhotos = await prisma.photo.findMany({
    where: { status: { not: 'READY' } },
    select: { id: true, eventId: true, filenameOriginal: true, status: true }
  });
  console.log('Non-Ready Photos:', uploadingPhotos);
}

main().finally(() => prisma.$disconnect());
