/**
 * Refresh one user's leak memory and print today's plan (read-mostly: writes only LeakMemory rows).
 * Usage: DATABASE_URL=<db> npx tsx scripts/leak-memory.ts <email> [minutes]
 */
import { prisma } from '../src/db';
import { dailyPlan } from '../src/daily';
import { listMemory, refreshLeakMemory } from '../src/leakMemory';

const [email, min = '10'] = process.argv.slice(2);
const u = await prisma.user.findUniqueOrThrow({ where: { email: email! } });
let t = Date.now();
console.log('refresh', await refreshLeakMemory(u.id), `${Date.now() - t} ms`);
const m = await listMemory(u.id);
for (const l of m.leaks) console.log(l.status.padEnd(9), l.evidence.padEnd(8), l.leakKey.padEnd(32), `sev ${l.severity.toFixed(2)}`, l.confidence, `n ${l.n}`, l.rate !== null ? `rate ${(l.rate * 100).toFixed(1)}%` : '', `recent n ${l.recentN} ${l.recentRate !== null ? (l.recentRate * 100).toFixed(1) + '%' : ''} ${l.recentVerdict ?? ''}`);
t = Date.now();
const p = await dailyPlan(u.id, Number(min) as 5 | 10 | 20);
console.log(`plan ${p.minutes} min: ${p.items.length} items, ~${Math.round(p.estimatedSec / 60)} min, ${Date.now() - t} ms`);
for (const f of p.focus) console.log(' focus', f.leakKey, JSON.stringify(f.priority), `${f.items} items`);
console.log(' items', p.items.map((i) => `${i.type}${i.reason === 'leak' ? '*' : i.reason === 'review' ? '(r)' : '(n)'}`).join(' '));
await prisma.$disconnect();
