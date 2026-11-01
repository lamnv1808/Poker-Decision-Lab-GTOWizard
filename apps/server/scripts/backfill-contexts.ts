/**
 * Compute normalized decision contexts for a user's imported real decisions (idempotent).
 * Usage: npx tsx scripts/backfill-contexts.ts <user email>
 */
import { prisma } from '../src/db';
import { backfillContexts } from '../src/realhands/import';

const email = process.argv[2];
if (!email) throw new Error('usage: backfill-contexts.ts <email>');
const user = await prisma.user.findUniqueOrThrow({ where: { email: email.toLowerCase() } });
const t = Date.now();
const r = await backfillContexts(user.id, (m) => console.error(m));
console.log(JSON.stringify({ ...r, seconds: Math.round((Date.now() - t) / 1000) }));
await prisma.$disconnect();
