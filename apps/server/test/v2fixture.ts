import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditHand, snapshotForHeroAction } from '@pdl/core';

/**
 * Builds a tiny Real Hand Source v2 directory from the anonymised real-hand fixtures.
 * Decision snapshots are filled from the engine (as a correct supplier would), except one
 * deliberately wrong call amount and the supplier's whole-pot pot-odds formula — so the import
 * must quarantine exactly those.
 */
export function buildV2Fixture(): { dir: string; expected: { hands: number; decisions: number } } {
  const text = readFileSync(new URL('../../../packages/core/test/fixtures/real-anon.txt', import.meta.url), 'utf8');
  const parts = text.split(/^# fixture: /m).filter((x) => x.trim()).map((c) => { const [tag, ...rest] = c.split('\n'); return { tag: tag!.trim(), raw: rest.join('\n').trim() }; });
  const raws = parts.map((p) => p.raw);
  const shortBB = parts.find((p) => p.tag === 'shortBigBlindCall')!.raw;
  const dir = join(tmpdir(), `v2fx-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const hands: string[] = [];
  const decisions: string[] = [];
  const quizzes: string[] = [];
  let nd = 0;
  for (const raw of raws) {
    const a = auditHand(raw);
    const id = /Poker Hand #(\w+)/.exec(raw)![1]!;
    hands.push(JSON.stringify({ hand_id: id, archive: 'fixture.zip', member: 'fixture.txt', raw }));
    if (!a.rec) continue;
    const heroActs = a.rec.parsed.actions.filter((x) => x.player === 'Hero');
    heroActs.forEach((act, k) => {
      const snap = snapshotForHeroAction(a.rec!, k + 1)!;
      const bb = a.rec!.parsed.bigBlind;
      const wrongCall = raw === shortBB && k === 0; // short-BB spot: supplier-style call amount
      const q = {
        hero_cards: a.rec!.parsed.heroCards,
        board: snap.state.board,
        button_seat: 1,
        pot_at_decision_bb: snap.potBB,
        call_bb: wrongCall ? 13173 / 16000 : snap.callAmountBB,
        players: [{ id: 'Hero', initial_bb: 0, remaining_bb: snap.state.players.find((p) => p.id === 'Hero')!.stack / bb, invested_street_bb: 0, active: true }],
        history: [],
      };
      const map: Record<string, string> = { call: 'calls', bet: 'bets', raise: 'raises', check: 'checks', fold: 'folds' };
      decisions.push(JSON.stringify({ id: `${id}-${k + 1}`, family_id: id, street: snap.state.street, tags: act.allIn ? ['hero_all_in'] : [], solver_verified: false, grading_status: 'unreviewed', question: q, review_only: { actual_action: map[act.type], actual_increment_bb: act.amount / bb, is_all_in: act.allIn }, answer: null }));
      nd++;
      if (snap.callAmountBB > 0) quizzes.push(JSON.stringify({ id: `${id}-${k + 1}-odds`, family_id: id, question: q, answer: { required_equity: snap.callAmountBB / (snap.potBB + snap.callAmountBB), formula: 'call / (pot_at_decision + call)', scope: 'x' }, solver_verified: false }));
    });
  }
  writeFileSync(join(dir, 'hands.jsonl'), hands.join('\n') + '\n');
  writeFileSync(join(dir, 'decisions.jsonl'), decisions.join('\n') + '\n');
  writeFileSync(join(dir, 'pot_odds_quizzes.jsonl'), quizzes.join('\n') + '\n');
  return { dir, expected: { hands: raws.length, decisions: nd } };
}
