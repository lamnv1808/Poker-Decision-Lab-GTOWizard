import { L, blinds, defineScenario, seats } from '../helpers';

const MATH_METHOD = L(
  'EVs computed by the app from the stated Villain ranges (seeded Monte Carlo equity, reported error). Exact under the stated assumptions; the ranges themselves are assumptions.',
  'EV do ứng dụng tính từ range giả định của Villain (equity Monte Carlo có seed, có báo sai số). Chính xác theo giả định đã nêu; bản thân range là giả định.',
);

/** Module 04 — Short-stack push/fold. */
export default [
  defineScenario({
    id: 'sb-q9o-10bb-shove-vs-bb',
    version: 1,
    mode: 'hero',
    module: '04',
    title: L('SB Q9o at 10BB: shove or fold?', 'SB Q9o với 10BB: all-in hay bỏ?'),
    summary: L('Folded to Hero in the small blind with 10BB. BB covers.', 'Bỏ bài tới Hero ở SB với 10BB. BB có nhiều chip hơn.'),
    format: { game: 'MTT', stage: 'middle', tableSize: 6 },
    difficulty: 2,
    source: { classification: 'MATH_VERIFIED', method: MATH_METHOD },
    table: {
      ...blinds(1000, 1000),
      players: seats(6, { SB: 10, BB: 25 }, 30, {
        BB: { tendencies: L('Calls shoves with a reasonable, slightly tight range.', 'Theo all-in với range hợp lý, hơi chặt.') },
      }),
      heroPos: 'SB',
      heroCards: 'Qh9c',
    },
    root: 'folds',
    nodes: {
      folds: { kind: 'script', actions: [], next: 'd' },
      d: {
        kind: 'decision',
        prompt: L('Folded to you in the SB. Your action?', 'Bỏ bài tới bạn ở SB. Hành động của bạn?'),
        skills: ['preflop', 'shortStack'],
        concepts: ['push-fold', 'fold-equity'],
        leakOpportunities: ['stackDepthAdjustments'],
        model: { type: 'shove', callers: [{ pos: 'BB', callRange: '22+,A2+,K5s+,K9o+,Q9s+,QJo,JTs' }] },
        options: [
          { id: 'fold', label: L('Fold', 'Bỏ bài'), match: { action: 'fold' }, modelKey: 'fold', feedback: L('Folding forfeits the 0.5BB blind.', 'Bỏ bài mất 0.5BB blind.'), leaks: ['stackDepthAdjustments'] },
          { id: 'limp', label: L('Complete (limp)', 'Bù blind (limp)'), match: { action: 'call' }, grade: 'acceptable', feedback: L('Limping is a real strategy at this depth but is not modeled here.', 'Limp là chiến lược có thật ở độ sâu này nhưng không được mô hình hóa ở đây.'), leaks: [] },
          { id: 'raise', label: L('Raise (not all-in)', 'Tố (không all-in)'), match: { action: 'raise', minBB: 2, maxBB: 9.9 }, grade: 'marginal', feedback: L('Raise-folding 10BB loses fold equity and often commits you anyway.', 'Tố rồi bỏ với 10BB mất fold equity và thường vẫn bị cam kết.') },
          { id: 'shove', label: L('All-in', 'All-in'), match: { action: 'allin' }, modelKey: 'shove', feedback: L('Shoving uses maximum fold equity.', 'All-in tận dụng tối đa fold equity.') },
        ],
        explanation: {
          keyReason: L('BB folds most of its range; when called, Q9o still has meaningful equity.', 'BB bỏ phần lớn range; khi bị theo, Q9o vẫn có equity đáng kể.'),
          lesson: L('At 10BB in the SB, fold equity makes many medium hands profitable shoves.', 'Ở 10BB tại SB, fold equity khiến nhiều tay trung bình all-in có lãi.'),
          gto: L('Equilibrium push/fold charts shove a wide range from the SB at 10BB; this model uses one assumed calling range.', 'Bảng push/fold cân bằng all-in rất rộng từ SB ở 10BB; mô hình này dùng một range theo giả định.'),
          exploit: L('If BB calls much wider than assumed, tighten your shoves; if tighter, shove even wider.', 'Nếu BB theo rộng hơn giả định, hãy chặt lại; nếu chặt hơn, all-in rộng hơn nữa.'),
          ranges: L('Assumed BB call: 22+, A2+, K5s+, K9o+, Q9s+, QJo, JTs.', 'Range theo giả định của BB: 22+, A2+, K5s+, K9o+, Q9s+, QJo, JTs.'),
          assumptions: [L('ChipEV only (no ICM).', 'Chỉ tính ChipEV (không ICM).')],
          commonMistakes: [L('Folding playable hands because "I might get called".', 'Bỏ những tay chơi được vì sợ "bị theo".')],
        },
      },
    },
  }),
  defineScenario({
    id: 'bb-k9o-call-sb-shove-12bb',
    version: 1,
    mode: 'hero',
    module: '04',
    title: L('BB K9o facing a 12BB SB shove', 'BB K9o đối mặt SB all-in 12BB'),
    summary: L('SB shoves 12BB into Hero’s big blind. Call or fold?', 'SB all-in 12BB vào BB của Hero. Theo hay bỏ?'),
    format: { game: 'MTT', stage: 'middle', tableSize: 6 },
    difficulty: 2,
    source: { classification: 'MATH_VERIFIED', method: MATH_METHOD },
    table: {
      ...blinds(1000, 1000),
      players: seats(6, { SB: 12, BB: 30 }, 30, {
        SB: { tendencies: L('Shoves a wide but standard range from the SB.', 'All-in với range rộng nhưng tiêu chuẩn từ SB.') },
      }),
      heroPos: 'BB',
      heroCards: 'Kd9s',
    },
    root: 'sb-shoves',
    nodes: {
      'sb-shoves': { kind: 'script', actions: [{ pos: 'SB', type: 'allin' }], next: 'd' },
      d: {
        kind: 'decision',
        prompt: L('SB shoves 12BB. Your action?', 'SB all-in 12BB. Hành động của bạn?'),
        skills: ['preflop', 'shortStack', 'math'],
        concepts: ['pot-odds', 'calling-ranges'],
        leakOpportunities: ['potOdds'],
        model: { type: 'call', villainPos: 'SB', villainRange: '22+,A2+,K2s+,K7o+,Q5s+,Q9o+,J7s+,J9o+,T7s+,T9o,96s+,86s+,75s+,65s,54s' },
        options: [
          { id: 'fold', label: L('Fold', 'Bỏ bài'), match: { action: 'fold' }, modelKey: 'fold', feedback: L('Folding gives up a getting-a-price spot.', 'Bỏ bài là từ bỏ một tình huống có giá tốt.'), leaks: ['potOdds'] },
          { id: 'call', label: L('Call', 'Theo'), match: { action: 'call' }, modelKey: 'call', feedback: L('Calling uses your pot odds against a wide range.', 'Theo tận dụng pot odds trước một range rộng.'), leaks: ['potOdds'] },
        ],
        explanation: {
          keyReason: L('You need roughly 42% equity; K9o has more than that against a wide SB range.', 'Bạn cần khoảng 42% equity; K9o có nhiều hơn trước range SB rộng.'),
          lesson: L('Compute required equity first: call / (pot before call + call).', 'Tính equity cần thiết trước: số chip theo / (pot trước khi theo + số chip theo).'),
          gto: L('Calling ranges vs wide SB shoves are wide; this model uses one assumed shoving range.', 'Range theo trước SB all-in rộng cũng rộng; mô hình dùng một range all-in giả định.'),
          exploit: L('Against a tight shover (only premiums), K9o becomes a fold.', 'Gặp người all-in chặt (chỉ bài mạnh), K9o thành bỏ.'),
          ranges: L('Assumed SB shove: 22+, A2+, K2s+, K7o+, Q5s+, Q9o+, J7s+, J9o+, T7s+, T9o, 96s+, 86s+, 75s+, 65s, 54s.', 'Range all-in giả định của SB: 22+, A2+, K2s+, K7o+, Q5s+, Q9o+, J7s+, J9o+, T7s+, T9o, 96s+, 86s+, 75s+, 65s, 54s.'),
          assumptions: [L('ChipEV only (no ICM).', 'Chỉ tính ChipEV (không ICM).')],
          commonMistakes: [L('Comparing equity to 50% instead of to the pot-odds requirement.', 'So sánh equity với 50% thay vì với yêu cầu pot odds.')],
        },
      },
    },
  }),
];
