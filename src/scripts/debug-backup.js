const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const photographerId = '16613b26-bef9-4442-a1ad-3ca706f5094a';
  
  const statusBreakdown = await p.photo.groupBy({
    by: ['status', 'type', 'isDeleted'],
    _count: true,
    where: { photographerId },
  });
  
  const backedUp = await p.photo.count({
    where: { photographerId, backedUpToDrive: true }
  });
  
  const r2KeyNulls = await p.photo.count({
    where: { photographerId, r2KeyOriginal: { equals: '' } }
  });

  const photographer = await p.photographer.findUnique({
    where: { id: photographerId },
    select: { autoBackupToDrive: true, googleDriveConnected: true, googleDriveAccessToken: true }
  });
  
  const readyPhotos = await p.photo.findMany({
    where: { photographerId, status: 'READY', isDeleted: false, type: { in: ['IMAGE', 'VIDEO'] } },
    select: { id: true, r2KeyOriginal: true, backedUpToDrive: true, type: true },
    take: 3,
  });
  
  console.log('=== Status Breakdown ===');
  console.log(JSON.stringify(statusBreakdown, null, 2));
  console.log('\n=== Photographer flags:', photographer);
  console.log('=== Backed Up Count:', backedUp);
  console.log('=== Sample READY photos:');
  console.log(JSON.stringify(readyPhotos, null, 2));

}

main().catch(console.error).finally(() => p.$disconnect());
