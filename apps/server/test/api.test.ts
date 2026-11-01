import { readFileSync } from 'node:fs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { app, cid, ensureSeeded, newUser } from './helpers';
import { resetRateLimits } from '../src/auth';

beforeAll(async () => {
  await ensureSeeded();
});

describe('auth & persistence', () => {
  it('registers, logs out, logs in from a second client and keeps preferences', async () => {
    const { agent, email } = await newUser('alice');
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    await agent.put('/api/preferences').send({ language: 'vi', explanationView: 'deep' }).expect(200);
    await agent.post('/api/auth/logout').expect(200);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
    const device2 = request.agent(app);
    const login = await device2.post('/api/auth/login').send({ email, password: 'correct horse battery' });
    expect(login.status).toBe(200);
    expect(login.body.preferences.language).toBe('vi');
    expect(login.body.preferences.explanationView).toBe('deep');
  });
  it('does not reveal whether an email exists', async () => {
    const { email } = await newUser('bob');
    const a = await request(app).post('/api/auth/login').send({ email, password: 'wrong password!' });
    const b = await request(app).post('/api/auth/login').send({ email: 'nobody@test.dev', password: 'wrong password!' });
    expect(a.status).toBe(401);
    expect(b.body).toEqual(a.body);
  });
  it('rejects duplicate registration and weak passwords', async () => {
    const { email } = await newUser('carol');
    expect((await request(app).post('/api/auth/register').send({ email, password: 'whatever123', displayName: 'x' })).status).toBe(409);
    expect((await request(app).post('/api/auth/register').send({ email: 'z@test.dev', password: 'short', displayName: 'x' })).status).toBe(400);
  });
  it('rate limits repeated failed logins', async () => {
    resetRateLimits();
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await request(app).post('/api/auth/login').send({ email: 'brute@test.dev', password: 'nope-nope' })).status;
    expect(last).toBe(429);
    resetRateLimits();
  });
  it('requires auth for user data', async () => {
    expect((await request(app).get('/api/dashboard')).status).toBe(401);
    expect((await request(app).get('/api/scenarios')).status).toBe(401);
  });
  it('rejects cross-origin state changes', async () => {
    const r = await request(app).post('/api/auth/logout').set('Origin', 'https://evil.example');
    expect(r.status).toBe(403);
  });
});

