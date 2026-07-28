import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const event = await prisma.event.findUnique({
    where: { id: 'b3b14602-ac3c-49af-b4f8-8f3fbe0a2beb' },
    select: { photographerId: true }
  });
  if (!event) {
    console.log('Event not found');
    return;
  }
  console.log('Event photographerId:', event.photographerId);

  // Now list all events for this photographerId
  const events = await prisma.event.findMany({
    where: { photographerId: event.photographerId, isDeleted: false },
    include: {
      photos: {
        where: { isDeleted: false }
      }
    }
  });

  const targetEvent = events.find(e => e.id === 'b3b14602-ac3c-49af-b4f8-8f3fbe0a2beb');
  if (!targetEvent) {
    console.log('Target event not found under photographer events');
    return;
  }

  console.log('API representation details:');
  console.log('Photos count:', targetEvent.photos.length);
  
  const statusCounts = targetEvent.photos.reduce((acc, p) => {
    acc[p.status] = (acc[p.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.log('Status Counts:', statusCounts);
}

main().finally(() => prisma.$disconnect());
