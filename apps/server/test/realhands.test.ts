import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { importV2 } from '../src/realhands/import';
import { cid, ensureSeeded, newUser } from './helpers';
import { buildV2Fixture } from './v2fixture';

let owner: Awaited<ReturnType<typeof newUser>>;
let summary: Awaited<ReturnType<typeof importV2>>;
const fx = buildV2Fixture();

beforeAll(async () => {
  await ensureSeeded();
  owner = await newUser('realowner');
  summary = await importV2(owner.id, fx.dir);
});

const anyDecision = async (where: object = {}) => prisma.realDecision.findFirstOrThrow({ where: { userId: owner.id, status: 'accepted', ...where } });

describe('V2 import', () => {
  it('imports every fixture hand and quarantines the wrong supplied snapshot with a reason', async () => {
    expect(summary.hands.accepted).toBe(fx.expected.hands);
    expect(summary.decisions.accepted + summary.decisions.quarantined).toBe(fx.expected.decisions);
    expect(summary.decisions.quarantined).toBe(1);
    const q = await prisma.realDecision.findFirstOrThrow({ where: { userId: owner.id, status: 'quarantined' } });
    expect(JSON.stringify(q.issues)).toMatch(/call_mismatch/);
    // supplier's whole-pot formula is wrong only where Hero is all-in for less
    expect(summary.quizzes.quarantined).toBeGreaterThanOrEqual(1);
    const cov = await owner.agent.get('/api/real/coverage').expect(200);
    expect(cov.body.decisionQuarantineReasons.call_mismatch).toBe(1);
    expect(cov.body.potOddsQuarantineReasons.winnable_pot_differs).toBeGreaterThanOrEqual(1);
  });
  it('is idempotent', async () => {
    const before = await prisma.realDecision.count({ where: { userId: owner.id } });
    await importV2(owner.id, fx.dir);
    expect(await prisma.realDecision.count({ where: { userId: owner.id } })).toBe(before);
  });
  it('resumes an interrupted import: missing decisions attach to the stored hand rows', async () => {
    const hand = await prisma.realHand.findFirstOrThrow({ where: { userId: owner.id, decisions: { some: {} } }, include: { decisions: true } });
    const n = hand.decisions.length;
    await prisma.annotation.deleteMany({ where: { decisionId: { in: hand.decisions.map((d) => d.id) } } });
    await prisma.realDecision.deleteMany({ where: { realHandId: hand.id } });
    await importV2(owner.id, fx.dir, () => {}, { batch: 2 });
    expect(await prisma.realDecision.count({ where: { realHandId: hand.id } })).toBe(n);
    expect(await prisma.realHand.count({ where: { userId: owner.id } })).toBe(fx.expected.hands);
    // fast resume only touches the incomplete hand
    await prisma.realDecision.deleteMany({ where: { realHandId: hand.id } });
    const s = await importV2(owner.id, fx.dir, () => {}, { skipComplete: true });
    expect(s.hands.accepted + s.hands.quarantined).toBe(1);
    expect(await prisma.realDecision.count({ where: { realHandId: hand.id } })).toBe(n);
  });
  it('never puts one hand in both training and assessment', async () => {
    const rows = await prisma.realDecision.groupBy({ by: ['familyId'], where: { userId: owner.id }, _count: { split: true } });
    for (const r of rows) {
      const splits = await prisma.realDecision.findMany({ where: { userId: owner.id, familyId: r.familyId }, select: { split: true }, distinct: ['split'] });
      expect(splits).toHaveLength(1);
    }
  });
});