describe('hero training run', () => {
  it('plays a multi-street heuristic scenario without leaking answers', async () => {
    const { agent } = await newUser('hero');
    const list = await agent.get('/api/scenarios?mode=hero').expect(200);
    expect(list.body.length).toBeGreaterThan(2);
    const start = await agent.post('/api/runs').send({ scenarioId: 'btn-ajs-35bb-open-flop-cbet', mode: 'rated' }).expect(201);
    const view = start.body;
    expect(view.status).toBe('decision');
    expect(JSON.stringify(view)).not.toMatch(/"grade"|"modelKey"|"explanation"|keyReason/);
    expect(view.state.players.filter((p: { cards?: string[] }) => p.cards).length).toBe(1);
    expect(view.legal.minRaiseTo).toBe(2000);
    // illegal sizing rejected by the engine
    expect((await agent.post(`/api/runs/${view.runId}/act`).send({ clientAttemptId: cid(), action: { type: 'raise', amount: 1500 } })).status).toBe(400);
    const id1 = cid();
    const r1 = await agent.post(`/api/runs/${view.runId}/act`).send({ clientAttemptId: id1, action: { type: 'raise', amount: 2200 } }).expect(200);
    expect(r1.body.feedback.grade).toBe('excellent');
    expect(r1.body.feedback.basis).toBe('rubric');
    expect(r1.body.feedback.evLoss).toBeNull();
    expect(r1.body.feedback.ratingEligible).toBe(false); // heuristic content never rates
    expect(r1.body.feedback.ratingChanges).toEqual([]);
    expect(r1.body.view.state.board).toEqual(['Ks', '7d', '3s']);
    // idempotent retry
    const again = await agent.post(`/api/runs/${view.runId}/act`).send({ clientAttemptId: id1, action: { type: 'raise', amount: 2200 } }).expect(200);
    expect(again.body.view.nodeKey).toBe('d-flop');
    const r2 = await agent.post(`/api/runs/${view.runId}/act`).send({ clientAttemptId: cid(), action: { type: 'check' } }).expect(200);
    expect(r2.body.view.nodeKey).toBe('d-turn');
    const r3 = await agent.post(`/api/runs/${view.runId}/act`).send({ clientAttemptId: cid(), action: { type: 'check' } }).expect(200);
    expect(r3.body.view.status).toBe('complete');
    expect(r3.body.view.feedback).toHaveLength(3);
  });

  it('grades an assumed-range model decision by EV as Fundamentals: never moves strategy Elo', async () => {
    const { agent, id } = await newUser('rated');
    const start = await agent.post('/api/runs').send({ scenarioId: 'bb-k9o-call-sb-shove-12bb', mode: 'rated' }).expect(201);
    const clientAttemptId = cid();
    const r = await agent.post(`/api/runs/${start.body.runId}/act`).send({ clientAttemptId, action: { type: 'call' } }).expect(200);
    const fb = r.body.feedback;
    expect(fb.basis).toBe('modelEv');
    expect(fb.ratingEligible).toBe(false);
    expect(fb.facts.requiredEquityPct).toBe(44);
    expect(fb.model.assumptions.length).toBeGreaterThan(0);
    // only the Fundamentals subrating moves; strategy ratings are untouched
    expect(fb.ratingChanges.map((c: { skill: string }) => c.skill)).toEqual(['fundamentals']);
    const att = await prisma.decisionAttempt.findFirstOrThrow({ where: { userId: id } });
    expect(att.track).toBe('fundamentals');
    expect((await prisma.rating.findMany({ where: { userId: id } })).map((r) => r.skill)).toEqual(['fundamentals']);
    // idempotent retry
    await agent.post(`/api/runs/${start.body.runId}/act`).send({ clientAttemptId, action: { type: 'call' } }).expect(200);
    expect(await prisma.decisionAttempt.count({ where: { userId: id } })).toBe(1);
  });

  it('solver-backed GTO quiz answers are the ones that move strategy Elo, discounted on repeats', async () => {
    const { agent, id } = await newUser('gtorated');
    for (let i = 0; i < 2; i++) {
      const spot = await agent.get('/api/gto/spot?minStack=8&maxStack=8&role=sbShove').expect(200);
      await agent.post('/api/gto/answer').send({ token: spot.body.token, action: 'shove', clientAttemptId: cid(), mode: 'rated' }).expect(200);
    }
    const w = await prisma.decisionAttempt.findMany({ where: { userId: id }, select: { ratingWeight: true, track: true } });
    expect(w.every((x) => x.track === 'strategy')).toBe(true);
    expect(w.every((x) => x.ratingWeight > 0)).toBe(true);
  });

  it('practice mode records attempts but never changes ratings', async () => {
    const { agent, id } = await newUser('practice');
    const start = await agent.post('/api/runs').send({ scenarioId: 'bb-k9o-call-sb-shove-12bb', mode: 'practice' }).expect(201);
    await agent.post(`/api/runs/${start.body.runId}/act`).send({ clientAttemptId: cid(), action: { type: 'fold' } }).expect(200);
    expect(await prisma.rating.count({ where: { userId: id } })).toBe(0);
    expect(await prisma.decisionAttempt.count({ where: { userId: id } })).toBe(1);
    // the mistake is scheduled for review
    const q = await agent.get('/api/review/queue?filter=missed').expect(200);
    expect(q.body.length).toBeGreaterThanOrEqual(0);
  });

  it('isolates users: cannot read another user’s run', async () => {
    const a = await newUser('a');
    const b = await newUser('b');
    const start = await a.agent.post('/api/runs').send({ scenarioId: 'bb-k9o-call-sb-shove-12bb' }).expect(201);
    expect((await b.agent.get(`/api/runs/${start.body.runId}`)).status).toBe(404);
    expect((await b.agent.post(`/api/runs/${start.body.runId}/act`).send({ clientAttemptId: cid(), action: { type: 'call' } })).status).toBe(404);
  });
});

