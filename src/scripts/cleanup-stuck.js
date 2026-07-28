const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const stuckPhotos = await prisma.photo.findMany({
    where: {
      status: { in: ['UPLOADING', 'PROCESSING', 'FAILED'] }
    },
    select: { id: true, eventId: true, status: true, filenameOriginal: true }
  });

  console.log(`Found ${stuckPhotos.length} stuck photo(s):`);
  stuckPhotos.forEach(p => console.log(`  [${p.status}] ${p.id} -- ${p.filenameOriginal} (event: ${p.eventId})`));

  if (stuckPhotos.length === 0) {
    console.log('Nothing to clean up.');
    return;
  }

  const ids = stuckPhotos.map(p => p.id);
  const result = await prisma.photo.deleteMany({
    where: { id: { in: ids } }
  });

  console.log(`Deleted ${result.count} stuck photo record(s) from database.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
