import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

/** Recreate the dedicated test database schema. Refuses to run against any DB not named *_test. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://pdl:pdl@localhost:5432/pdl_test';
  const dbName = new URL(url).pathname.replace('/', '');
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to reset non-test database "${dbName}"`);
  const prisma = new PrismaClient({ datasourceUrl: url });
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  await prisma.$disconnect();
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } });
}
