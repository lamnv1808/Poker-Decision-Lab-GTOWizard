import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { adminToken } from '../src/admin';
import { prisma } from '../src/db';
import { app, newUser } from './helpers';
import { buildV2Fixture } from './v2fixture';

const jsonl = (f: string) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('admin bundle import', () => {
  it('rejects requests without the derived token', async () => {
    await request(app).get('/api/admin/users').expect(401);
    await request(app).get('/api/admin/users').set('x-admin-token', 'nope').expect(401);
    const u = await newUser('notadmin');
    await u.agent.get('/api/admin/users').expect(401);
  });

  it('uploads a gzip bundle and imports it for the chosen user in the background', async () => {
    const fx = buildV2Fixture();
    const hands = jsonl(join(fx.dir, 'hands.jsonl'));
    const decs = jsonl(join(fx.dir, 'decisions.jsonl'));
    const qs = jsonl(join(fx.dir, 'pot_odds_quizzes.jsonl'));
    const body = gzipSync(hands.map((h) => JSON.stringify({ hand: h, decisions: decs.filter((d) => d.family_id === h.hand_id), quizzes: qs.filter((q) => q.family_id === h.hand_id) })).join('\n'));
    const u = await newUser('bundleowner');
    const tok = adminToken();
    const users = await request(app).get('/api/admin/users').set('x-admin-token', tok).expect(200);
    expect(users.body.some((x: { email: string }) => x.email === u.email)).toBe(true);
    const up = await request(app).put('/api/admin/bundles').set('x-admin-token', tok).set('content-type', 'application/octet-stream').send(body).expect(200);
    const job = await request(app).post('/api/admin/import-v2').set('x-admin-token', tok).send({ bundleId: up.body.bundleId, userId: u.id }).expect(202);
    let st: { status: string; summary?: { hands: { accepted: number }; decisions: { accepted: number; quarantined: number } } } = { status: 'running' };
    for (let i = 0; i < 200 && st.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      st = (await request(app).get(`/api/admin/jobs/${job.body.jobId}`).set('x-admin-token', tok).expect(200)).body;
    }
    expect(st.status).toBe('done');
    expect(st.summary!.hands.accepted).toBe(fx.expected.hands);
    expect(st.summary!.decisions.accepted + st.summary!.decisions.quarantined).toBe(fx.expected.decisions);
    expect(await prisma.realHand.count({ where: { userId: u.id } })).toBe(fx.expected.hands);
    // bundle is deleted after import
    await request(app).post('/api/admin/import-v2').set('x-admin-token', tok).send({ bundleId: up.body.bundleId, userId: u.id }).expect(404);
  });
});
