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
