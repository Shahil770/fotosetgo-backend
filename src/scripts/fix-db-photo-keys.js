/**
 * fix-db-photo-keys.js
 * DB me stored purani r2KeyOriginal aur r2KeyThumb keys ko
 * naye unified ${photographerId}/ path format me update karta hai.
 * R2 objects pehle hi move ho chuke hain - sirf DB update karna hai.
 */
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

async function main() {
  console.log('===========================================');
  console.log('Fixing DB photo keys to new R2 path format');
  console.log('===========================================\n');

  // Get all photographers with their events
  const photographers = await prisma.photographer.findMany({
    select: { id: true },
  });

  let totalFixed = 0;
  let totalThumbFixed = 0;

  for (const pg of photographers) {
    const photographerId = pg.id;
    console.log(`\nProcessing photographer: ${photographerId}`);

    // Get all events for this photographer
    const events = await prisma.event.findMany({
      where: { photographerId },
      select: { id: true },
    });

    for (const evt of events) {
      const eventId = evt.id;

      // Fix r2KeyOriginal: photographers/${photogId}/... -> ${photogId}/...
      const photosWithOldOriginal = await prisma.photo.findMany({
        where: {
          eventId,
          r2KeyOriginal: { startsWith: `photographers/${photographerId}/` },
        },
        select: { id: true, r2KeyOriginal: true, r2KeyThumb: true },
      });

      for (const photo of photosWithOldOriginal) {
        const newOriginalKey = photo.r2KeyOriginal.replace(
          `photographers/${photographerId}/`,
          `${photographerId}/`
        );

        let newThumbKey = photo.r2KeyThumb;

        // Also fix thumb key: events/${eventId}/thumb/${photoId}.jpg -> ${photogId}/events/${eventId}/thumbs/${photoId}.jpg
        if (photo.r2KeyThumb && photo.r2KeyThumb.startsWith('events/')) {
          const thumbMatch = photo.r2KeyThumb.match(/^events\/([^/]+)\/thumb\/(.+)$/);
          if (thumbMatch) {
            const [, thumbEventId, filename] = thumbMatch;
            newThumbKey = `${photographerId}/events/${thumbEventId}/thumbs/${filename}`;
          }
        }
        // Also fix thumb: photographers/${photogId}/events/.../videos/thumbnails/...
        else if (photo.r2KeyThumb && photo.r2KeyThumb.startsWith(`photographers/${photographerId}/`)) {
          newThumbKey = photo.r2KeyThumb.replace(
            `photographers/${photographerId}/`,
            `${photographerId}/`
          );
        }

        await prisma.photo.update({
          where: { id: photo.id },
          data: {
            r2KeyOriginal: newOriginalKey,
            ...(photo.r2KeyThumb ? { r2KeyThumb: newThumbKey } : {}),
          },
        });

        console.log(`  [FIXED] Photo ${photo.id}`);
        console.log(`    Original: ${photo.r2KeyOriginal}`);
        console.log(`    -> ${newOriginalKey}`);
        if (photo.r2KeyThumb && newThumbKey !== photo.r2KeyThumb) {
          console.log(`    Thumb: ${photo.r2KeyThumb}`);
          console.log(`    -> ${newThumbKey}`);
          totalThumbFixed++;
        }
        totalFixed++;
      }

      // Fix orphan thumb keys (where original is already correct but thumb is old)
      const photosWithOldThumb = await prisma.photo.findMany({
        where: {
          eventId,
          r2KeyOriginal: { startsWith: `${photographerId}/` }, // original already fixed
          r2KeyThumb: { startsWith: 'events/' }, // thumb still old format
        },
        select: { id: true, r2KeyThumb: true },
      });

      for (const photo of photosWithOldThumb) {
        const thumbMatch = photo.r2KeyThumb.match(/^events\/([^/]+)\/thumb\/(.+)$/);
        if (thumbMatch) {
          const [, thumbEventId, filename] = thumbMatch;
          const newThumbKey = `${photographerId}/events/${thumbEventId}/thumbs/${filename}`;
          await prisma.photo.update({
            where: { id: photo.id },
            data: { r2KeyThumb: newThumbKey },
          });
          console.log(`  [THUMB FIXED] Photo ${photo.id}: ${photo.r2KeyThumb} -> ${newThumbKey}`);
          totalThumbFixed++;
        }
      }
    }
  }

  console.log('\n===========================================');
  console.log(`✅ Total originals fixed: ${totalFixed}`);
  console.log(`✅ Total thumbs fixed: ${totalThumbFixed}`);
  console.log('===========================================\n');

  // Verify final state
  console.log('Final verification (3 sample photos):');
  const sample = await prisma.photo.findMany({
    take: 3,
    select: { id: true, r2KeyOriginal: true, r2KeyThumb: true },
  });
  sample.forEach(p => {
    console.log(`  Photo ${p.id}:`);
    console.log(`    r2KeyOriginal: ${p.r2KeyOriginal}`);
    console.log(`    r2KeyThumb:    ${p.r2KeyThumb}`);
  });

  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  prisma.$disconnect();
  process.exit(1);
});
