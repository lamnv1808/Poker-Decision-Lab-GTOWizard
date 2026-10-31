import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

/** Fresh schema for the dedicated e2e database (refuses any DB not named *_test). */
async function reset() {
  const url = process.env.E2E_DATABASE_URL ?? 'postgresql://pdl:pdl@localhost:5432/pdl_e2e_test';
  if (!new URL(url).pathname.endsWith('_test')) throw new Error('Refusing to reset a non-test database');
  const prisma = new PrismaClient({ datasourceUrl: url });
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  await prisma.$disconnect();
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } });
}

await reset();
