import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { ownerEmails, setRegistrationMode } from '../src/env';
import { resetRateLimits } from '../src/auth';
import { app } from './helpers';

const reg = (email: string, inviteCode?: string) => request(app).post('/api/auth/register').send({ email, password: 'correct horse battery', displayName: 'X', inviteCode });

describe('invite-only registration (private lab)', () => {
  const owner = `owner-${Date.now()}@test.dev`;
  beforeAll(() => {
    setRegistrationMode('invite');
    ownerEmails.add(owner);
    resetRateLimits();
  });
  afterAll(() => {
    setRegistrationMode('open');
    ownerEmails.delete(owner);
  });

  it('refuses sign-up without a valid invite, accepts a single-use code once', async () => {
    expect((await request(app).get('/api/auth/config').expect(200)).body.registration).toBe('invite');
    await reg(`stranger-${Date.now()}@test.dev`).expect(403);
    await reg(`stranger2-${Date.now()}@test.dev`, 'NOTACODE12').expect(403);
    // the owner can always register and then issue codes
    const agent = request.agent(app);
    await agent.post('/api/auth/register').send({ email: owner, password: 'correct horse battery', displayName: 'Owner' }).expect(201);
    expect((await agent.get('/api/auth/me').expect(200)).body.isOwner).toBe(true);
    const inv = (await agent.post('/api/invites').send({ note: 'Minh' }).expect(201)).body;
    expect(inv.code).toMatch(/^[A-Z2-9]{10}$/);
    const friend = `friend-${Date.now()}@test.dev`;
    await reg(friend, inv.code.toLowerCase()).expect(201); // case-insensitive
    await reg(`friend2-${Date.now()}@test.dev`, inv.code).expect(403); // single use
    const list = (await agent.get('/api/invites').expect(200)).body;
    expect(list[0].status).toBe('used');
    // only a hash is stored
    expect(JSON.stringify(await prisma.inviteCode.findMany())).not.toContain(inv.code);
    // a failed sign-up leaves no half-created account
    expect(await prisma.user.count({ where: { email: { startsWith: 'friend2-' } } })).toBe(0);
  });

  it('expired codes are refused and only the owner can create invites', async () => {
    const agent = request.agent(app);
    const ownerRow = await prisma.user.findUniqueOrThrow({ where: { email: owner } });
    const inv = await prisma.inviteCode.create({ data: { codeHash: (await import('../src/auth')).inviteHash('OLDCODE234'), createdById: ownerRow.id, expiresAt: new Date(Date.now() - 1000) } });
    await reg(`late-${Date.now()}@test.dev`, 'OLDCODE234').expect(403);
    await prisma.inviteCode.delete({ where: { id: inv.id } });
    const fresh = (await request.agent(app).post('/api/auth/login').send({ email: owner, password: 'correct horse battery' })).status;
    expect(fresh).toBe(200);
    // a non-owner (registered while open) cannot issue invites
    setRegistrationMode('open');
    await agent.post('/api/auth/register').send({ email: `plain-${Date.now()}@test.dev`, password: 'correct horse battery', displayName: 'P' }).expect(201);
    await agent.post('/api/invites').send({}).expect(403);
    setRegistrationMode('invite');
  });
});