describe('notes, bookmarks and sessions', () => {
  it('keeps notes and bookmarks private to their owner', async () => {
    const a = await newUser('noter');
    const b = await newUser('snoop');
    const note = await a.agent.post('/api/notes').send({ targetType: 'scenario', targetRef: 'bb-k9o-call-sb-shove-12bb', body: 'Remember: 44% needed' }).expect(201);
    await a.agent.put('/api/bookmarks/bb-k9o-call-sb-shove-12bb').expect(200);
    expect((await a.agent.get('/api/notes')).body).toHaveLength(1);
    expect((await b.agent.get('/api/notes')).body).toEqual([]);
    expect((await b.agent.get('/api/bookmarks')).body).toEqual([]);
    await b.agent.delete(`/api/notes/${note.body.id}`).expect(200); // no-op for other users
    expect((await a.agent.get('/api/notes')).body).toHaveLength(1);
    await a.agent.delete(`/api/notes/${note.body.id}`).expect(200);
    expect((await a.agent.get('/api/notes')).body).toEqual([]);
    expect((await a.agent.put('/api/bookmarks/does-not-exist')).status).toBe(404);
  });
  it('purges expired sessions on sign-in', async () => {
    const { agent, email, id } = await newUser('expiry');
    await prisma.session.create({ data: { tokenHash: `expired-${id}`, userId: id, expiresAt: new Date(Date.now() - 1000) } });
    await agent.post('/api/auth/login').send({ email, password: 'correct horse battery' }).expect(200);
    expect(await prisma.session.count({ where: { userId: id, expiresAt: { lt: new Date() } } })).toBe(0);
  });
});

describe('next test picker', () => {
  it('starts a random scenario of the requested kind, preferring unattempted ones and never repeating the last', async () => {
    const { agent } = await newUser('picker');
    const a = await agent.post('/api/runs/next').send({ kind: 'hero', mode: 'practice' }).expect(201);
    expect(a.body.scenario.mode).toBe('hero');
    expect(a.body.pickReason).toBe('new');
    const seen = new Set<string>([a.body.scenario.id]);
    let last = a.body.scenario.id;
    for (let i = 0; i < 5; i++) {
      const r = await agent.post('/api/runs/next').send({ kind: 'hero', excludeScenarioId: last }).expect(201);
      expect(r.body.scenario.id).not.toBe(last);
      last = r.body.scenario.id;
      seen.add(last);
    }
    const v = await agent.post('/api/runs/next').send({ kind: 'villain', module: '11' }).expect(201);
    expect(v.body.scenario.mode).toBe('villain');
    expect(v.body.scenario.module).toBe('11');
    // assumed-range models are Fundamentals; no hero scenario is solver- or coach-verified yet
    expect((await agent.post('/api/runs/next').send({ kind: 'hero', ratedOnly: true })).status).toBe(404);
    expect((await agent.post('/api/runs/next').send({ kind: 'hero', module: '99' })).status).toBe(404);
  });
});