describe('Real Hand Replay', () => {
  it('question payload contains only information available at the decision', async () => {
    const d = await anyDecision({ street: 'preflop', facingAllIn: true });
    const q = await owner.agent.get(`/api/real/decisions/${d.id}/question`).expect(200);
    const s = JSON.stringify(q.body);
    expect(s).not.toMatch(/observed|reviewTags|hero_all_in|"raw"|collected|shows|actual_action/);
    expect(q.body.state.board).toEqual([]);
    expect(q.body.state.players.filter((p: { cards?: string[] }) => p.cards).length).toBe(1);
    expect(q.body.state.result).toBeUndefined();
    // the engine never offers a raise against an all-in opponent when nobody else can act
    if (q.body.state.players.filter((p: { folded: boolean; allIn: boolean; id: string }) => !p.folded && !p.allIn && p.id !== 'Hero').length === 0) expect(q.body.legal.canRaise).toBe(false);
  });
  it('requires action, reasoning and confidence before revealing; unreviewed answers are never judged', async () => {
    const d = await anyDecision();
    const q = await owner.agent.get(`/api/real/decisions/${d.id}/question`).expect(200);
    const action = q.body.legal.canCheck ? { type: 'check' } : { type: 'fold' };
    expect((await owner.agent.post(`/api/real/decisions/${d.id}/answer`).send({ clientAttemptId: cid(), action })).status).toBe(400);
    expect((await owner.agent.get(`/api/real/decisions/${d.id}/outcome`)).status).toBe(403);
    const r = await owner.agent.post(`/api/real/decisions/${d.id}/answer`).send({ clientAttemptId: cid(), action, reasoning: 'range is too strong', confidence: 2, responseMs: 4200, mode: 'rated' }).expect(200);
    expect(r.body.strategy.status).toBe('unreviewed');
    expect(r.body.observed.label).toBe('historical');
    expect(r.body.ratingChanges).toEqual([]);
    expect(r.body).not.toHaveProperty('grade');
    const att = await prisma.decisionAttempt.findFirstOrThrow({ where: { userId: owner.id, attemptType: 'replay' }, orderBy: { createdAt: 'desc' } });
    expect(att.track).toBe('replay');
    expect(att.responseMs).toBe(4200);
    expect(att.reasoning).toBe('range is too strong');
    const out = await owner.agent.get(`/api/real/decisions/${d.id}/outcome`).expect(200);
    expect(out.body.label.en).toMatch(/historical/);
  });
  it('rejects illegal actions through the engine', async () => {
    const d = await anyDecision({ toCallBB: { gt: 0 } });
    expect((await owner.agent.post(`/api/real/decisions/${d.id}/answer`).send({ clientAttemptId: cid(), action: { type: 'check' }, reasoning: 'x x x', confidence: 1 })).status).toBe(400);
  });
  it('other users cannot read or answer my decisions', async () => {
    const d = await anyDecision();
    const other = await newUser('snooper');
    expect((await other.agent.get(`/api/real/decisions/${d.id}/question`)).status).toBe(404);
    expect((await other.agent.get(`/api/real/review`)).body.total).toBe(0);
  });
});

