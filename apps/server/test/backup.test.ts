import { gunzipSync } from 'node:zlib';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { adminToken } from '../src/admin';
import { tableChecksum, tablesInOrder } from '../src/backup';
import { prisma } from '../src/db';
import { app, ensureSeeded, newUser } from './helpers';

describe('admin backup (free database plan has no backups)', () => {
  it('requires the admin token', async () => {
    await request(app).get('/api/admin/backup').expect(401);
    const u = await newUser('bk0');
    await u.agent.get('/api/admin/backup').expect(401);
  });

  it('orders tables parents-before-children', async () => {
    const order = await tablesInOrder();
    const pos = (t: string) => order.indexOf(t);
    expect(pos('User')).toBeLessThan(pos('RealHand'));
    expect(pos('RealHand')).toBeLessThan(pos('RealDecision'));
    expect(pos('RealDecision')).toBeLessThan(pos('Annotation'));
    expect(pos('DecisionAttempt')).toBeLessThan(pos('RatingHistory'));
    expect(order).not.toContain('_prisma_migrations');
  });

  it('streams every row with a manifest that matches the database', async () => {
    await ensureSeeded();
    await newUser('bk1');
    const r = await request(app).get('/api/admin/backup').set('x-admin-token', adminToken()).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    const lines = gunzipSync(r.body as Buffer).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    const header = lines[0];
    const manifest = lines[lines.length - 1];
    expect(header.kind).toBe('header');
    expect(manifest.kind).toBe('manifest');
    const counts: Record<string, number> = {};
    for (const l of lines.slice(1, -1)) counts[l.t] = (counts[l.t] ?? 0) + 1;
    for (const t of ['User', 'Scenario', 'Session']) {
      expect(counts[t] ?? 0).toBe(manifest.tables[t].rows);
      expect(manifest.tables[t].rows).toBe((await tableChecksum(t)).rows);
    }
    // credentials are hashed, never plaintext
    expect(JSON.stringify(lines)).not.toMatch(/correct horse battery/);
    expect(await prisma.user.count()).toBeGreaterThan(0);
  });
});

describe('backup is a consistent snapshot (production finding)', () => {
  it('rows committed while the backup runs are excluded everywhere, so no reference dangles', async () => {
    const { PassThrough } = await import('node:stream');
    const { streamBackup } = await import('../src/backup');
    const { recordAttempt } = await import('../src/learning');
    const { cid } = await import('./helpers');
    const u = await newUser('snap');
    const sink = Object.assign(new PassThrough(), { setHeader: () => {} });
    const chunks: Buffer[] = [];
    sink.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise((ok) => sink.on('end', ok));
    let lateAttemptId = '';
    await streamBackup(sink as never, {
      afterTable: async (t) => {
        if (t !== 'DecisionAttempt') return;
        // a user answers a rated solver question in the middle of the backup (separate connection, committed)
        const r = await recordAttempt({ userId: u.id, clientAttemptId: cid(), attemptType: 'quiz', itemRef: 'gto:snap', reviewType: 'quiz', reviewRef: 'gto', mode: 'rated', action: {}, graded: true, grade: 'excellent', gradeBasis: 'solverEv', ratingEligible: true, isError: false, gradingMethodVersion: 't', difficulty: 3, skills: ['preflop'], concepts: [], leakOpportunities: [], optionLeaks: [], sourceClass: 'SOLVER_VERIFIED', track: 'strategy', result: {} });
        lateAttemptId = r.attemptId;
        expect(await prisma.ratingHistory.count({ where: { attemptId: r.attemptId } })).toBeGreaterThan(0);
      },
    });
    await done;
    const lines = gunzipSync(Buffer.concat(chunks)).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    const attempts = new Set(lines.filter((l) => l.t === 'DecisionAttempt').map((l) => l.r.id));
    const history = lines.filter((l) => l.t === 'RatingHistory').map((l) => l.r);
    expect(lateAttemptId).not.toBe('');
    expect(attempts.has(lateAttemptId)).toBe(false);
    expect(history.some((h) => h.attemptId === lateAttemptId)).toBe(false);
    for (const h of history) expect(attempts.has(h.attemptId)).toBe(true);
    expect(lines[0].snapshot).toBe('repeatable-read');
  });
});