describe('math lab', () => {
  it('issues signed quizzes and grades answers server-side', async () => {
    const { agent } = await newUser('math');
    const q = await agent.get('/api/math/quiz?kind=mdf&level=1').expect(200);
    expect(q.body.answer).toBeUndefined();
    const r = await agent.post('/api/math/quiz/answer').send({ token: q.body.token, value: 50, clientAttemptId: cid() }).expect(200);
    expect(typeof r.body.answer).toBe('number');
    expect(r.body.steps.length).toBeGreaterThan(0);
    const tampered = q.body.token.slice(0, -2) + 'xx';
    expect((await agent.post('/api/math/quiz/answer').send({ token: tampered, value: 1, clientAttemptId: cid() })).status).toBe(400);
    const other = await newUser('math2');
    expect((await other.agent.post('/api/math/quiz/answer').send({ token: q.body.token, value: 1, clientAttemptId: cid() })).status).toBe(403);
  });
});

describe('dashboard, progress, leaks, curriculum', () => {
  it('returns analytics without merging metrics', async () => {
    const { agent } = await newUser('dash');
    const start = await agent.post('/api/runs').send({ scenarioId: 'bb-k9o-call-sb-shove-12bb', mode: 'rated' }).expect(201);
    await agent.post(`/api/runs/${start.body.runId}/act`).send({ clientAttemptId: cid(), action: { type: 'fold' } }).expect(200);
    const d = await agent.get('/api/dashboard').expect(200);
    // folding K9o loses ~0.5BB: graded "acceptable" (not an error); assumed-range models never rate
    expect(d.body.rating).toBeNull();
    expect(d.body.accuracyPct).toBe(100);
    expect(d.body.avgEvLossBB).toBeGreaterThan(0.3);
    expect(d.body.topLeaks).toEqual([]); // one hand is never enough evidence
    const p = await agent.get('/api/progress').expect(200);
    expect(p.body.byStreet[0].key).toBe('preflop');
    const l = await agent.get('/api/leaks').expect(200);
    expect(l.body[0].ranked).toBe(false);
    const c = await agent.get('/api/curriculum').expect(200);
    expect(c.body).toHaveLength(18);
    const h = await agent.get('/api/history').expect(200);
    expect(h.body.attempts).toHaveLength(1);
    expect((await agent.get('/api/history?filter=incorrect')).body.attempts).toHaveLength(0);
  });
});

describe('hand history import', () => {
  const fixture = readFileSync(new URL('../../../packages/core/test/fixtures/gg-sample.txt', import.meta.url));
  it('imports, deduplicates, records errors and hides the original action until answered', async () => {
    const { agent } = await newUser('importer');
    const r = await agent.post('/api/imports').attach('file', fixture, 'hh.txt').expect(201);
    expect(r.body.handsParsed).toBe(2);
    expect(r.body.handsFailed).toBe(1);
    expect(r.body.errors[0].externalHandId).toBe('TM5000000003');
    const again = await agent.post('/api/imports').attach('file', fixture, 'hh.txt').expect(201);
    expect(again.body.handsParsed).toBe(0);
    expect(again.body.handsDuplicate).toBe(2);
    const hands = await agent.get('/api/hands').expect(200);
    const big = hands.body.find((h: { externalHandId: string }) => h.externalHandId === 'TM5000000001');
    const detail = await agent.get(`/api/hands/${big.id}`).expect(200);
    expect(detail.body.spots).toHaveLength(5);
    const spot = await agent.get(`/api/hands/${big.id}/spots/4`).expect(200);
    expect(JSON.stringify(spot.body)).not.toMatch(/originalAction|heroAction/);
    expect(spot.body.state.players.filter((p: { cards?: string[] }) => p.cards).length).toBe(1); // villain QQ hidden
    const ans = await agent.post(`/api/hands/${big.id}/spots/4/answer`).send({ clientAttemptId: cid(), action: { type: 'call' } }).expect(200);
    expect(ans.body.originalAction.type).toBe('raise');
    expect(ans.body.matchesOriginal).toBe(false);
    await agent.post(`/api/hands/${big.id}/spots/4/queue`).expect(200);
    const q = await agent.get('/api/review/queue?filter=due').expect(200);
    expect(q.body.some((i: { kind: string }) => i.kind === 'imported')).toBe(true);
    // another user cannot see these hands
    const other = await newUser('other');
    expect((await other.agent.get(`/api/hands/${big.id}`)).status).toBe(404);
    expect((await other.agent.get('/api/hands')).body).toEqual([]);
  });
  it('imports hands from a ZIP with multiple files', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    const text = fixture.toString();
    zip.file('a.txt', text.split('\n\n')[0]!);
    zip.file('dir/b.txt', text);
    zip.file('notes.md', 'ignore me');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const { agent } = await newUser('zipper');
    const r = await agent.post('/api/imports').attach('file', buf, 'hh.zip').expect(201);
    expect(r.body.handsParsed).toBe(2);
    expect(r.body.handsDuplicate).toBe(1);
  });
  it('reports unsupported formats instead of silently dropping', async () => {
    const { agent } = await newUser('bad');
    const r = await agent.post('/api/imports').attach('file', Buffer.from('hello world'), 'x.txt').expect(201);
    expect(r.body.status).toBe('failed');
    expect(r.body.errors[0].message).toMatch(/Unsupported/);
  });
});