describe('Annotations and Reviewed Strategy', () => {
  it('drafts never grade; a verified EV annotation grades supported actions and marks others Not evaluated', async () => {
    const d = await anyDecision({ toCallBB: { gt: 0 } });
    const q = await owner.agent.get(`/api/real/decisions/${d.id}/question`).expect(200);
    // AI-authored frequencies without a solver are rejected
    expect((await owner.agent.post(`/api/real/decisions/${d.id}/annotations`).send({ source: 'human', authorKind: 'ai', economics: { chipEV: true }, evaluated: [{ action: 'fold', ev: 0, freq: 0.5 }], recommendation: 'fold', explanationVi: 'x', confidence: 'low', scope: 'x' })).status).toBe(400);
    const a = await owner.agent
      .post(`/api/real/decisions/${d.id}/annotations`)
      .send({ source: 'calculation', authorKind: 'ai', economics: { chipEV: true, icm: 'ignored', bounty: 'ignored' }, assumedRanges: [{ player: 'Villain', range: 'any two', justification: 'test' }], missingInfo: ['payouts'], evaluated: [{ action: 'fold', ev: 0 }, { action: 'call', ev: 1.5 }], recommendation: 'call', explanationVi: 'Theo có EV cao hơn theo giả định.', confidence: 'medium', scope: 'test only', toleranceBB: 0.05 })
      .expect(201);
    expect(a.body.status).toBe('draft');
    // draft: still unreviewed
    const r0 = await owner.agent.post(`/api/real/decisions/${d.id}/answer`).send({ clientAttemptId: cid(), action: { type: 'fold' }, reasoning: 'draft check', confidence: 2 }).expect(200);
    expect(r0.body.strategy.status).toBe('unreviewed');
    expect((await owner.agent.post(`/api/real/annotations/${a.body.id}/verify`).send({})).status).toBe(400);
    await owner.agent.post(`/api/real/annotations/${a.body.id}/verify`).send({ confirm: true }).expect(200);
    const r1 = await owner.agent.post(`/api/real/decisions/${d.id}/answer`).send({ clientAttemptId: cid(), action: { type: 'fold' }, reasoning: 'too expensive', confidence: 3, mode: 'rated' }).expect(200);
    expect(r1.body.strategy.evaluation).toBe('ev');
    expect(r1.body.strategy.evLossBB).toBe(1.5);
    expect(r1.body.strategy.grade).toBe('mistake'); // 1.5BB loss under the default BB thresholds
    if (q.body.legal.canRaise) {
      const r2 = await owner.agent.post(`/api/real/decisions/${d.id}/answer`).send({ clientAttemptId: cid(), action: { type: 'raise', amount: q.body.legal.minRaiseTo }, reasoning: 'try raise', confidence: 1 }).expect(200);
      expect(r2.body.strategy.evaluation).toBe('not_evaluated');
      expect(r2.body.strategy.evLossBB).toBeUndefined();
    }
    // a new version retires the old one; history is kept
    const b = await owner.agent.post(`/api/real/decisions/${d.id}/annotations`).send({ source: 'human', economics: { chipEV: true }, evaluated: [{ action: 'fold' }, { action: 'call' }], recommendation: 'call (qualitative)', explanationVi: 'Đánh giá định tính.', confidence: 'low', scope: 'qualitative' }).expect(201);
    expect(b.body.version).toBe(2);
    await owner.agent.post(`/api/real/annotations/${b.body.id}/verify`).send({ confirm: true }).expect(200);
    const hist = await owner.agent.get(`/api/real/decisions/${d.id}/review`).expect(200);
    expect(hist.body.annotations.map((x: { status: string }) => x.status)).toEqual(['verified', 'retired']);
    const r3 = await owner.agent.post(`/api/real/decisions/${d.id}/answer`).send({ clientAttemptId: cid(), action: { type: 'fold' }, reasoning: 'qualitative', confidence: 2 }).expect(200);
    expect(r3.body.strategy.evaluation).toBe('qualitative');
    expect(r3.body.strategy.grade).toBeUndefined();
  });
  it('strategy Elo moves only for verified EV grading on held-out assessment decisions in rated mode', async () => {
    const d = await anyDecision({ toCallBB: { gt: 0 }, annotations: { none: {} } });
    const a = await owner.agent.post(`/api/real/decisions/${d.id}/annotations`).send({ source: 'calculation', economics: { chipEV: true }, evaluated: [{ action: 'fold', ev: 0 }, { action: 'call', ev: 1 }], recommendation: 'call', explanationVi: 'x', confidence: 'medium', scope: 'x' }).expect(201);
    await owner.agent.post(`/api/real/annotations/${a.body.id}/verify`).send({ confirm: true }).expect(200);
    await prisma.realDecision.update({ where: { id: d.id }, data: { split: 'training' } });
    const t = await owner.agent.post(`/api/real/decisions/${d.id}/answer`).send({ clientAttemptId: cid(), action: { type: 'fold' }, reasoning: 'training split', confidence: 2, mode: 'rated' }).expect(200);
    expect(t.body.ratingChanges).toEqual([]);
    await prisma.realDecision.update({ where: { id: d.id }, data: { split: 'assessment' } });
    const s = await owner.agent.post(`/api/real/decisions/${d.id}/answer`).send({ clientAttemptId: cid(), action: { type: 'fold' }, reasoning: 'assessment split', confidence: 2, mode: 'rated' }).expect(200);
    expect(s.body.ratingChanges.length).toBeGreaterThan(0);
  });
  it('the review queue filters by street, stack, pot, multiway and annotation status', async () => {
    const all = await owner.agent.get('/api/real/review?pageSize=100').expect(200);
    expect(all.body.total).toBeGreaterThan(0);
    const pre = await owner.agent.get('/api/real/review?street=preflop&pageSize=100').expect(200);
    expect(pre.body.rows.every((r: { street: string }) => r.street === 'preflop')).toBe(true);
    const ver = await owner.agent.get('/api/real/review?annotation=verified').expect(200);
    expect(ver.body.total).toBeGreaterThanOrEqual(2);
    const deep = await owner.agent.get('/api/real/review?minStack=30').expect(200);
    expect(deep.body.rows.every((r: { stackDepthBB: number }) => r.stackDepthBB >= 30)).toBe(true);
    const q = await owner.agent.get('/api/real/review?status=quarantined').expect(200);
    expect(q.body.total).toBe(1);
  });
});

