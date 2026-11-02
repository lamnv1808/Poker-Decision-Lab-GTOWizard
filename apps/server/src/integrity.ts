import type { Prisma } from '@prisma/client';
import { tableChecksum, tablesInOrder } from './backup';
import { prisma } from './db';

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Data-integrity report (release gates). Foreign keys are enforced by Postgres; these checks cover
 * what FKs cannot: that linked rows belong to the SAME user, and that imported hand text is unchanged.
 * Every check is a count of violating rows — 0 is a pass.
 */
const OWNERSHIP_CHECKS: Record<string, string> = {
  decisionHandOwner: `SELECT count(*) AS n FROM "RealDecision" d JOIN "RealHand" h ON h.id = d."realHandId" WHERE h."userId" <> d."userId"`,
  annotationDecisionOwner: `SELECT count(*) AS n FROM "Annotation" a JOIN "RealDecision" d ON d.id = a."decisionId" WHERE a."userId" <> d."userId"`,
  attemptSessionOwner: `SELECT count(*) AS n FROM "DecisionAttempt" a JOIN "TrainingSession" s ON s.id = a."sessionId" WHERE s."userId" <> a."userId"`,
  ratingHistoryAttemptOwner: `SELECT count(*) AS n FROM "RatingHistory" r JOIN "DecisionAttempt" a ON a.id = r."attemptId" WHERE a."userId" <> r."userId"`,
  leakObservationAttemptOwner: `SELECT count(*) AS n FROM "LeakObservation" o JOIN "DecisionAttempt" a ON a.id = o."attemptId" WHERE a."userId" <> o."userId"`,
  simHandSessionOwner: `SELECT count(*) AS n FROM "SimHand" h JOIN "TrainingSession" s ON s.id = h."sessionId" WHERE s."userId" <> h."userId"`,
  runSessionOwner: `SELECT count(*) AS n FROM "ScenarioRun" r JOIN "TrainingSession" s ON s.id = r."sessionId" WHERE s."userId" <> r."userId"`,
};
const PHASE1_CHECKS: Record<string, string> = {
  // LeakMemory examples must be the same user's decisions
  leakExampleOwner: `SELECT count(*) AS n FROM "LeakMemory" m, unnest(m.examples) e(id) JOIN "RealDecision" d ON d.id = e.id WHERE d."userId" <> m."userId"`,
};

async function hasTable(db: Db, t: string) {
  return (await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'public' AND c.relname = $1`, t))[0]!.n > 0n;
}

export async function integrityReport(db: Db = prisma) {
  const tables = await tablesInOrder(db);
  const counts: Record<string, number> = {};
  for (const t of tables) counts[t] = Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${t}"`))[0]!.n);
  const checks: Record<string, number> = {};
  for (const [k, q] of Object.entries(OWNERSHIP_CHECKS)) checks[k] = Number((await db.$queryRawUnsafe<{ n: bigint }[]>(q))[0]!.n);
  if (await hasTable(db, 'LeakMemory')) for (const [k, q] of Object.entries(PHASE1_CHECKS)) checks[k] = Number((await db.$queryRawUnsafe<{ n: bigint }[]>(q))[0]!.n);
  // fingerprints of imported history: must be identical before and after any migration
  const fp = async (sql: string) => (await db.$queryRawUnsafe<{ h: string | null }[]>(sql))[0]!.h ?? '';
  const fingerprints = {
    realHandRaw: await fp(`SELECT md5(coalesce(string_agg(md5(id || ':' || raw), '' ORDER BY id), '')) AS h FROM "RealHand"`),
    realDecisionCore: await fp(`SELECT md5(coalesce(string_agg(md5(id || ':' || "userId" || ':' || "realHandId" || ':' || "heroActionNo" || ':' || status), '' ORDER BY id), '')) AS h FROM "RealDecision"`),
    annotations: (await tableChecksum('Annotation', db)).md5,
    users: await fp(`SELECT md5(coalesce(string_agg(md5(id || ':' || email || ':' || "passwordHash"), '' ORDER BY id), '')) AS h FROM "User"`),
    attempts: (await tableChecksum('DecisionAttempt', db)).md5,
    ratingHistory: (await tableChecksum('RatingHistory', db)).md5,
  };
  const perUser = await db.$queryRawUnsafe<{ id: string; email: string; hands: bigint; decisions: bigint; attempts: bigint }[]>(
    `SELECT u.id, u.email, (SELECT count(*) FROM "RealHand" h WHERE h."userId" = u.id) AS hands, (SELECT count(*) FROM "RealDecision" d WHERE d."userId" = u.id) AS decisions, (SELECT count(*) FROM "DecisionAttempt" a WHERE a."userId" = u.id) AS attempts FROM "User" u ORDER BY u."createdAt"`,
  );
  const failed = Object.entries(checks).filter(([, n]) => n > 0).map(([k]) => k);
  return {
    ok: failed.length === 0,
    failed,
    counts,
    checks,
    fingerprints,
    users: perUser.map((u) => ({ id: u.id, email: u.email, hands: Number(u.hands), decisions: Number(u.decisions), attempts: Number(u.attempts) })),
  };
}