describe('GTO push/fold quiz and audit', () => {
  it('serves random equilibrium spots and grades answers server-side', async () => {
    const { agent, id } = await newUser('gto');
    const spot = await agent.get('/api/gto/spot?minStack=8&maxStack=10&role=sbShove').expect(200);
    expect(spot.body.role).toBe('sbShove');
    expect(spot.body.stackBB).toBeGreaterThanOrEqual(8);
    expect(spot.body).not.toHaveProperty('frequency');
    expect(spot.body.state.players.find((p: { id: string }) => p.id === 'SB').cards).toEqual(spot.body.heroCards);
    expect(spot.body.state.players.find((p: { id: string }) => p.id === 'BB').cards).toBeUndefined();
    const r = await agent.post('/api/gto/answer').send({ token: spot.body.token, action: 'shove', clientAttemptId: cid() }).expect(200);
    expect(r.body.source.classification).toBe('SOLVER_VERIFIED');
    expect(Object.keys(r.body.ranges.push)).toHaveLength(169);
    expect(typeof r.body.evLossBB).toBe('number');
    expect(r.body.ratingChanges.length).toBeGreaterThan(0);
    expect((await agent.post('/api/gto/answer').send({ token: spot.body.token, action: 'call', clientAttemptId: cid() })).status).toBe(400);
    const other = await newUser('gto2');
    expect((await other.agent.post('/api/gto/answer').send({ token: spot.body.token, action: 'fold', clientAttemptId: cid() })).status).toBe(403);
    expect(await prisma.decisionAttempt.count({ where: { userId: id, attemptType: 'quiz' } })).toBe(1);
  });
  it('audits push/fold decisions in imported hands', async () => {
    const hand = [
      "Poker Hand #TM9000000001: Tournament #900000001, Synthetic Test $1 Hold'em No Limit - Level12(1,000/2,000(250)) - 2026/10/20 21:15:03",
      "Table '1' 6-max Seat #6 is the button",
      'Seat 1: Hero (16,250 in chips)',
      'Seat 2: bbplayer (40,000 in chips)',
      'Seat 3: p3 (30,000 in chips)',
      'Seat 4: p4 (30,000 in chips)',
      'Seat 5: p5 (30,000 in chips)',
      'Seat 6: p6 (30,000 in chips)',
      ...['Hero', 'bbplayer', 'p3', 'p4', 'p5', 'p6'].map((p) => `${p}: posts the ante 250`),
      'Hero: posts small blind 1,000',
      'bbplayer: posts big blind 2,000',
      '*** HOLE CARDS ***',
      'Dealt to Hero [Ah 9c]',
      'p3: folds',
      'p4: folds',
      'p5: folds',
      'p6: folds',
      'Hero: raises 14,000 to 16,000 and is all-in',
      'bbplayer: folds',
      'Uncalled bet (14,000) returned to Hero',
      'Hero collected 5,500 from pot',
      '*** SUMMARY ***',
      'Total pot 5,500 | Rake 0 | Jackpot 0 | Bingo 0 | Fortune 0 | Tax 0',
    ].join('\n');
    const { agent } = await newUser('auditor');
    const imp = await agent.post('/api/imports').attach('file', Buffer.from(hand), 'h.txt').expect(201);
    expect(imp.body.handsParsed).toBe(1);
    const a = await agent.get('/api/gto/audit').expect(200);
    expect(a.body.sbShove.graded).toBe(1);
    expect(a.body.worst[0].heroAction).toBe('shove');
    expect(a.body.worst[0].stackBB).toBe(8);
    expect(a.body.worst[0].grade).toBe('excellent');
  });
});

