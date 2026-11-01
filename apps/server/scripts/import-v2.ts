/**
 * Import Real Hand Source v2 into a user's account (server-side; never through the browser).
 * Usage: npx tsx scripts/import-v2.ts <user email> <real-hand-source dir>
 */
import { prisma } from '../src/db';
import { importV2 } from '../src/realhands/import';

const [email, dir] = [process.argv[2], process.argv[3]];
if (!email || !dir) throw new Error('usage: import-v2.ts <email> <dir>');
const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
if (!user) throw new Error(`No user ${email}`);
const t = Date.now();
const s = await importV2(user.id, dir, (m) => console.error(m));
console.log(JSON.stringify({ ...s, seconds: Math.round((Date.now() - t) / 1000) }, null, 2));
await prisma.$disconnect();
