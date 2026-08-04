const { PrismaClient } = require("./node_modules/@prisma/client");
const p = new PrismaClient({
  datasources: {
    db: {
      url: "postgresql://neondb_owner:npg_yYfS67rwEBjH@ep-tiny-salad-ay6uahqp-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
    }
  }
});
p.photo.findMany({
  where: {
    OR: [
      { status: { not: "READY" } },
      { thumbnailStatus: { not: "READY" } },
      { faceScanStatus: { not: "READY" } }
    ]
  },
  take: 15,
  select: {
    id: true,
    filenameOriginal: true,
    status: true,
    thumbnailStatus: true,
    faceScanStatus: true,
    type: true,
    r2KeyThumb: true
  }
})
.then(console.table)
.catch(console.error)
.finally(() => p.$disconnect());
