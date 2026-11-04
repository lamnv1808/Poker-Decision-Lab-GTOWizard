import type { HandState, OracleNode, PlayerAction, SimConfig, SimDeal, SpotOracle } from '@pdl/core';
import { fullDeck, totalPot } from '@pdl/core';
import { mixedSessionFor } from './mixed';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { newDecisionNonce, tokenAttemptKey } from './attemptKey';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Card, type Grade, GRADING_METHOD_VERSION, applyAction, classOfCombo, createHand, dealNextStreet, gradeFromEvLoss, DEFAULT_THRESHOLDS, isError, legalActions, parseCards, publicState } from '@pdl/core';
import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from './auth';
import { env } from './env';
import { HttpError, parse } from './http';
import { recordAttempt } from './learning';

/**
 * Postflop GTO quiz. Data: flops solved offline with postflop-solver (AGPL-3.0, run as a separate
 * tool; only its output is shipped) — see docs/POSTFLOP_DATA.md. Spot: MTT single-raised pot,
 * BTN opens 2.2BB, BB (1BB big-blind ante) calls, 32BB effective. Flops chosen from the owner's own
 * hand histories (texture-stratified).
 */
interface HandRow { c: string; w: number; eq: number; f: number[]; ev: number[] }
interface NodeData { node: string; player: 'OOP' | 'IP'; actions: string[]; hands: HandRow[] }
interface FlopFile { flop: string; chipsPerBB: number; potBB: number; stackBB: number; ranges: { oop: string; ip: string }; exploitabilityPctPot: number; solver: string; tree?: string; nodes: NodeData[] }

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, '../data/postflop');
const FLOPS: string[] = existsSync(DATA_DIR) ? readdirSync(DATA_DIR).filter((f) => /^[2-9TJQKA][cdhs][2-9TJQKA][cdhs][2-9TJQKA][cdhs]\.json\.gz$/.test(f)).map((f) => f.slice(0, 6)).sort() : [];
const cache = new Map<string, FlopFile>();
function load(flop: string): FlopFile {
  let d = cache.get(flop);
  if (!d) {
    if (!FLOPS.includes(flop)) throw new HttpError(404, 'not_found', 'Unknown flop');
    d = JSON.parse(gunzipSync(readFileSync(join(DATA_DIR, `${flop}.json.gz`))).toString('utf8')) as FlopFile;
    if (cache.size > 40) cache.delete(cache.keys().next().value!);
    cache.set(flop, d);
  }
  return d;
}

export const QUIZ_NODES = ['ip_vs_check', 'oop_vs_bet39', 'oop_vs_bet89'] as const;
type QuizNode = (typeof QUIZ_NODES)[number];

/** "Bet(39)" → {kind:'bet', chips:39}; sizes are in solver chips (chipsPerBB per BB). */
function parseAction(a: string): { kind: 'check' | 'bet' | 'raise' | 'call' | 'fold' | 'allin'; chips?: number } {
  const m = /^(Check|Fold|Call|Bet|Raise|AllIn)(?:\((\d+)\))?$/.exec(a);
  if (!m) throw new Error(`Unknown action ${a}`);
  const k = m[1]!.toLowerCase() as 'check';
  return { kind: k === ('allin' as 'check') ? ('allin' as 'check') : k, chips: m[2] ? Number(m[2]) : undefined };
}

export function actionLabel(a: string, d: FlopFile, potBeforeChips: number) {
  const p = parseAction(a);
  const bb = (c: number) => Math.round((c / d.chipsPerBB) * 100) / 100;
  if (p.kind === 'bet') return { en: `Bet ${Math.round((p.chips! / potBeforeChips) * 100)}% (${bb(p.chips!)}BB)`, vi: `Cược ${Math.round((p.chips! / potBeforeChips) * 100)}% (${bb(p.chips!)}BB)` };
  if (p.kind === 'raise') return { en: `Raise to ${bb(p.chips!)}BB`, vi: `Tố lên ${bb(p.chips!)}BB` };
  if (p.kind === 'allin') return { en: `All-in (${bb(p.chips!)}BB)`, vi: `All-in (${bb(p.chips!)}BB)` };
  return { check: { en: 'Check', vi: 'Check' }, call: { en: 'Call', vi: 'Theo' }, fold: { en: 'Fold', vi: 'Bỏ bài' } }[p.kind as 'check' | 'call' | 'fold'];
}

