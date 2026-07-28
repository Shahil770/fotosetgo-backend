/**
 * cleanup-stuck-photos.ts
 * Run: npx ts-node -P tsconfig.json src/scripts/cleanup-stuck-photos.ts
 *
 * Finds all photos with UPLOADING / PROCESSING / FAILED status and deletes them
 * from both the database and R2 (if applicable).
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const stuckPhotos = await prisma.photo.findMany({
    where: {
      status: { in: ['UPLOADING', 'PROCESSING', 'FAILED'] }
    },
    select: { id: true, eventId: true, status: true, filenameOriginal: true, r2KeyOriginal: true }
  });

  console.log(`Found ${stuckPhotos.length} stuck photo(s):`);
  stuckPhotos.forEach(p => console.log(`  [${p.status}] ${p.id} — ${p.filenameOriginal} (event: ${p.eventId})`));

  if (stuckPhotos.length === 0) {
    console.log('Nothing to clean up.');
    return;
  }

  const ids = stuckPhotos.map(p => p.id);

  // Delete from DB (cascade deletes FaceEmbeddings, FavoritePhotos)
  const result = await prisma.photo.deleteMany({
    where: { id: { in: ids } }
  });

  console.log(`\n✅ Deleted ${result.count} stuck photo record(s) from database.`);
  console.log('Note: R2 files for these were never fully uploaded so no R2 cleanup needed.');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
