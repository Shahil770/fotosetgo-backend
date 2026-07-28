import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const photographers = await prisma.photographer.findMany({
    include: {
      photos: {
        where: { status: 'READY' }
      }
    }
  });

  for (const p of photographers) {
    const totalSize = p.photos.reduce((sum, photo) => sum + Number(photo.fileSize), 0);
    console.log(`Photographer ${p.id} has ready photos of size: ${totalSize} bytes`);

    await prisma.photographer.update({
      where: { id: p.id },
      data: {
        totalStorageUsedBytes: BigInt(totalSize)
      }
    });

    const activeSub = await prisma.subscription.findFirst({
      where: { photographerId: p.id, status: 'ACTIVE' },
      orderBy: { startsAt: 'desc' }
    });

    if (activeSub) {
      await prisma.subscription.update({
        where: { id: activeSub.id },
        data: {
          usedBytes: BigInt(totalSize)
        }
      });
    }
  }
  console.log('Database storage sync complete!');
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