const BB = 1000;
/** Rebuild the spot on the real engine: 6-max, folds to BTN, BTN 2.2BB, SB folds, BB calls, flop, node actions. */
export function spotState(d: FlopFile, node: QuizNode, heroCombo: string) {
  const stack = d.stackBB * BB;
  const hero: 'BB' | 'BTN' = node === 'ip_vs_check' ? 'BTN' : 'BB';
  const players = ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'].map((id) => ({ id, stack: id === 'BB' ? stack + BB : stack, cards: id === hero ? (parseCards(heroCombo) as Card[]) : undefined }));
  let s = createHand({ smallBlind: BB / 2, bigBlind: BB, ante: BB, anteMode: 'bigBlind', players });
  for (let i = 0; i < 3; i++) s = applyAction(s, { type: 'fold' }); // UTG, HJ, CO
  s = applyAction(s, { type: 'raise', amount: 2.2 * BB }); // BTN
  s = applyAction(s, { type: 'fold' }); // SB
  s = applyAction(s, { type: 'call' }); // BB
  s = dealNextStreet(s, parseCards(d.flop) as Card[]);
  s = applyAction(s, { type: 'check' }); // BB checks
  if (node !== 'ip_vs_check') {
    const chips = Number(node.replace('oop_vs_bet', ''));
    s = applyAction(s, { type: 'bet', amount: Math.round((chips / d.chipsPerBB) * BB) });
  }
  return { state: s, hero };
}

