import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from './db';
import { backupEndpointOn, env } from './env';
import { type ImportSummary, bundleSource, importV2 } from './realhands/import';
import { streamBackup } from './backup';
import { integrityReport } from './integrity';
import { DeletionAborted, deleteTestAccounts, dryRunTestAccounts } from './accountCleanup';

/**
 * Operator-only endpoints (bulk import of a user's hand-history bundle when the database is not
 * reachable from outside). Authenticated by a token derived from APP_SECRET, so only someone who
 * already holds the server secret can call them. There is no UI for these.
 */
export const adminToken = (secret = env.APP_SECRET) => createHmac('sha256', secret).update('pdl-admin-v1').digest('hex');

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const got = Buffer.from(req.get('x-admin-token') ?? '');
  const want = Buffer.from(adminToken());
  if (got.length !== want.length || !timingSafeEqual(got, want)) return void res.status(401).json({ error: 'unauthorized' });
  next();
}

const MAX_BUNDLE = 200 * 1024 * 1024;
const dir = join(tmpdir(), 'pdl-bundles');
interface Job { id: string; status: 'running' | 'done' | 'failed'; startedAt: string; finishedAt?: string; log: string[]; summary?: ImportSummary; error?: string }
const jobs = new Map<string, Job>();

export const adminRouter = Router();
adminRouter.use(requireAdmin);

adminRouter.get('/users', async (_req, res) => {
  const users = await prisma.user.findMany({ select: { id: true, email: true, createdAt: true, _count: { select: { realHands: true } } }, orderBy: { createdAt: 'asc' } });
  res.json(users.map((u) => ({ id: u.id, email: u.email, createdAt: u.createdAt, realHands: u._count.realHands })));
});

/** Streams a gzip JSONL bundle (see scripts/build-bundle.ts) to temporary disk. */
adminRouter.put('/bundles', async (req, res) => {
  if (Number(req.get('content-length') ?? 0) > MAX_BUNDLE) return void res.status(413).json({ error: 'too_large' });
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const file = join(dir, `${id}.jsonl.gz`);
  let bytes = 0;
  req.on('data', (c: Buffer) => {
    bytes += c.length;
    if (bytes > MAX_BUNDLE) req.destroy(new Error('too_large'));
  });
  try {
    await pipeline(req, createWriteStream(file));
  } catch {
    if (existsSync(file)) unlinkSync(file);
    return void res.status(400).json({ error: 'upload_failed' });
  }
  res.json({ bundleId: id, bytes });
});

const ImportBody = z.object({ bundleId: z.string().uuid(), userId: z.string().min(1), batch: z.number().int().min(10).max(500).default(100), pauseMs: z.number().int().min(0).max(5000).default(150), retries: z.number().int().min(0).max(20).default(5) });
adminRouter.post('/import-v2', async (req, res) => {
  const body = ImportBody.parse(req.body);
  const file = join(dir, `${body.bundleId}.jsonl.gz`);
  if (!existsSync(file)) return void res.status(404).json({ error: 'bundle_not_found' });
  const user = await prisma.user.findUnique({ where: { id: body.userId } });
  if (!user) return void res.status(404).json({ error: 'user_not_found' });
  const job: Job = { id: randomUUID(), status: 'running', startedAt: new Date().toISOString(), log: [] };
  jobs.set(job.id, job);
  // A small database may restart under sustained writes; the import resumes safely, so retry after a pause.
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await importV2(user.id, bundleSource(file), (m) => job.log.push(m), { batch: body.batch, pauseMs: body.pauseMs, skipComplete: true });
      } catch (e) {
        if (attempt >= body.retries) throw e;
        job.log.push(`attempt ${attempt + 1} failed (${e instanceof Error ? e.message.trim().split('\n').pop() : String(e)}); retrying in 60 s`);
        await new Promise((r) => setTimeout(r, 60_000));
      }
    }
  };
  void run()
    .then((s) => Object.assign(job, { status: 'done', summary: s }))
    .catch((e: unknown) => Object.assign(job, { status: 'failed', error: e instanceof Error ? e.message : String(e) }))
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      if (existsSync(file)) unlinkSync(file);
    });
  res.status(202).json({ jobId: job.id });
});

adminRouter.get('/jobs/:id', (req, res) => {
  const job = jobs.get(String(req.params.id));
  if (!job) return void res.status(404).json({ error: 'not_found' });
  res.json(job);
});

/** Row counts for one user's imported real-hand data (verification after an import). */
adminRouter.get('/users/:id/real-stats', async (req, res) => {
  const userId = String(req.params.id);
  const [hands, decisions, annotations, quizzes] = await Promise.all([
    prisma.realHand.groupBy({ by: ['status'], where: { userId }, _count: true }),
    prisma.realDecision.groupBy({ by: ['status', 'split'], where: { userId }, _count: true }),
    prisma.annotation.groupBy({ by: ['status', 'source'], where: { userId }, _count: true }),
    prisma.$queryRaw<{ status: string; n: bigint }[]>`SELECT "potOdds"->>'status' AS status, COUNT(*) AS n FROM "RealDecision" WHERE "userId" = ${userId} AND "potOdds" IS NOT NULL GROUP BY 1`,
  ]);
  res.json({ hands, decisions, annotations, quizzes: quizzes.map((q) => ({ status: q.status, n: Number(q.n) })) });
});

/**
 * Full logical backup (read-only), streamed as gzip NDJSON with a Postgres-computed checksum
 * manifest. The free database plan has no backups/exports, so this is the safety net.
 */
adminRouter.get('/backup', async (_req, res) => {
  if (!backupEndpointOn) return void res.status(404).json({ error: 'backup_endpoint_off', message: 'Set BACKUP_ENDPOINT=on for a break-glass backup (see docs/BACKUP.md)' });
  await streamBackup(res);
});

/** Data-integrity report: counts, same-owner checks, fingerprints of imported history. */
adminRouter.get('/integrity', async (_req, res) => {
  res.json(await integrityReport());
});

/**
 * Remove generated test accounts. Two steps: a dry run returns a manifest (every row that would be
 * deleted, per table) and its hash; the deletion must send that hash back and is refused if
 * anything changed. Only exact ids are accepted, only @test.dev accounts, never an owner, never an
 * account other users' data refers to. Runs in one transaction.
 */
export { canonicalJson, manifestHash, MANIFEST_HASH_ALGORITHM } from './accountCleanup';

adminRouter.post('/accounts/delete', async (req, res) => {
  const body = z.object({ ids: z.array(z.string().min(1)).min(1).max(50), confirmHash: z.string().length(64).optional() }).parse(req.body);
  const m = await dryRunTestAccounts(body.ids);
  if (m.problems.length) return void res.status(409).json({ deleted: false, ...m });
  if (!body.confirmHash) return void res.json({ dryRun: true, ...m });
  if (body.confirmHash !== m.hash) return void res.status(409).json({ deleted: false, error: 'manifest_changed', ...m });
  try {
    res.json(await deleteTestAccounts(body.ids, body.confirmHash));
  } catch (e) {
    if (e instanceof DeletionAborted) return void res.status(409).json({ deleted: false, error: e.message, detail: e.detail });
    throw e;
  }
});
