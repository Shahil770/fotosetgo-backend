const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const prisma = new PrismaClient();

async function main() {
  const p = await prisma.photographer.findFirst({
    where: { id: '9872af5f-0de3-43b0-b208-3c183cb743b3' },
    include: { user: true }
  });

  const token = jwt.sign(
    { sub: p.userId, email: p.user.email, role: p.user.role },
    process.env.JWT_SECRET || 'fotosetgo-super-secret-jwt-key-2025'
  );

  console.log('Testing GET http://localhost:5000/api/storage/breakdown...');
  const res = await fetch('http://localhost:5000/api/storage/breakdown', {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  console.log('Status Code:', res.status);
  if (res.ok) {
    const data = await res.json();
    console.log('Breakdown API Response:', data);
  } else {
    console.log('Error Output:', await res.text());
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
