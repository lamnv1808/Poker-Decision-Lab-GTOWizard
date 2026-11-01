import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from './db';
import { env } from './env';
import { type ImportSummary, bundleSource, importV2 } from './realhands/import';

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

const ImportBody = z.object({ bundleId: z.string().uuid(), userId: z.string().min(1) });
adminRouter.post('/import-v2', async (req, res) => {
  const body = ImportBody.parse(req.body);
  const file = join(dir, `${body.bundleId}.jsonl.gz`);
  if (!existsSync(file)) return void res.status(404).json({ error: 'bundle_not_found' });
  const user = await prisma.user.findUnique({ where: { id: body.userId } });
  if (!user) return void res.status(404).json({ error: 'user_not_found' });
  const job: Job = { id: randomUUID(), status: 'running', startedAt: new Date().toISOString(), log: [] };
  jobs.set(job.id, job);
  void importV2(user.id, bundleSource(file), (m) => job.log.push(m))
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
