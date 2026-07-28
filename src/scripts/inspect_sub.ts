import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const event = await prisma.event.findFirst({
    where: { id: 'b3b14602-ac3c-49af-b4f8-8f3fbe0a2beb' },
    include: {
      photos: {
        where: { isDeleted: false }
      }
    }
  });

  if (!event) {
    console.log('Event not found');
    return;
  }

  console.log('API representation details:');
  console.log('Photos count:', event.photos.length);
  const statuses = event.photos.map(p => p.status);
  const counts: Record<string, number> = {};
  statuses.forEach(s => { counts[s] = (counts[s] || 0) + 1; });
  console.log('Photo statuses in API query:', counts);
}

main().finally(() => prisma.$disconnect());
