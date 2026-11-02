/**
 * Print the data-integrity report (counts, same-owner checks, history fingerprints) as JSON.
 * Usage: DATABASE_URL=<db> npx tsx scripts/integrity-report.ts [out.json]
 */
import { writeFileSync } from 'node:fs';
import { prisma } from '../src/db';
import { integrityReport } from '../src/integrity';

const r = await integrityReport();
const out = JSON.stringify(r, null, 2);
if (process.argv[2]) writeFileSync(process.argv[2], out);
console.log(JSON.stringify({ ok: r.ok, failed: r.failed, checks: r.checks, fingerprints: r.fingerprints }, null, 1));
console.log(r.users.map((u) => `${u.id} ${u.email.replace(/^[^@]{3}/, '***')} hands=${u.hands} decisions=${u.decisions} attempts=${u.attempts}`).join('\n'));
await prisma.$disconnect();