describe('postflop GTO quiz', () => {
  it('serves solved flop spots, hides the answer, grades by solver EV', async () => {
    const { agent } = await newUser('pf');
    const info = await agent.get('/api/gto/postflop/info').expect(200);
    expect(info.body.flops).toBeGreaterThan(0);
    for (const node of ['ip_vs_check', 'oop_vs_bet39', 'oop_vs_bet89']) {
      const spot = await agent.get(`/api/gto/postflop/spot?node=${node}`).expect(200);
      expect(spot.body.node).toBe(node);
      expect(spot.body.state.board).toHaveLength(3);
      expect(JSON.stringify(spot.body)).not.toMatch(/"f":|"ev":|freq/);
      const hero = spot.body.state.players.find((p: { id: string }) => p.id === spot.body.hero);
      expect(hero.cards).toEqual(spot.body.heroCards);
      expect(spot.body.state.players.filter((p: { cards?: string[] }) => p.cards).length).toBe(1);
      // pot on the flop is 5.9BB (+ the bet when facing a c-bet)
      const pot = spot.body.state.deadAntes + spot.body.state.players.reduce((s: number, p: { totalCommitted: number }) => s + p.totalCommitted, 0);
      expect(pot).toBeGreaterThanOrEqual(5900);
      const r = await agent.post('/api/gto/postflop/answer').send({ token: spot.body.token, actionIndex: 0, clientAttemptId: cid() }).expect(200);
      expect(r.body.options.length).toBe(spot.body.actions.length);
      expect(r.body.options.some((o: { best: boolean }) => o.best)).toBe(true);
      expect(r.body.source.classification).toBe('SOLVER_VERIFIED');
      expect(Object.keys(r.body.rangeByClass).length).toBeGreaterThan(50);
      expect(r.body.evLossBB).toBeGreaterThanOrEqual(0);
    }
    const spot = await agent.get('/api/gto/postflop/spot').expect(200);
    expect((await agent.post('/api/gto/postflop/answer').send({ token: spot.body.token.slice(0, -3) + 'abc', actionIndex: 0, clientAttemptId: cid() })).status).toBe(400);
  });
});

describe('exact math facts', () => {
  it('required equity excludes chips Hero cannot win when calling all-in for less', async () => {
    const { mathFacts } = await import('../src/runs');
    const { createHand, applyAction } = await import('@pdl/core');
    // Hero (BB) has 10BB; SB shoves 30BB. Hero can only win 10 + 10 = 20BB total.
    let s = createHand({ smallBlind: 500, bigBlind: 1000, ante: 0, anteMode: 'none', players: [{ id: 'SB', stack: 30000 }, { id: 'BB', stack: 10000 }] });
    s = applyAction(s, { type: 'raise', amount: 30000 });
    const f = mathFacts(s, 1000)!;
    // call 9BB to win a 20BB pot → 45%, not 9/(31+9) = 22.5%
    expect(f.requiredEquityPct).toBe(45);
    expect(f.potOddsToOne).toBeCloseTo(11 / 9, 2);
  });
});