describe('Fundamentals and metrics', () => {
  it('pot-odds benchmark uses the winnable pot, never moves Elo', async () => {
    const d = await prisma.realDecision.findFirstOrThrow({ where: { userId: owner.id, potOdds: { path: ['status'], equals: 'accepted' } } });
    const po = d.potOdds as { requiredEquity: number };
    const r = await owner.agent.post(`/api/real/potodds/${d.id}/answer`).send({ clientAttemptId: cid(), valuePct: po.requiredEquity * 100 + 0.3 }).expect(200);
    expect(r.body.grade).toBe('excellent');
    expect(r.body.ratingChanges.map((c: { skill: string }) => c.skill)).toEqual(['fundamentals']);
    const next = await owner.agent.post('/api/real/next').send({ kind: 'potodds' }).expect(200);
    expect(next.body.potOddsPrompt.vi).toMatch(/không phải câu hỏi nên theo hay bỏ/);
  });
  it('reports metrics per track without mixing them', async () => {
    const m = await owner.agent.get('/api/real/metrics').expect(200);
    expect(Object.keys(m.body.tracks).sort()).toEqual(expect.arrayContaining(['fundamentals', 'replay', 'strategy']));
    expect(m.body.tracks.replay.graded).toBe(0);
    expect(m.body.calibration).toHaveLength(3);
    expect(m.body.byStandard.length).toBeGreaterThanOrEqual(2); // annotation versions kept apart
  });
  it('exports a backup of the account', async () => {
    const e = await owner.agent.get('/api/export').expect(200);
    const body = JSON.parse(e.text);
    expect(body.format).toBe('pdl-export-v1');
    expect(body.annotations.length).toBeGreaterThanOrEqual(3);
    expect(body.realHands).toEqual([]);
    const withRaw = JSON.parse((await owner.agent.get('/api/export?raw=1').expect(200)).text);
    expect(withRaw.realHands.length).toBe(fx.expected.hands);
  });
});

describe('decision context (leak engine input)', () => {
  it('import fills a normalized context for every accepted decision; backfill reproduces it exactly', async () => {
    const { backfillContexts } = await import('../src/realhands/import');
    const sel = { id: true, position: true, actionContext: true, heroAction: true, stackBucket: true, heroClass: true, spr: true, facingBetPct: true, requiredEq: true, formatGroup: true, pfAudit: true, contextV: true } as const;
    const before = await prisma.realDecision.findMany({ where: { userId: owner.id, status: 'accepted' }, select: sel, orderBy: { id: 'asc' } });
    expect(before.length).toBeGreaterThan(0);
    const { CONTEXT_VERSION } = await import('@pdl/core');
    expect(before.every((d) => d.contextV === CONTEXT_VERSION && d.position && d.actionContext && d.heroAction)).toBe(true);
    await prisma.realDecision.updateMany({ where: { userId: owner.id }, data: { contextV: 0, position: null, actionContext: null } });
    const r = await backfillContexts(owner.id);
    expect(r.failed).toBe(0);
    expect(r.decisions).toBe(before.length);
    const after = await prisma.realDecision.findMany({ where: { userId: owner.id, status: 'accepted' }, select: sel, orderBy: { id: 'asc' } });
    expect(after).toEqual(before);
    expect((await backfillContexts(owner.id)).decisions).toBe(0); // idempotent
  });
});

describe('real-hand leak report (engine v2)', () => {
  it('returns labelled evidence; a tiny sample is never judged; users are isolated', async () => {
    const r = (await owner.agent.get('/api/leaks/real').expect(200)).body;
    expect(r.version).toBe('leaks-v2');
    expect(r.decisions).toBeGreaterThan(0);
    for (const p of r.patterns) {
      expect(['pattern', 'descriptive']).toContain(p.evidence);
      if (p.evidence === 'pattern' && p.n < 30) expect(p.verdict).toBe('insufficient');
      expect(JSON.stringify(p)).not.toMatch(/evLoss/); // patterns never claim EV
    }
    expect(r.solver).toHaveProperty('verifiedMistakes');
    const other = await newUser('leaks-other');
    const o = (await other.agent.get('/api/leaks/real').expect(200)).body;
    expect(o.decisions).toBe(0);
    expect(o.patterns.every((p: { n: number }) => p.n === 0)).toBe(true);
  });
});
