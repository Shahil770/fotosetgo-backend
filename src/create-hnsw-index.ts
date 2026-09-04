import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const prisma = new PrismaClient();

async function main() {
  console.log('[HNSW Index] Connecting to PostgreSQL database...');
  try {
    // 1. Ensure pgvector extension is enabled
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector;`);
    console.log('[HNSW Index] pgvector extension verified.');

    // 2. Create HNSW index on face_embeddings table
    console.log('[HNSW Index] Creating HNSW vector index on face_embeddings(embedding vector_cosine_ops)...');
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_face_embeddings_hnsw 
      ON face_embeddings 
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
    `);
    console.log('[HNSW Index] Successfully created HNSW index: idx_face_embeddings_hnsw!');

    // 3. Create composite index on eventId and photoId if not exists
    console.log('[HNSW Index] Creating composite index on (eventId, photoId)...');
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_face_embeddings_event_photo
      ON face_embeddings ("eventId", "photoId");
    `);
    console.log('[HNSW Index] Successfully created composite index: idx_face_embeddings_event_photo!');

    console.log('[HNSW Index] All database indexing completed with 100% success.');
  } catch (err: any) {
    console.error('[HNSW Index] Error creating database indexes:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