function sign(p: string) {
  return createHmac('sha256', env.APP_SECRET).update(`pf:${p}`).digest('base64url');
}
function issue(o: object) {
  const p = Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${p}.${sign(p)}`;
}
function read(userId: string, token: string): { u: string; flop: string; node: QuizNode; c: string; n?: string } {
  const [p, s] = token.split('.');
  if (!p || !s) throw new HttpError(400, 'invalid_token');
  const a = Buffer.from(sign(p));
  const b = Buffer.from(s);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(400, 'invalid_token');
  const d = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (d.u !== userId) throw new HttpError(403, 'forbidden');
  return d;
}

/** Pick a hand in the node's range: 65% from "instructive" hands (mixed, or EV spread ≥ 0.15BB). */
function pickHand(n: NodeData): HandRow {
  const instructive = n.hands.filter((h) => Math.max(...h.f) < 0.9 || Math.max(...h.ev) - Math.min(...h.ev) >= 0.15);
  const pool = instructive.length && randomInt(100) < 65 ? instructive : n.hands;
  const total = pool.reduce((s, h) => s + h.w, 0);
  let x = (randomInt(1_000_000) / 1_000_000) * total;
  for (const h of pool) if ((x -= h.w) <= 0) return h;
  return pool[pool.length - 1]!;
}

export const postflopRouter = Router();

postflopRouter.get('/info', (_req, res) => {
  const sample = FLOPS[0] ? load(FLOPS[0]) : null;
  res.json({ flops: FLOPS.length, stackBB: sample?.stackBB ?? null, potBB: sample?.potBB ?? null, ranges: sample?.ranges ?? null, solver: sample?.solver ?? null, tree: sample?.tree ?? null });
});

postflopRouter.get('/spot', (req, res) => {
  const userId = requireUser(req);
  const q = parse(z.object({ node: z.enum(['any', ...QUIZ_NODES]).default('any') }), req.query);
  if (!FLOPS.length) throw new HttpError(503, 'no_data', 'No postflop solutions installed');
  const flop = FLOPS[randomInt(FLOPS.length)]!;
  const d = load(flop);
  const node = (q.node === 'any' ? QUIZ_NODES[randomInt(QUIZ_NODES.length)] : q.node) as QuizNode;
  const n = d.nodes.find((x) => x.node === node);
  if (!n) throw new HttpError(500, 'bad_data', `Node ${node} missing for ${flop}`);
  const h = pickHand(n);
  const { state, hero } = spotState(d, node, h.c);
  const potBefore = state.deadAntes + state.players.reduce((s, p) => s + p.totalCommitted, 0) - (node === 'ip_vs_check' ? 0 : state.currentBet);
  const potChips = (potBefore / BB) * d.chipsPerBB;
  res.json({
    token: issue({ u: userId, flop, node, c: h.c, n: newDecisionNonce() }),
    flop,
    node,
    hero,
    heroCards: parseCards(h.c),
    bigBlind: BB,
    state: publicState(state, hero),
    legal: legalActions(state),
    actions: n.actions.map((a, i) => ({ index: i, key: a, label: actionLabel(a, d, potChips) })),
    stackBB: d.stackBB,
    potBB: d.potBB,
  });
});

postflopRouter.post('/answer', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(z.object({ sessionId: z.string().uuid().optional(), token: z.string().min(10).max(2000), actionIndex: z.number().int().min(0).max(10), clientAttemptId: z.string().min(8).max(100), mode: z.enum(['practice', 'rated']).default('rated') }), req.body);
  const t = read(userId, body.token);
  const d = load(t.flop);
  const n = d.nodes.find((x) => x.node === t.node)!;
  const h = n.hands.find((x) => x.c === t.c);
  if (!h) throw new HttpError(400, 'invalid_token');
  if (body.actionIndex >= n.actions.length) throw new HttpError(400, 'illegal_action', 'Unknown action');
  const best = Math.max(...h.ev);
  const evLoss = Math.max(0, best - h.ev[body.actionIndex]!);
  // Solver precision: exploitability (% of pot) × pot. Differences within 2× that are indistinguishable.
  const noise = 2 * (d.exploitabilityPctPot / 100) * d.potBB;
  const inMix = h.f[body.actionIndex]! >= 0.1;
  const grade: Grade = evLoss <= noise || (inMix && evLoss <= 3 * noise) ? 'excellent' : gradeFromEvLoss(evLoss, DEFAULT_THRESHOLDS.bb);
  const potChips = n.player === 'IP' ? d.potBB * d.chipsPerBB : d.potBB * d.chipsPerBB;
  // Range overview: per hand class, weighted average frequency of each action.
  const byClass = new Map<string, { w: number; f: number[] }>();
  for (const x of n.hands) {
    const cls = classOfCombo(x.c.slice(0, 2) as Card, x.c.slice(2, 4) as Card);
    const e = byClass.get(cls) ?? { w: 0, f: n.actions.map(() => 0) };
    e.w += x.w;
    x.f.forEach((v, i) => (e.f[i]! += v * x.w));
    byClass.set(cls, e);
  }
  const totalW = n.hands.reduce((s, x) => s + x.w, 0);
  const overall = n.actions.map((_, i) => Math.round((1000 * n.hands.reduce((s, x) => s + x.w * x.f[i]!, 0)) / totalW) / 10);
  const chosenKind = parseAction(n.actions[body.actionIndex]!).kind;
  const bestKind = parseAction(n.actions[h.ev.indexOf(best)]!).kind;
  const leak =
    t.node === 'ip_vs_check' ? (chosenKind === 'check' && bestKind !== 'check' ? 'underbluffing' : chosenKind !== 'check' && bestKind === 'check' ? 'overbluffing' : 'bluffSizing') : chosenKind === 'fold' ? 'potOdds' : chosenKind === 'raise' ? 'overbluffing' : 'riverBluffCatching';
  const result = {
    flop: d.flop,
    node: t.node,
    heroCombo: h.c,
    heroClass: classOfCombo(h.c.slice(0, 2) as Card, h.c.slice(2, 4) as Card),
    actionIndex: body.actionIndex,
    grade,
    evLossBB: Math.round(evLoss * 1000) / 1000,
    equityPct: Math.round(h.eq * 1000) / 10,
    options: n.actions.map((a, i) => ({ key: a, label: actionLabel(a, d, potChips), freq: h.f[i]!, ev: h.ev[i]!, best: h.ev[i] === best })),
    overall,
    exploitabilityPctPot: d.exploitabilityPctPot,
    source: {
      classification: 'SOLVER_VERIFIED',
      method: {
        en: `Solved offline with ${d.solver} to ${d.exploitabilityPctPot}% of the pot. ${d.tree ?? ''}. Preflop ranges are stated assumptions (BTN open ~48%, BB flat-call range).`,
        vi: `Giải ngoại tuyến bằng ${d.solver}, độ khai thác ${d.exploitabilityPctPot}% pot. ${d.tree ?? ''}. Range preflop là giả định được nêu (BTN mở ~48%, range theo của BB).`,
      },
    },
  };
  // a Mixed session's practice/rated choice overrides the page's own toggle
  const mixed = await mixedSessionFor(userId, body.sessionId);
  const outcome = await recordAttempt({
    userId,
    clientAttemptId: tokenAttemptKey('gtopf', t.n, body.clientAttemptId),
    sessionId: mixed?.id ?? null,
    attemptType: 'quiz',
    itemRef: `gtopf:${t.flop}:${t.node}:${result.heroClass}`,
    reviewType: 'quiz',
    reviewRef: 'gtopf',
    mode: mixed?.mode ?? body.mode,
    action: { actionIndex: body.actionIndex, action: n.actions[body.actionIndex] },
    optionKey: n.actions[body.actionIndex],
    graded: true,
    grade,
    gradeBasis: 'solverEv',
    evLoss: result.evLossBB,
    evUnit: 'bb',
    ratingEligible: true,
    isError: isError(grade),
    gradingMethodVersion: GRADING_METHOD_VERSION,
    street: 'flop',
    heroPosition: n.player === 'IP' ? 'BTN' : 'BB',
    effectiveStackBB: d.stackBB,
    difficulty: Math.max(...h.f) < 0.75 ? 4 : 3,
    skills: ['flop'],
    concepts: [t.node === 'ip_vs_check' ? 'c-betting' : 'facing-c-bet'],
    leakOpportunities: [],
    optionLeaks: isError(grade) ? [leak] : [],
    sourceClass: 'SOLVER_VERIFIED',
    result,
  });
  res.json({ ...outcome.result, rangeByClass: Object.fromEntries([...byClass].map(([c, e]) => [c, e.f.map((v) => Math.round((v / e.w) * 1000) / 1000)])), actions: n.actions.map((a) => actionLabel(a, d, potChips)) });
});

/* ------------------------------------------------------------------------------------------------
 * Full-hand simulator integration. A "solver flop" table reproduces the library's exact
 * assumptions (6-max, 1BB big-blind ante, folds to BTN, BTN 2.2BB, SB folds, BB calls, 32BB behind,
 * this exact flop, both hands drawn from the solver's ranges). Only then does the oracle answer;
 * any deviation (other sizes, other streets, other players) falls back to the heuristic model.
 * --------------------------------------------------------------------------------------------- */

const comboKey = (c: string) => [c.slice(0, 2), c.slice(2, 4)].sort().join('');

function makeAction(a: string, d: FlopFile, state: HandState): PlayerAction {
  const p = parseAction(a);
  if (p.kind === 'check' || p.kind === 'call' || p.kind === 'fold') return { type: p.kind };
  const legal = legalActions(state)!;
  const type = legal.canBet ? 'bet' : 'raise';
  if (p.kind === 'allin') return { type, amount: legal.maxRaiseTo };
  return { type, amount: Math.min(legal.maxRaiseTo, Math.round((p.chips! / d.chipsPerBB) * BB)) };
}

function flopNode(d: FlopFile, state: HandState, actorId: string): NodeData | null {
  if (state.street !== 'flop' || state.config.bigBlind !== BB) return null;
  if ([...state.board].sort().join('') !== [...(parseCards(d.flop) as Card[])].sort().join('')) return null;
  const live = state.players.filter((p) => !p.folded).map((p) => p.id).sort().join(',');
  if (live !== 'BB,BTN' || Math.abs(totalPot(state) - d.potBB * BB) > 1) return null;
  const flopActs = state.history.filter((h) => h.street === 'flop' && ['check', 'bet', 'raise', 'call', 'fold'].includes(h.type));
  let name: string | null = null;
  if (flopActs.length === 0 && actorId === 'BB') name = 'oop_root';
  else if (flopActs.length === 1 && flopActs[0]!.type === 'check' && actorId === 'BTN') name = 'ip_vs_check';
  else if (flopActs.length === 2 && flopActs[0]!.type === 'check' && flopActs[1]!.type === 'bet' && actorId === 'BB') name = `oop_vs_bet${Math.round((flopActs[1]!.amount / BB) * d.chipsPerBB)}`;
  return d.nodes.find((n) => n.node === name) ?? null;
}

/** Oracle for one solved flop (null outside the exact solved spots). */
export function postflopOracle(flop: string): SpotOracle {
  const d = load(flop);
  const index = new Map(d.nodes.map((n) => [n.node, new Map(n.hands.map((h) => [comboKey(h.c), h]))]));
  return (state, actorId): OracleNode | null => {
    const n = flopNode(d, state, actorId);
    if (!n) return null;
    const rows = index.get(n.node)!;
    const made = n.actions.map((a) => ({ key: a, make: makeAction(a, d, state) }));
    return {
      source: d.solver,
      label: { en: `Solver-verified: ${d.solver}, exploitability ${d.exploitabilityPctPot}% of the pot (BTN 2.2BB open vs BB call, 1BB BB ante, 32BB, chip EV)`, vi: `Đã kiểm chứng bằng solver: ${d.solver}, độ khai thác ${d.exploitabilityPctPot}% pot (BTN mở 2.2BB, BB theo, ante BB 1BB, 32BB, chip EV)` },
      actions: made,
      noiseBB: 2 * (d.exploitabilityPctPot / 100) * d.potBB,
      strategy: (cards) => {
        const h = rows.get([...cards].sort().join(''));
        return h ? { f: h.f, ev: h.ev } : null;
      },
      matchHero: (a) => {
        let best = -1;
        let bestErr = Infinity;
        made.forEach((m, k) => {
          if (m.make.type !== a.type) return;
          if (a.type !== 'bet' && a.type !== 'raise') {
            best = k;
            bestErr = 0;
            return;
          }
          const err = Math.abs((a.amount ?? 0) - (m.make.amount ?? 0)) / Math.max(1, m.make.amount ?? 1);
          if (err <= 0.15 && err < bestErr) {
            best = k;
            bestErr = err;
          }
        });
        return best;
      },
    };
  };
}

/** Deal a solver-flop hand for Hero at BTN or BB. Hands are drawn from the solver's own ranges. */
export function solverFlopHand(randomInt: (n: number) => number, heroPos?: 'BTN' | 'BB') {
  const flop = FLOPS[randomInt(FLOPS.length)]!;
  const d = load(flop);
  const hero: 'BTN' | 'BB' = heroPos ?? (randomInt(2) ? 'BTN' : 'BB');
  const heroRange = d.nodes.find((n) => n.node === (hero === 'BB' ? 'oop_root' : 'ip_vs_check'))!;
  const villRange = d.nodes.find((n) => n.node === (hero === 'BB' ? 'ip_vs_check' : 'oop_root'))!;
  const flopCards = parseCards(d.flop) as Card[];
  const used = new Set<string>(flopCards);
  const draw = (rows: HandRow[], instructive: boolean): Card[] => {
    let pool = rows.filter((h) => !used.has(h.c.slice(0, 2)) && !used.has(h.c.slice(2, 4)));
    if (instructive) {
      const ins = pool.filter((h) => Math.max(...h.f) < 0.9 || Math.max(...h.ev) - Math.min(...h.ev) >= 0.15);
      if (ins.length && randomInt(100) < 65) pool = ins;
    }
    const total = pool.reduce((s, h) => s + h.w, 0);
    let x = (randomInt(1_000_000) / 1_000_000) * total;
    let pick = pool[pool.length - 1]!;
    for (const h of pool) if ((x -= h.w) <= 0) { pick = h; break; }
    const cards = [pick.c.slice(0, 2), pick.c.slice(2, 4)] as Card[];
    cards.forEach((c) => used.add(c));
    return cards;
  };
  const holes: Record<string, [Card, Card]> = {};
  holes[hero] = draw(heroRange.hands, true) as [Card, Card];
  holes[hero === 'BB' ? 'BTN' : 'BB'] = draw(villRange.hands, false) as [Card, Card];
  const deck = fullDeck().filter((c) => !used.has(c));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  let k = 0;
  for (const p of ['SB', 'UTG', 'HJ', 'CO']) holes[p] = [deck[k++]!, deck[k++]!];
  const deal: SimDeal = { holes, board: [...flopCards, deck[k++]!, deck[k++]!] };
  const config: SimConfig = {
    tableSize: 6,
    heroPos: hero,
    stacksBB: { SB: d.stackBB, BB: d.stackBB + 1, UTG: d.stackBB, HJ: d.stackBB, CO: d.stackBB, BTN: d.stackBB },
    anteMode: 'bigBlind',
    villains: Object.fromEntries(['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'].filter((p) => p !== hero).map((p) => [p, 'tag'])) as SimConfig['villains'],
    chips: { smallBlind: BB / 2, bigBlind: BB, ante: BB },
  };
  const prefix: { playerId: string; action: PlayerAction }[] = [
    { playerId: 'UTG', action: { type: 'fold' } },
    { playerId: 'HJ', action: { type: 'fold' } },
    { playerId: 'CO', action: { type: 'fold' } },
    { playerId: 'BTN', action: { type: 'raise', amount: 2.2 * BB } },
    { playerId: 'SB', action: { type: 'fold' } },
    { playerId: 'BB', action: { type: 'call' } },
  ];
  return { flop, config, deal, prefix, heroClass: classOfCombo(holes[hero][0], holes[hero][1]) };
}
