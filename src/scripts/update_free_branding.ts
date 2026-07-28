import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  await prisma.package.update({
    where: { name: 'Free' },
    data: {
      featureCustomBranding: false,
      featureWatermark: false,
      featureGuestUpload: false
    }
  });

  await prisma.package.updateMany({
    where: { name: { in: ['Hobby', 'Creator', 'Studio'] } },
    data: {
      featureWatermark: true
    }
  });
  console.log('Successfully updated featureWatermark configurations in Neon Database.');
}

main()
  .catch(err => {
    console.error(err);
  })
  .finally(() => prisma.$disconnect());
