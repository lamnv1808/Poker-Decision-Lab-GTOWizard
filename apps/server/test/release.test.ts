import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { adminToken, canonicalJson, manifestHash } from '../src/admin';
import { prisma } from '../src/db';
import { setBackupEndpoint } from '../src/env';
import { app, cid, newUser } from './helpers';

const admin = () => adminToken();

describe('release safety: backup endpoint, integrity report, test-account removal', () => {
  it('the backup header records the schema version (applied migrations)', async () => {
    const r = await request(app).get('/api/admin/backup').set('x-admin-token', admin()).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    const header = JSON.parse(gunzipSync(r.body as Buffer).toString('utf8').split('\n')[0]!);
    expect(header.migrations.length).toBeGreaterThan(10);
    expect(header.migrations).toContain('20261101222655_leak_memory');
  });

  it('the backup download can be switched off (the production default)', async () => {
    setBackupEndpoint(false);
    try {
      const r = await request(app).get('/api/admin/backup').set('x-admin-token', admin()).expect(404);
      expect(r.body.error).toBe('backup_endpoint_off');
    } finally {
      setBackupEndpoint(true);
    }
  });

  it('integrity report: admin only, no ownership violations', async () => {
    await request(app).get('/api/admin/integrity').expect(401);
    const r = (await request(app).get('/api/admin/integrity').set('x-admin-token', admin()).expect(200)).body;
    expect(r.ok).toBe(true);
    expect(Object.values(r.checks).every((n) => n === 0)).toBe(true);
    expect(r.fingerprints.realHandRaw).toMatch(/^[0-9a-f]{32}$/);
  });

  it('deletes only exact, verified test accounts, after a dry-run manifest, in one transaction', async () => {
    const keep = await newUser('keepme');
    const t1 = await newUser('gone1');
    const t2 = await newUser('gone2');
    // give the test accounts some data
    const quiz = (await t1.agent.get('/api/math/quiz?level=1').expect(200)).body;
    await t1.agent.post('/api/math/quiz/answer').send({ token: quiz.token, value: 1, clientAttemptId: cid() }).expect(200);
    await t2.agent.post('/api/mixed/sessions').send({ focus: ['math'] }).expect(201);
    const real = await prisma.user.create({ data: { email: `someone-${Date.now()}@example.com`, passwordHash: 'x', displayName: 'real' } });
    const post = (body: object) => request(app).post('/api/admin/accounts/delete').set('x-admin-token', admin()).send(body);
    await request(app).post('/api/admin/accounts/delete').send({ ids: [t1.id] }).expect(401);

    // refuses a non-test account and unknown ids (nothing deleted)
    const bad = await post({ ids: [t1.id, real.id, 'nope'] }).expect(409);
    expect(bad.body.problems.join(' ')).toMatch(/not a @test.dev account/);
    expect(bad.body.problems.join(' ')).toMatch(/nope: not found/);

    // dry run → manifest
    const dry = (await post({ ids: [t1.id, t2.id] }).expect(200)).body;
    expect(dry.dryRun).toBe(true);
    expect(dry.hash).toBe(manifestHash(dry.manifest));
    expect(dry.hashAlgorithm).toMatch(/pdl-manifest-v2/);
    expect(dry.manifest.accounts.map((a: { id: string }) => a.id).sort()).toEqual([t1.id, t2.id].sort());
    expect(dry.manifest.rows.DecisionAttempt).toBeGreaterThanOrEqual(1);
    expect(dry.manifest.rows.TrainingSession).toBeGreaterThanOrEqual(1);
    // a stale hash is refused
    await post({ ids: [t1.id, t2.id], confirmHash: '0'.repeat(64) }).expect(409);
    const done = (await post({ ids: [t1.id, t2.id], confirmHash: dry.hash }).expect(200)).body;
    expect(done.deleted).toBe(true);
    expect(done.after.ok).toBe(true);
    expect(await prisma.user.count({ where: { id: { in: [t1.id, t2.id] } } })).toBe(0);
    expect(await prisma.decisionAttempt.count({ where: { userId: t1.id } })).toBe(0);
    // everyone else is untouched and can still log in
    expect(await prisma.user.count({ where: { id: { in: [keep.id, real.id] } } })).toBe(2);
    await keep.agent.get('/api/auth/me').expect(200);
    expect(done.before.fingerprints.realHandRaw).toBe(done.after.fingerprints.realHandRaw);
  });

  it('manifest hash is canonical: independent of key order, reproducible outside the app', () => {
    // the production dry run lists tables in foreign-key creation order, which differs between a database
    // built by migrations and one restored by pg_restore; the hash must not depend on it
    const accounts = [{ id: 'a1', email: 'x@test.dev', createdAt: '2026-11-01T00:00:00.000Z' }];
    const a = { accounts, rows: { Session: 2, Annotation: 0, DecisionAttempt: 5 }, external: {} };
    const b = { external: {}, rows: { DecisionAttempt: 5, Session: 2, Annotation: 0 }, accounts: [{ createdAt: '2026-11-01T00:00:00.000Z', email: 'x@test.dev', id: 'a1' }] };
    expect(manifestHash(a)).toBe(manifestHash(b));
    expect(canonicalJson(b)).toBe('{"accounts":[{"createdAt":"2026-11-01T00:00:00.000Z","email":"x@test.dev","id":"a1"}],"external":{},"rows":{"Annotation":0,"DecisionAttempt":5,"Session":2}}');
    // same as Python: hashlib.sha256(json.dumps(m, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode())
    expect(manifestHash(b)).toBe(createHash('sha256').update(canonicalJson(a)).digest('hex'));
    expect(manifestHash({ rows: { b: 1, a: 2 } })).toBe(createHash('sha256').update('{"rows":{"a":2,"b":1}}').digest('hex'));
  });

  it('revalidates inside the deletion transaction, counts cascaded rows, revokes sessions, rolls back on mismatch', async () => {
    const t = await newUser('gone3');
    const keep = await newUser('stays3');
    const mem = await prisma.leakMemory.create({ data: { userId: t.id, leakKey: 'training:potOdds', source: 'training', evidence: 'training', category: 'math', label: { en: 'x', vi: 'x' }, drill: 'math', status: 'active', severity: 0.5, confidence: 'low', n: 3 } });
    await prisma.leakSnapshot.create({ data: { memoryId: mem.id, status: 'active', n: 3, severity: 0.5 } });
    await t.agent.get('/api/auth/me').expect(200);
    const post = (body: object) => request(app).post('/api/admin/accounts/delete').set('x-admin-token', admin()).send(body);
    const dry = (await post({ ids: [t.id] }).expect(200)).body;
    // rows without userId that Postgres removes by cascade are part of the manifest (and the hash)
    expect(dry.manifest.cascade.LeakSnapshot).toBe(1);
    expect(dry.manifest.rows.LeakMemory).toBe(1);
    expect(dry.manifest.rows.Session).toBeGreaterThanOrEqual(1);

    // the transaction itself refuses a stale hash even if the caller skips the endpoint's pre-check
    const { deleteTestAccounts, DeletionAborted } = await import('../src/accountCleanup');
    await prisma.leakSnapshot.create({ data: { memoryId: mem.id, status: 'active', n: 4, severity: 0.5 } });
    await expect(deleteTestAccounts([t.id], dry.hash)).rejects.toBeInstanceOf(DeletionAborted);
    expect(await prisma.user.count({ where: { id: t.id } })).toBe(1);
    expect(await prisma.leakSnapshot.count({ where: { memoryId: mem.id } })).toBe(2); // nothing was deleted

    // with the fresh hash: everything goes, cascades verified, sessions revoked, cookie no longer works
    const fresh = (await post({ ids: [t.id] }).expect(200)).body;
    expect(fresh.manifest.cascade.LeakSnapshot).toBe(2);
    const done = (await post({ ids: [t.id], confirmHash: fresh.hash }).expect(200)).body;
    expect(done.deletedRows.LeakSnapshot).toBe(2);
    expect(done.deletedRows.User).toBe(1);
    expect(done.remainingSessions).toBe(0);
    await t.agent.get('/api/auth/me').expect(401);
    await keep.agent.get('/api/auth/me').expect(200);
    expect(done.after.ok).toBe(true);
  });

  it('a row-count surprise inside the transaction rolls everything back', async () => {
    const t = await newUser('gone4');
    const { deleteTestAccounts, dryRunTestAccounts, DeletionAborted } = await import('../src/accountCleanup');
    const dry = await dryRunTestAccounts([t.id]);
    // simulate a concurrent writer between the dry run and the deletion: the transaction must notice
    await prisma.session.create({ data: { userId: t.id, tokenHash: `extra-${Date.now()}`, expiresAt: new Date(Date.now() + 3600_000) } });
    await expect(deleteTestAccounts([t.id], dry.hash)).rejects.toBeInstanceOf(DeletionAborted);
    expect(await prisma.user.count({ where: { id: t.id } })).toBe(1);
    expect(await prisma.session.count({ where: { userId: t.id } })).toBeGreaterThanOrEqual(2);
  });

  it('the dry run is read-only at the database level', async () => {
    const t = await newUser('ro');
    const { dryRunTestAccounts } = await import('../src/accountCleanup');
    const before = await prisma.session.count({ where: { userId: t.id } });
    const r = await dryRunTestAccounts([t.id]);
    expect(r.problems).toEqual([]);
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe(`DELETE FROM "Session" WHERE "userId" = $1`, t.id);
    })).rejects.toThrow(/read-only/);
    expect(await prisma.session.count({ where: { userId: t.id } })).toBe(before);
  });

  it("refuses when other users' data refers to the account", async () => {
    const t = await newUser('referenced');
    const other = await newUser('other');
    await prisma.inviteCode.create({ data: { codeHash: `h-${Date.now()}`, createdById: t.id, usedById: other.id, usedAt: new Date(), expiresAt: new Date(Date.now() + 86400000) } });
    const r = await request(app).post('/api/admin/accounts/delete').set('x-admin-token', admin()).send({ ids: [t.id] }).expect(409);
    expect(JSON.stringify(r.body.manifest.external)).toMatch(/InviteCode.createdById/);
    expect(await prisma.user.count({ where: { id: t.id } })).toBe(1);
  });
});
