const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const pgs = await prisma.photographer.findMany();
  for (const pg of pgs) {
    console.log(`Photographer: ${pg.id} (${pg.studioName || pg.email})`);
    
    const activePhotos = await prisma.photo.findMany({
      where: { photographerId: pg.id, isDeleted: false },
      select: { id: true, fileSize: true, type: true, eventId: true }
    });

    const deletedPhotos = await prisma.photo.findMany({
      where: { photographerId: pg.id, isDeleted: true },
      select: { id: true, fileSize: true, type: true, eventId: true }
    });

    const activeEvents = await prisma.event.findMany({
      where: { photographerId: pg.id, isDeleted: false }
    });

    const deletedEvents = await prisma.event.findMany({
      where: { photographerId: pg.id, isDeleted: true }
    });

    console.log(`  Active Events: ${activeEvents.length}, Deleted Events: ${deletedEvents.length}`);
    console.log(`  Active Photos/Videos: ${activePhotos.length}, Deleted Photos/Videos: ${deletedPhotos.length}`);
    
    let activeSum = BigInt(0);
    activePhotos.forEach(p => activeSum += p.fileSize || BigInt(0));

    let deletedSum = BigInt(0);
    deletedPhotos.forEach(p => deletedSum += p.fileSize || BigInt(0));

    console.log(`  Active DB Storage: ${(Number(activeSum) / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`  Trash DB Storage: ${(Number(deletedSum) / (1024 * 1024)).toFixed(2)} MB`);
  }
}

main().then(() => prisma.$disconnect());
