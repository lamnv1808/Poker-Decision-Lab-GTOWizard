import { L, blinds, defineScenario, seats } from '../helpers';
import type { ScenarioInput } from '../../scenario/schema';

/** Pack A — preflop / short stack / PKO / ICM (modules 02, 03, 04, 05, 14, 15, 16). */

const MATH_METHOD = L(
  'EVs computed by the app from the stated Villain ranges (seeded Monte Carlo equity, reported error). Exact under the stated assumptions; the ranges themselves are assumptions.',
  'EV do ứng dụng tính từ range giả định của Villain (equity Monte Carlo có seed, có báo sai số). Chính xác theo giả định đã nêu; bản thân range là giả định.',
);

const ICM_METHOD = L(
  'Expected prize share computed by the app with the Independent Chip Model (Malmuth–Harville) over every all-in outcome, using the stated Villain ranges and the listed payouts. ICM is a model: it ignores skill, position and future blinds.',
  'Phần giải thưởng kỳ vọng do ứng dụng tính bằng mô hình ICM (Malmuth–Harville) trên mọi kết quả all-in, dùng range giả định của Villain và cơ cấu giải thưởng đã nêu. ICM là một mô hình: nó bỏ qua kỹ năng, vị trí và blind tương lai.',
);

const PKO_METHOD = L(
  'ChipEV computed by the app from the stated Villain ranges, with the bounty converted to a fixed chip-equivalent (bounty cash × total chips ÷ remaining prize pool). A simplified teaching model: no ICM, no future bounty growth.',
  'ChipEV do ứng dụng tính từ range giả định của Villain, với bounty quy đổi thành lượng chip cố định (tiền bounty × tổng chip ÷ quỹ thưởng còn lại). Mô hình giảng dạy đơn giản: không ICM, không tính bounty tăng trong tương lai.',
);

const HEURISTIC_METHOD = L(
  'Coach-authored guidance based on widely published MTT principles; no solver output. Practice only — does not affect ratings.',
  'Hướng dẫn do người soạn dựa trên nguyên tắc MTT phổ biến; không phải kết quả solver. Chỉ để luyện tập — không ảnh hưởng xếp hạng.',
);

/** Shared PKO tournament: 200 entries × 20,000 chips = 4,000,000 chips; $10,000 left in the prize pool (incl. bounties). */
const PKO_TOURNAMENT = {
  playersLeft: 38,
  prizePoolRemaining: 10000,
  note: L(
    '200 entries × 20,000 starting chips = 4,000,000 chips in play; $10,000 remains in the prize pool (regular prizes + bounties). Progressive KO: when you bust a player you receive half of their displayed bounty in cash.',
    '200 lượt tham gia × 20.000 chip khởi điểm = 4.000.000 chip trong giải; còn $10.000 trong quỹ thưởng (giải thưởng thường + bounty). PKO lũy tiến: khi loại một người, bạn nhận ngay một nửa bounty hiển thị của họ bằng tiền mặt.',
  ),
};

const scenarios: ScenarioInput[] = [
  // ───────────────────────────── Module 04 — push/fold shoves ─────────────────────────────
  defineScenario({
    id: 'btn-a7o-12bb-shove-two-blinds',
    version: 1,
    mode: 'hero',
    module: '04',
    title: L('BTN A7o at 12BB: shove into both blinds?', 'BTN A7o với 12BB: all-in vào hai blind?'),
    summary: L('Folded to Hero on the button with 12BB at an 8-max table. Both blinds cover.', 'Bỏ bài tới Hero ở BTN với 12BB tại bàn 8 người. Cả hai blind đều nhiều chip hơn.'),
    format: { game: 'MTT', stage: 'middle', tableSize: 8 },
    difficulty: 1,
    source: { classification: 'MATH_VERIFIED', method: MATH_METHOD },
    table: {
      ...blinds(1000, 1000),
      players: seats(8, { BTN: 12, SB: 30, BB: 25 }, 28, {
        SB: { tendencies: L('Solid regular; calls shoves fairly tightly from the SB.', 'Người chơi chắc tay; theo all-in khá chặt từ SB.') },
        BB: { tendencies: L('Defends the big blind against shoves with a standard range.', 'Phòng thủ BB trước all-in với range tiêu chuẩn.') },
      }),
      heroPos: 'BTN',
      heroCards: 'Ad7c',
    },
    root: 'folds',
    nodes: {
      folds: { kind: 'script', actions: [], next: 'd' },
      d: {
        kind: 'decision',
        prompt: L('Folded to you on the button with 12BB. Your action?', 'Bỏ bài tới bạn ở BTN với 12BB. Hành động của bạn?'),
        skills: ['preflop', 'shortStack'],
        concepts: ['push-fold', 'fold-equity', 'multiple-callers'],
        leakOpportunities: ['stackDepthAdjustments'],
        model: {
          type: 'shove',
          callers: [
            { pos: 'SB', callRange: '22+,A7+,KTs+,KQo' },
            { pos: 'BB', callRange: '22+,A4+,K9s+,KTo+,QTs+,QJo' },
          ],
        },
        options: [
          { id: 'fold', label: L('Fold', 'Bỏ bài'), match: { action: 'fold' }, modelKey: 'fold', feedback: L('Folding passes up a spot where both blinds fold most of the time.', 'Bỏ bài là bỏ qua tình huống mà hai blind bỏ bài phần lớn thời gian.'), leaks: ['stackDepthAdjustments'] },
          { id: 'raise', label: L('Raise (not all-in)', 'Tố (không all-in)'), match: { action: 'raise', minBB: 2, maxBB: 11.9 }, grade: 'acceptable', feedback: L('A small raise can work, but at 12BB it often leaves you raise-folding or committed; not modeled here.', 'Tố nhỏ có thể dùng, nhưng ở 12BB thường khiến bạn phải tố rồi bỏ hoặc bị cam kết; không được mô hình hóa ở đây.') },
          { id: 'shove', label: L('All-in', 'All-in'), match: { action: 'allin' }, modelKey: 'shove', feedback: L('Shoving collects the blinds and antes often and keeps decent equity when called.', 'All-in thường xuyên lấy được blind và ante, và vẫn có equity khá khi bị theo.') },
        ],
        explanation: {
          keyReason: L(
            'The pot is 2.5BB before you act. Both blinds must fold for you to win it uncontested, and against these assumed calling ranges they do so most of the time; when called, A7o is rarely crushed.',
            'Pot là 2.5BB trước khi bạn hành động. Cả hai blind phải bỏ thì bạn mới ăn pot, và với range theo giả định họ bỏ phần lớn thời gian; khi bị theo, A7o hiếm khi bị áp đảo hoàn toàn.',
          ),
          lesson: L('With two players left to act, multiply their fold probabilities: fold equity shrinks with each extra caller, but from the button only the blinds remain.', 'Với hai người còn lại, nhân xác suất bỏ bài của họ: fold equity giảm theo mỗi người có thể theo, nhưng từ BTN chỉ còn hai blind.'),
          gto: L('Equilibrium push/fold charts shove all aces from the button at 12BB; this model uses assumed calling ranges, not a solver.', 'Bảng push/fold cân bằng all-in mọi lá A từ BTN ở 12BB; mô hình này dùng range theo giả định, không phải solver.'),
          exploit: L('If the blinds call much wider (e.g. any ace, any king), A7o is still fine; weaker hands should tighten up.', 'Nếu blind theo rộng hơn nhiều (mọi lá A, mọi lá K), A7o vẫn ổn; các tay yếu hơn nên chặt lại.'),
          ranges: L(
            'Assumed SB call: 22+, A7+, KTs+, KQo. Assumed BB call: 22+, A4+, K9s+, KTo+, QTs+, QJo. These are assumptions, not observed ranges.',
            'Range theo giả định của SB: 22+, A7+, KTs+, KQo. Của BB: 22+, A4+, K9s+, KTo+, QTs+, QJo. Đây là giả định, không phải range quan sát được.',
          ),
          assumptions: [L('ChipEV only (no ICM). BB ante of 1BB is in the pot.', 'Chỉ tính ChipEV (không ICM). Ante BB 1BB đã có trong pot.')],
          commonMistakes: [L('Min-raising 12BB and then folding to a re-shove.', 'Min-raise với 12BB rồi bỏ bài khi bị all-in lại.')],
        },
      },
    },
  }),

  defineScenario({
    id: 'co-k8o-9bb-shove-three-behind',
    version: 1,
    mode: 'hero',
    module: '04',
    title: L('CO K8o at 9BB with three players behind', 'CO K8o với 9BB, còn ba người phía sau'),
    summary: L('Folded to Hero in the cutoff at a 9-max table with 9BB. Button and both blinds cover.', 'Bỏ bài tới Hero ở CO tại bàn 9 người với 9BB. BTN và hai blind đều nhiều chip hơn.'),
    format: { game: 'MTT', stage: 'middle', tableSize: 9 },
    difficulty: 3,
    source: { classification: 'MATH_VERIFIED', method: MATH_METHOD },
    table: {
      ...blinds(2000, 2000),
      players: seats(9, { CO: 9, BTN: 24, SB: 18, BB: 31 }, 25),
      heroPos: 'CO',
      heroCards: 'Kh8d',
    },
    root: 'folds',
    nodes: {
      folds: { kind: 'script', actions: [], next: 'd' },
      d: {
        kind: 'decision',
        prompt: L('Folded to you in the cutoff with 9BB. Your action?', 'Bỏ bài tới bạn ở CO với 9BB. Hành động của bạn?'),
        skills: ['preflop', 'shortStack'],
        concepts: ['push-fold', 'fold-equity', 'multiple-callers'],
        leakOpportunities: ['stackDepthAdjustments'],
        model: {
          type: 'shove',
          callers: [
            { pos: 'BTN', callRange: '22+,A8+,KJs+,KQo' },
            { pos: 'SB', callRange: '22+,A7+,KTs+,KJo+' },
            { pos: 'BB', callRange: '22+,A2+,K8s+,KTo+,QTs+,QJo' },
          ],
        },
        options: [
          { id: 'fold', label: L('Fold', 'Bỏ bài'), match: { action: 'fold' }, modelKey: 'fold', feedback: L('Folding keeps your 9BB but gives up a modestly profitable steal.', 'Bỏ bài giữ 9BB nhưng bỏ qua một lần cướp blind có lãi vừa phải.'), leaks: ['stackDepthAdjustments'] },
          { id: 'raise', label: L('Raise (not all-in)', 'Tố (không all-in)'), match: { action: 'raise', minBB: 2, maxBB: 8.9 }, grade: 'marginal', feedback: L('At 9BB a non-all-in raise commits you while giving opponents a cheap chance to re-shove.', 'Ở 9BB, tố không all-in khiến bạn bị cam kết trong khi cho đối thủ cơ hội all-in lại rẻ.') },
          { id: 'shove', label: L('All-in', 'All-in'), match: { action: 'allin' }, modelKey: 'shove', feedback: L('Shoving takes the 2.5BB pot often enough to profit even with three players behind.', 'All-in lấy pot 2.5BB đủ thường xuyên để có lãi dù còn ba người phía sau.') },
        ],
        explanation: {
          keyReason: L(
            'The pot is already 2.5BB (blinds plus a 1BB BB-ante) — over a quarter of your stack. Three players must fold, but each calls only with a fairly narrow range, so the steal succeeds about half the time and K8o keeps roughly a third of the pot when called. The edge is modest, not huge.',
            'Pot đã là 2.5BB (blind cộng ante BB 1BB) — hơn một phần tư stack của bạn. Ba người phải bỏ bài, nhưng mỗi người chỉ theo với range khá hẹp nên cú cướp blind thành công khoảng một nửa số lần và K8o vẫn giữ khoảng một phần ba equity khi bị theo. Lợi thế ở mức vừa phải, không lớn.',
          ),
          lesson: L('Big antes make short-stack steals much more valuable; count how big the pot is relative to your stack.', 'Ante lớn khiến cướp blind với stack ngắn đáng giá hơn nhiều; hãy so sánh pot với stack của bạn.'),
          gto: L('Published push/fold charts include most kings from the cutoff at 9BB with antes; this model uses assumed calling ranges only.', 'Bảng push/fold công bố bao gồm phần lớn Kx từ CO ở 9BB có ante; mô hình này chỉ dùng range theo giả định.'),
          exploit: L('If the button is a loose caller, tighten your weakest shoves; if the table is passive, shove wider.', 'Nếu BTN theo lỏng, hãy chặt lại những tay all-in yếu nhất; nếu bàn thụ động, all-in rộng hơn.'),
          ranges: L(
            'Assumed calls — BTN: 22+, A8+, KJs+, KQo. SB: 22+, A7+, KTs+, KJo+. BB: 22+, A2+, K8s+, KTo+, QTs+, QJo. Stated assumptions; callers are modeled one at a time in action order.',
            'Range theo giả định — BTN: 22+, A8+, KJs+, KQo. SB: 22+, A7+, KTs+, KJo+. BB: 22+, A2+, K8s+, KTo+, QTs+, QJo. Đây là giả định; người theo được mô hình hóa lần lượt theo thứ tự hành động.',
          ),
          assumptions: [L('ChipEV only (no ICM).', 'Chỉ tính ChipEV (không ICM).')],
          commonMistakes: [L('Waiting for a "better spot" while antes and blinds erode a 9BB stack.', 'Chờ "cơ hội tốt hơn" trong khi ante và blind bào mòn stack 9BB.')],
        },
      },
    },
  }),

  defineScenario({
    id: 'btn-t6o-15bb-shove-or-fold',
    version: 1,
    mode: 'hero',
    module: '04',
    title: L('BTN T6o at 15BB: is it a shove?', 'BTN T6o với 15BB: có nên all-in?'),
    summary: L('Folded to Hero on the button with 15BB at a 6-max table. Blinds are attentive regulars.', 'Bỏ bài tới Hero ở BTN với 15BB tại bàn 6 người. Hai blind là người chơi thường xuyên, tỉnh táo.'),
    format: { game: 'MTT', stage: 'middle', tableSize: 6 },
    difficulty: 3,
    source: { classification: 'MATH_VERIFIED', method: MATH_METHOD },
    table: {
      ...blinds(1000, 1000),
      players: seats(6, { BTN: 15, SB: 40, BB: 35 }, 30, {
        SB: { tendencies: L('Calls shoves wider than average from the SB.', 'Theo all-in rộng hơn trung bình từ SB.') },
        BB: { tendencies: L('Calls shoves wide when getting a price.', 'Theo all-in rộng khi được giá tốt.') },
      }),
      heroPos: 'BTN',
      heroCards: 'Td6c',
    },
    root: 'folds',
    nodes: {
      folds: { kind: 'script', actions: [], next: 'd' },
      d: {
        kind: 'decision',
        prompt: L('Folded to you on the button with 15BB. Your action?', 'Bỏ bài tới bạn ở BTN với 15BB. Hành động của bạn?'),
        skills: ['preflop', 'shortStack'],
        concepts: ['push-fold', 'fold-equity', 'stack-depth'],
        leakOpportunities: ['excessivePreflopAllIns', 'stackDepthAdjustments'],
        model: {
          type: 'shove',
          callers: [
            { pos: 'SB', callRange: '22+,A2+,K9+,QTs+,QJo' },
            { pos: 'BB', callRange: '22+,A2+,K7+,Q9s+,QTo+,J9s+,JTo,T9s' },
          ],
        },
        options: [
          { id: 'fold', label: L('Fold', 'Bỏ bài'), match: { action: 'fold' }, modelKey: 'fold', feedback: L('Folding a weak offsuit hand at 15BB against wide callers is disciplined.', 'Bỏ một tay rời chất yếu ở 15BB trước người theo rộng là kỷ luật.'), leaks: [] },
          { id: 'raise', label: L('Raise (not all-in)', 'Tố (không all-in)'), match: { action: 'raise', minBB: 2, maxBB: 14.9 }, grade: 'acceptable', feedback: L('A small steal with T6o is a reasonable alternative at 15BB, but it is not modeled here.', 'Cướp blind nhỏ với T6o là lựa chọn hợp lý ở 15BB, nhưng không được mô hình hóa ở đây.') },
          { id: 'shove', label: L('All-in', 'All-in'), match: { action: 'allin' }, modelKey: 'shove', feedback: L('15BB is a lot to risk with T6o when both blinds call wide.', '15BB là quá nhiều để mạo hiểm với T6o khi cả hai blind theo rộng.'), leaks: ['excessivePreflopAllIns'] },
        ],
        explanation: {
          keyReason: L(
            'At 15BB you risk six times the pot. These blinds call often, and T6o is behind almost every calling hand, so the shove does not win enough uncontested pots to pay for the times it is called.',
            'Ở 15BB bạn mạo hiểm gấp sáu lần pot. Hai blind này theo thường xuyên, và T6o thua gần như mọi tay theo, nên all-in không ăn đủ pot để bù cho những lần bị theo.',
          ),
          lesson: L('Shoving ranges shrink as stacks get deeper and as callers get looser. Fold equity is not automatic.', 'Range all-in thu hẹp khi stack sâu hơn và khi người theo lỏng hơn. Fold equity không tự nhiên mà có.'),
          gto: L('Equilibrium charts treat weak offsuit hands as borderline at 15BB from the button; against looser-than-equilibrium callers they become folds. No solver output is claimed here.', 'Bảng cân bằng coi các tay rời chất yếu là ranh giới ở 15BB từ BTN; trước người theo lỏng hơn mức cân bằng chúng trở thành bỏ bài. Không trích dẫn kết quả solver ở đây.'),
          exploit: L('Against tight, fold-prone blinds this hand can become a shove; re-run the logic with their real calling ranges.', 'Gặp blind chặt, hay bỏ bài, tay này có thể thành all-in; hãy tính lại với range theo thực tế của họ.'),
          ranges: L(
            'Assumed SB call: 22+, A2+, K9+, QTs+, QJo. Assumed BB call: 22+, A2+, K7+, Q9s+, QTo+, J9s+, JTo, T9s. Deliberately wider than a tight regular — stated assumptions.',
            'Range theo giả định của SB: 22+, A2+, K9+, QTs+, QJo. Của BB: 22+, A2+, K7+, Q9s+, QTo+, J9s+, JTo, T9s. Cố ý rộng hơn người chơi chặt — đây là giả định.',
          ),
          assumptions: [L('ChipEV only (no ICM).', 'Chỉ tính ChipEV (không ICM).')],
          commonMistakes: [L('Applying 8–10BB shoving ranges at 15BB.', 'Áp dụng range all-in của 8–10BB khi có 15BB.')],
        },
      },
    },
  }),

  defineScenario({
    id: 'sb-72o-6bb-shove-vs-bb',
    version: 1,
    mode: 'hero',
    module: '04',
    title: L('SB 7-2 offsuit at 6BB', 'SB 7-2 rời chất với 6BB'),
    summary: L('Folded to Hero in the small blind with 6BB. The big blind covers and calls fairly wide.', 'Bỏ bài tới Hero ở SB với 6BB. BB nhiều chip hơn và theo khá rộng.'),
    format: { game: 'Turbo', stage: 'middle', tableSize: 8 },
    difficulty: 2,
    source: { classification: 'MATH_VERIFIED', method: MATH_METHOD },
    table: {
      ...blinds(1000, 1000),
      players: seats(8, { SB: 6, BB: 22 }, 25),
      heroPos: 'SB',
      heroCards: '7s2d',
    },
    root: 'folds',
    nodes: {
      folds: { kind: 'script', actions: [], next: 'd' },
      d: {
        kind: 'decision',
        prompt: L('Folded to you in the SB with 6BB. Your action?', 'Bỏ bài tới bạn ở SB với 6BB. Hành động của bạn?'),
        skills: ['preflop', 'shortStack', 'math'],
        concepts: ['push-fold', 'fold-equity', 'any-two'],
        leakOpportunities: ['stackDepthAdjustments'],
        model: { type: 'shove', callers: [{ pos: 'BB', callRange: '22+,A2+,K2+,Q5s+,Q8o+,J7s+,J9o+,T7s+,T9o,97s+,87s' }] },
        options: [
          { id: 'fold', label: L('Fold', 'Bỏ bài'), match: { action: 'fold' }, modelKey: 'fold', feedback: L('Folding loses your 0.5BB and leaves you with an even shorter stack.', 'Bỏ bài mất 0.5BB và khiến stack của bạn còn ngắn hơn.'), leaks: ['stackDepthAdjustments'] },
          { id: 'limp', label: L('Complete (limp)', 'Bù blind (limp)'), match: { action: 'call' }, grade: 'marginal', feedback: L('Limping 72o invites a raise you must fold; it is not modeled here.', 'Limp với 72o mời BB tố và bạn phải bỏ; không được mô hình hóa ở đây.') },
          { id: 'shove', label: L('All-in', 'All-in'), match: { action: 'allin' }, modelKey: 'shove', feedback: L('Even the worst hand has enough fold equity plus equity at 6BB.', 'Ngay cả tay tệ nhất cũng có đủ fold equity cộng equity ở 6BB.') },
        ],
        explanation: {
          keyReason: L(
            'You risk 5.5 more BB to win a 2.5BB pot. BB folds a large part of its hands, and even when called 72o has roughly 30% equity — enough to make shoving better than folding here.',
            'Bạn mạo hiểm thêm 5.5BB để thắng pot 2.5BB. BB bỏ phần lớn các tay, và kể cả khi bị theo 72o vẫn có khoảng 30% equity — đủ để all-in tốt hơn bỏ bài ở đây.',
          ),
          lesson: L('At very short stacks in the SB, the blinds and ante are worth so much relative to your stack that almost any two cards are a shove.', 'Với stack rất ngắn ở SB, blind và ante đáng giá nhiều so với stack nên gần như mọi tay đều nên all-in.'),
          gto: L('Equilibrium SB push/fold charts at 6BB shove close to 100% of hands; this model uses one assumed BB calling range.', 'Bảng push/fold cân bằng từ SB ở 6BB all-in gần 100% tay; mô hình này dùng một range theo giả định của BB.'),
          exploit: L('If BB calls with nearly any two cards, the very worst hands become close; tighten only against such a caller.', 'Nếu BB theo gần như mọi tay, những tay tệ nhất trở nên sát nút; chỉ chặt lại với người theo như vậy.'),
          ranges: L(
            'Assumed BB call: 22+, A2+, K2+, Q5s+, Q8o+, J7s+, J9o+, T7s+, T9o, 97s+, 87s. A wide but not any-two range — stated assumption.',
            'Range theo giả định của BB: 22+, A2+, K2+, Q5s+, Q8o+, J7s+, J9o+, T7s+, T9o, 97s+, 87s. Rộng nhưng không phải mọi tay — đây là giả định.',
          ),
          assumptions: [L('ChipEV only (no ICM).', 'Chỉ tính ChipEV (không ICM).')],
          commonMistakes: [L('Folding the SB at 6BB because the hand "looks bad".', 'Bỏ bài ở SB với 6BB chỉ vì tay bài "trông tệ".')],
        },
      },
    },
  }),

  // ───────────────────────────── Calling shoves (modules 04 / 05) ─────────────────────────────
  defineScenario({
    id: 'bb-a4o-call-btn-10bb-shove',
    version: 1,
    mode: 'hero',
    module: '05',
    title: L('BB A4o facing a 10BB button shove', 'BB A4o đối mặt BTN all-in 10BB'),
    summary: L('The button shoves 10BB, SB folds. Hero has A4o in the big blind and covers.', 'BTN all-in 10BB, SB bỏ. Hero có A4o ở BB và nhiều chip hơn.'),
    format: { game: 'MTT', stage: 'middle', tableSize: 6 },
    difficulty: 2,
    source: { classification: 'MATH_VERIFIED', method: MATH_METHOD },
    table: {
      ...blinds(1000, 1000),
      players: seats(6, { BTN: 10, BB: 28 }, 30, {
        BTN: { tendencies: L('Shoves a wide, chart-like range when folded to.', 'All-in với range rộng theo bảng khi được bỏ tới.') },
      }),
      heroPos: 'BB',
      heroCards: 'Ac4h',
    },
    root: 'btn-shoves',
    nodes: {
      'btn-shoves': { kind: 'script', actions: [{ pos: 'BTN', type: 'allin' }], next: 'd' },
      d: {
        kind: 'decision',
        prompt: L('BTN shoves 10BB, SB folds. Your action?', 'BTN all-in 10BB, SB bỏ. Hành động của bạn?'),
        skills: ['preflop', 'shortStack', 'math'],
        concepts: ['pot-odds', 'calling-ranges'],
        leakOpportunities: ['potOdds'],
        model: { type: 'call', villainPos: 'BTN', villainRange: '22+,A2+,K5s+,K9o+,Q8s+,QTo+,J8s+,JTo,T8s+,98s,87s,76s' },
        options: [
          { id: 'fold', label: L('Fold', 'Bỏ bài'), match: { action: 'fold' }, modelKey: 'fold', feedback: L('Folding gives up a call that the price clearly supports.', 'Bỏ bài là từ bỏ một lần theo mà giá pot ủng hộ rõ ràng.'), leaks: ['potOdds'] },
          { id: 'call', label: L('Call', 'Theo'), match: { action: 'call' }, modelKey: 'call', feedback: L('Calling uses your pot odds against a wide button range.', 'Theo tận dụng pot odds trước range rộng của BTN.') },
        ],
        explanation: {
          keyReason: L(
            'You call 9BB to win a 12.5BB pot, so you need 9 / 21.5 ≈ 42% equity. Against a wide button range, any ace — even A4o — has more than that.',
            'Bạn theo 9BB để thắng pot 12.5BB, nên cần 9 / 21.5 ≈ 42% equity. Trước range rộng của BTN, mọi lá A — kể cả A4o — đều có nhiều hơn.',
          ),
          lesson: L('Required equity = amount to call ÷ (pot after your call). Compare that to your equity versus the shoving range, not versus the top of it.', 'Equity cần thiết = số chip phải theo ÷ (pot sau khi theo). So với equity của bạn trước toàn bộ range all-in, không chỉ phần mạnh nhất.'),
          gto: L('Equilibrium BB calling ranges versus a 10BB button shove include all aces; this model uses one assumed shoving range.', 'Range theo cân bằng của BB trước BTN all-in 10BB bao gồm mọi lá A; mô hình dùng một range all-in giả định.'),
          exploit: L('If this button only shoves premiums, A4o becomes a fold. Adjust to the actual range.', 'Nếu BTN này chỉ all-in bài mạnh, A4o thành bỏ bài. Điều chỉnh theo range thực tế.'),
          ranges: L(
            'Assumed BTN shove: 22+, A2+, K5s+, K9o+, Q8s+, QTo+, J8s+, JTo, T8s+, 98s, 87s, 76s.',
            'Range all-in giả định của BTN: 22+, A2+, K5s+, K9o+, Q8s+, QTo+, J8s+, JTo, T8s+, 98s, 87s, 76s.',
          ),
          assumptions: [L('ChipEV only (no ICM). Pot includes the 1BB BB ante.', 'Chỉ tính ChipEV (không ICM). Pot bao gồm ante BB 1BB.')],
          commonMistakes: [L('Folding weak aces because "I am probably dominated".', 'Bỏ các lá A yếu vì nghĩ "chắc bị áp đảo".')],
        },
      },
    },
  }),

  defineScenario({
    id: 'bb-k6o-fold-vs-utg1-15bb-shove',
    version: 1,
    mode: 'hero',
    module: '04',
    title: L('BB K6o vs an early-position 15BB shove', 'BB K6o trước all-in 15BB từ vị trí sớm'),
    summary: L('UTG1 shoves 15BB at an 8-max table; everyone folds to Hero in the big blind.', 'UTG1 all-in 15BB tại bàn 8 người; mọi người bỏ tới Hero ở BB.'),
    format: { game: 'MTT', stage: 'middle', tableSize: 8 },
    difficulty: 2,
    source: { classification: 'MATH_VERIFIED', method: MATH_METHOD },
    table: {
      ...blinds(1000, 1000),
      players: seats(8, { UTG1: 15, BB: 32 }, 26, {
        UTG1: { tendencies: L('Tight; shoves only strong hands from early position.', 'Chặt; chỉ all-in bài mạnh từ vị trí sớm.') },
      }),
      heroPos: 'BB',
      heroCards: 'Ks6d',
    },
    root: 'utg1-shoves',
    nodes: {
      'utg1-shoves': { kind: 'script', actions: [{ pos: 'UTG1', type: 'allin' }], next: 'd' },
      d: {
        kind: 'decision',
        prompt: L('UTG1 shoves 15BB, folded to you. Your action?', 'UTG1 all-in 15BB, bỏ tới bạn. Hành động của bạn?'),
        skills: ['preflop', 'shortStack', 'math'],
        concepts: ['pot-odds', 'calling-ranges', 'range-strength'],
        leakOpportunities: ['potOdds'],
        model: { type: 'call', villainPos: 'UTG1', villainRange: '55+,A9s+,ATo+,KJs+,KQo' },
        options: [
          { id: 'fold', label: L('Fold', 'Bỏ bài'), match: { action: 'fold' }, modelKey: 'fold', feedback: L('Correct: the price is decent but K6o is crushed by a tight early range.', 'Đúng: giá khá tốt nhưng K6o bị áp đảo bởi range chặt từ vị trí sớm.') },
          { id: 'call', label: L('Call', 'Theo'), match: { action: 'call' }, modelKey: 'call', feedback: L('Getting a price does not help when your equity is far below what you need.', 'Được giá không giúp gì khi equity của bạn thấp hơn nhiều so với mức cần.'), leaks: ['potOdds'] },
        ],
        explanation: {
          keyReason: L(
            'You call 14BB to win a 17.5BB pot, needing 14 / 31.5 ≈ 44% equity. K6o has far less against a range of pairs and big aces/kings.',
            'Bạn theo 14BB để thắng pot 17.5BB, cần 14 / 31.5 ≈ 44% equity. K6o có ít hơn nhiều trước range gồm đôi và A/K lớn.',
          ),
          lesson: L('Pot odds set the bar; the shover’s range decides whether you clear it. Early-position shoves are much stronger than button shoves.', 'Pot odds đặt ra ngưỡng; range của người all-in quyết định bạn có vượt qua không. All-in từ vị trí sớm mạnh hơn nhiều so với từ BTN.'),
          gto: L('Equilibrium calling ranges versus early-position shoves are tight; this model uses one assumed shoving range.', 'Range theo cân bằng trước all-in vị trí sớm rất chặt; mô hình dùng một range all-in giả định.'),
          exploit: L('Only against a player shoving far wider than assumed would K6o approach a call.', 'Chỉ khi người chơi all-in rộng hơn nhiều so với giả định thì K6o mới gần mức theo được.'),
          ranges: L('Assumed UTG1 shove: 55+, A9s+, ATo+, KJs+, KQo.', 'Range all-in giả định của UTG1: 55+, A9s+, ATo+, KJs+, KQo.'),
          assumptions: [L('ChipEV only (no ICM).', 'Chỉ tính ChipEV (không ICM).')],
          commonMistakes: [L('Calling because "I already have 1BB in" or "it is only 14 more".', 'Theo vì "đã bỏ 1BB vào rồi" hoặc "chỉ thêm 14BB".')],
        },
      },
    },
  }),

  // ───────────────────────────── Heuristic preflop: opening, 3-bet, 4-bet, BB defense ─────────────────────────────
  defineScenario({
    id: 'utg1-kto-25bb-open-or-fold',
    version: 1,
    mode: 'hero',
    module: '02',
    title: L('UTG+1 KTo at 25BB, 9-handed', 'UTG+1 KTo với 25BB, bàn 9 người'),
    summary: L('UTG folds. Hero is next with KTo and 25BB at a full 9-max table.', 'UTG bỏ. Hero kế tiếp với KTo và 25BB tại bàn đủ 9 người.'),
    format: { game: 'MTT', stage: 'middle', tableSize: 9 },
    difficulty: 1,
    source: { classification: 'HEURISTIC', method: HEURISTIC_METHOD },
    table: {
      ...blinds(1000, 1000),
      players: seats(9, { UTG1: 25 }, 35),
      heroPos: 'UTG1',
      heroCards: 'KcTd',
    },
    root: 'utg-folds',
    nodes: {
      'utg-folds': { kind: 'script', actions: [{ pos: 'UTG', type: 'fold' }], next: 'd' },
      d: {
        kind: 'decision',
        prompt: L('UTG folds. Your action with KTo?', 'UTG bỏ. Hành động của bạn với KTo?'),
        skills: ['preflop'],
        concepts: ['opening-ranges', 'position'],
        leakOpportunities: ['excessivePreflopAllIns'],
        options: [
          { id: 'fold', label: L('Fold', 'Bỏ bài'), match: { action: 'fold' }, grade: 'excellent', feedback: L('Right: with seven players behind, KTo is dominated too often when it gets action.', 'Đúng: với bảy người phía sau, KTo bị áp đảo quá thường xuyên khi có người hành động.') },
          { id: 'limp', label: L('Limp', 'Limp'), match: { action: 'call' }, grade: 'mistake', feedback: L('Open-limping from early position invites raises and plays a weak hand out of position.', 'Limp từ vị trí sớm mời người khác tố và phải chơi tay yếu ở vị trí bất lợi.'), leaks: ['excessiveLimpCall'] },
          { id: 'open', label: L('Raise 2–2.5BB', 'Tố 2–2.5BB'), match: { action: 'raise', minBB: 2, maxBB: 2.5 }, grade: 'marginal', feedback: L('Opening KTo this early is loose; it is a common leak, not a disaster.', 'Mở KTo ở vị trí sớm như vậy là lỏng; đây là lỗi phổ biến, không phải thảm họa.') },
          { id: 'open-big', label: L('Raise above 2.5BB (not all-in)', 'Tố trên 2.5BB (không all-in)'), match: { action: 'raise', minBB: 2.51, maxBB: 24.9 }, grade: 'mistake', feedback: L('A loose hand with a large open size risks more to win the same blinds.', 'Tay lỏng với cỡ mở lớn mạo hiểm nhiều hơn để thắng cùng số blind.') },
          { id: 'shove', label: L('All-in', 'All-in'), match: { action: 'allin' }, grade: 'major', feedback: L('Shoving 25BB from early position with KTo only gets called by hands that crush it.', 'All-in 25BB từ vị trí sớm với KTo chỉ bị theo bởi những tay áp đảo nó.'), leaks: ['excessivePreflopAllIns'] },
        ],
        explanation: {
          keyReason: L('Early-position opening ranges are tight because many players are left to act; offsuit broadways like KTo are dominated by the hands that continue.', 'Range mở ở vị trí sớm chặt vì còn nhiều người phía sau; các lá cao rời chất như KTo bị áp đảo bởi những tay tiếp tục.'),
          lesson: L('Open tighter early and wider late. The number of players behind you is the main driver.', 'Mở chặt ở vị trí sớm, rộng ở vị trí muộn. Số người còn phía sau là yếu tố chính.'),
          gto: L('Published 9-max MTT opening ranges usually leave KTo out from UTG/UTG+1 at 25BB; it enters the range around the lojack/hijack.', 'Các range mở MTT 9 người được công bố thường không gồm KTo ở UTG/UTG+1 với 25BB; nó vào range từ khoảng LJ/HJ.'),
          exploit: L('At a very passive table that rarely 3-bets, a few more opens are fine.', 'Ở bàn rất thụ động, hiếm khi 3-bet, mở thêm vài tay cũng được.'),
          assumptions: [L('Standard tables; no unusually short or loose players behind.', 'Bàn tiêu chuẩn; không có người chơi quá ngắn hoặc quá lỏng phía sau.')],
          commonMistakes: [L('Playing the same opening range from every seat.', 'Dùng cùng một range mở ở mọi vị trí.')],
        },
      },
    },
  }),

  defineScenario({
    id: 'btn-a5s-3bet-vs-hj-open-40bb',
    version: 1,
    mode: 'hero',
    module: '03',
    title: L('BTN A5s versus a hijack open', 'BTN A5s trước HJ mở bài'),
    summary: L('HJ opens to 2.2BB at an 8-max table; Hero has A5s on the button with 40BB effective.', 'HJ mở 2.2BB tại bàn 8 người; Hero có A5s ở BTN với stack hiệu quả 40BB.'),
    format: { game: 'MTT', stage: 'middle', tableSize: 8 },
    difficulty: 3,
    source: { classification: 'HEURISTIC', method: HEURISTIC_METHOD },
    table: {
      ...blinds(1000, 1000),
      players: seats(8, { HJ: 45, BTN: 40 }, 35, {
        HJ: { tendencies: L('Opens a standard range; folds to 3-bets fairly often.', 'Mở range tiêu chuẩn; khá thường bỏ bài trước 3-bet.') },
      }),
      heroPos: 'BTN',
      heroCards: 'As5s',
    },
    root: 'hj-opens',
    nodes: {
      'hj-opens': { kind: 'script', actions: [{ pos: 'HJ', type: 'raise', toBB: 2.2 }], next: 'd' },
      d: {
        kind: 'decision',
        prompt: L('HJ opens to 2.2BB, CO folds. Your action?', 'HJ mở 2.2BB, CO bỏ. Hành động của bạn?'),
        skills: ['preflop'],
        concepts: ['3-bet', 'bluff-3bet', 'blockers'],
        leakOpportunities: ['underbluffing', 'excessivePreflopAllIns'],
        options: [
          { id: 'fold', label: L('Fold', 'Bỏ bài'), match: { action: 'fold' }, grade: 'marginal', feedback: L('Too tight: A5s in position is one of the best 3-bet bluff candidates.', 'Quá chặt: A5s có vị trí là một trong những tay 3-bet bluff tốt nhất.'), leaks: ['underbluffing'] },
          { id: 'call', label: L('Call', 'Theo'), match: { action: 'call' }, grade: 'acceptable', feedback: L('Flatting in position is playable, but it lets the blinds squeeze and gives up fold equity.', 'Theo có vị trí chơi được, nhưng cho phép blind squeeze và bỏ mất fold equity.') },
          { id: '3bet', label: L('3-bet to 6–8BB', '3-bet lên 6–8BB'), match: { action: 'raise', minBB: 6, maxBB: 8 }, grade: 'excellent', feedback: L('A position-sized 3-bet wins the pot often, and the ace blocker plus wheel playability give a good fallback.', '3-bet cỡ hợp lý có vị trí thường ăn pot ngay, và blocker lá A cùng khả năng ra sảnh nhỏ cho phương án dự phòng tốt.') },
          { id: '3bet-other', label: L('3-bet to another size (not all-in)', '3-bet cỡ khác (không all-in)'), match: { action: 'raise', minBB: 4.4, maxBB: 39.9 }, grade: 'acceptable', feedback: L('3-betting is right; very small sizes give too good a price, very large ones risk too much.', '3-bet là đúng; cỡ quá nhỏ cho đối thủ giá quá tốt, cỡ quá lớn mạo hiểm quá nhiều.') },
          { id: 'shove', label: L('All-in', 'All-in'), match: { action: 'allin' }, grade: 'mistake', feedback: L('A 40BB jam over a 2.2BB open risks far too much to win about 4.7BB.', 'All-in 40BB trước lần mở 2.2BB mạo hiểm quá nhiều để thắng khoảng 4.7BB.'), leaks: ['excessivePreflopAllIns'] },
        ],
        explanation: {
          keyReason: L('A5s blocks AA/AK, has playable equity when called, and the button’s position makes a 3-bet profitable against an opener who folds often.', 'A5s chặn AA/AK, có equity chơi được khi bị theo, và vị trí BTN khiến 3-bet có lãi trước người mở hay bỏ bài.'),
          lesson: L('Good 3-bet bluffs combine blockers to the opponent’s continuing range with enough playability when called.', '3-bet bluff tốt kết hợp blocker lên range tiếp tục của đối thủ với khả năng chơi tiếp khi bị theo.'),
          gto: L('Published baselines commonly 3-bet suited wheel aces from the button versus middle-position opens at this depth, often mixed with calls. No frequencies are claimed here.', 'Chiến lược cơ sở công bố thường 3-bet Ax đồng chất nhỏ từ BTN trước mở vị trí giữa ở độ sâu này, thường trộn với theo. Không đưa ra tần suất ở đây.'),
          exploit: L('Against an opener who never folds to 3-bets, flat more and 3-bet bluff less; against a frequent folder, 3-bet more.', 'Gặp người mở không bao giờ bỏ trước 3-bet, theo nhiều hơn và 3-bet bluff ít hơn; gặp người hay bỏ, 3-bet nhiều hơn.'),
          ranges: L('Assumed HJ open range ~18–20% of hands; the 3-bet range should mix value (QQ+, AK) with blocker bluffs like A5s.', 'Range mở giả định của HJ khoảng 18–20% số tay; range 3-bet nên trộn value (QQ+, AK) với bluff có blocker như A5s.'),
          assumptions: [L('Effective stack 40BB; blinds are not unusually aggressive squeezers.', 'Stack hiệu quả 40BB; hai blind không squeeze bất thường.')],
          commonMistakes: [L('3-betting only premium hands, which makes your 3-bets easy to read.', 'Chỉ 3-bet bài mạnh, khiến 3-bet của bạn dễ bị đọc.')],
        },
      },
    },
  }),

  defineScenario({
    id: 'co-aqo-facing-btn-3bet-45bb',
    version: 1,
    mode: 'hero',
    module: '03',
    title: L('CO AQo facing a button 3-bet at 45BB', 'CO AQo đối mặt 3-bet từ BTN với 45BB'),
    summary: L('Hero opens AQo from the cutoff; the button 3-bets to 7BB. Blinds fold.', 'Hero mở AQo từ CO; BTN 3-bet lên 7BB. Hai blind bỏ.'),
    format: { game: 'MTT', stage: 'middle', tableSize: 6 },
    difficulty: 4,
    source: { classification: 'HEURISTIC', method: HEURISTIC_METHOD },
    table: {
      ...blinds(1000, 1000),
      players: seats(6, { CO: 45, BTN: 52 }, 35, {
        BTN: { tendencies: L('Aggressive regular; 3-bets the cutoff often, including bluffs.', 'Người chơi hung hăng; thường 3-bet CO, kể cả bluff.') },
      }),
      heroPos: 'CO',
      heroCards: 'AhQc',
    },
    root: 'open-3bet',
    nodes: {
      'open-3bet': {
        kind: 'script',
        actions: [
          { pos: 'CO', type: 'raise', toBB: 2.2 },
          { pos: 'BTN', type: 'raise', toBB: 7 },
        ],
        note: L('You opened to 2.2BB; the button 3-bets to 7BB and both blinds fold.', 'Bạn mở 2.2BB; BTN 3-bet lên 7BB và hai blind bỏ.'),
        next: 'd',
      },
      d: {
        kind: 'decision',
        prompt: L('BTN 3-bets to 7BB. Your action?', 'BTN 3-bet lên 7BB. Hành động của bạn?'),
        skills: ['preflop'],
        concepts: ['facing-3bet', '4-bet', 'stack-to-pot'],
        leakOpportunities: ['incorrect3betDefense'],
        options: [
          { id: 'fold', label: L('Fold', 'Bỏ bài'), match: { action: 'fold' }, grade: 'mistake', feedback: L('AQo is near the top of your opening range against a wide 3-bettor; folding is far too tight.', 'AQo gần như mạnh nhất trong range mở của bạn trước người 3-bet rộng; bỏ bài là quá chặt.'), leaks: ['incorrect3betDefense'] },
          { id: 'call', label: L('Call', 'Theo'), match: { action: 'call' }, grade: 'good', feedback: L('Calling keeps his bluffs in and plays a pot of ~16BB with ~38BB behind — reasonable, though out of position.', 'Theo giữ các tay bluff của đối thủ trong pot, chơi pot ~16BB với ~38BB phía sau — hợp lý, dù không có vị trí.') },
          { id: '4bet-small', label: L('4-bet (not all-in)', '4-bet (không all-in)'), match: { action: 'raise', minBB: 14, maxBB: 44.9 }, grade: 'acceptable', feedback: L('A small 4-bet works, but at 45BB it commits you anyway; a jam is cleaner.', '4-bet nhỏ có thể dùng, nhưng ở 45BB nó vẫn cam kết bạn; all-in gọn hơn.') },
          { id: 'shove', label: L('All-in', 'All-in'), match: { action: 'allin' }, grade: 'good', feedback: L('Jamming denies equity and folds out his bluffs; AQo does well against a wide 3-bet range.', 'All-in từ chối equity và làm các tay bluff bỏ bài; AQo chơi tốt trước range 3-bet rộng.') },
        ],
        explanation: {
          keyReason: L('Against a wide button 3-bet range, AQo is too strong to fold. Both calling and jamming are defensible at 45BB; the choice depends on how often he 3-bets light and how well you play out of position.', 'Trước range 3-bet rộng của BTN, AQo quá mạnh để bỏ. Cả theo và all-in đều hợp lý ở 45BB; lựa chọn tùy vào tần suất 3-bet nhẹ của đối thủ và khả năng chơi không vị trí của bạn.'),
          lesson: L('Your defense versus 3-bets depends on the 3-bettor’s position and frequency: late-position 3-bets are wide, so strong broadways continue.', 'Cách phòng thủ trước 3-bet tùy vị trí và tần suất của người 3-bet: 3-bet từ vị trí muộn rộng, nên lá cao mạnh phải tiếp tục.'),
          gto: L('Published 40–50BB baselines continue AQo versus a button 3-bet, mixing calls and 4-bet jams. No frequencies are claimed here.', 'Chiến lược cơ sở 40–50BB công bố tiếp tục với AQo trước 3-bet từ BTN, trộn giữa theo và 4-bet all-in. Không đưa ra tần suất ở đây.'),
          exploit: L('Jam more against a light 3-bettor who folds to 4-bets; call more against one who only 3-bets value.', 'All-in nhiều hơn trước người 3-bet nhẹ hay bỏ trước 4-bet; theo nhiều hơn trước người chỉ 3-bet value.'),
          ranges: L('Assumed BTN 3-bet range vs a CO open: roughly 10–12% of hands, including suited aces and broadways as bluffs.', 'Range 3-bet giả định của BTN trước CO: khoảng 10–12% số tay, gồm Ax đồng chất và lá cao làm bluff.'),
          assumptions: [L('45BB effective; no ICM pressure.', 'Stack hiệu quả 45BB; không có áp lực ICM.')],
          commonMistakes: [L('Folding strong hands to late-position 3-bets because they "always have it".', 'Bỏ tay mạnh trước 3-bet vị trí muộn vì nghĩ đối thủ "luôn có bài".')],
        },
      },
    },
  }),

  defineScenario({
    id: 'bb-96s-defend-vs-btn-minraise',
    version: 1,
    mode: 'hero',
    module: '05',
    title: L('BB 96s versus a button min-raise', 'BB 96s trước BTN min-raise'),
    summary: L('The button opens to 2BB at a 9-max table; SB folds. Hero defends the big blind with 96s at 35BB.', 'BTN mở 2BB tại bàn 9 người; SB bỏ. Hero phòng thủ BB với 96s ở 35BB.'),
    format: { game: 'MTT', stage: 'middle', tableSize: 9 },
    difficulty: 1,
    source: { classification: 'HEURISTIC', method: HEURISTIC_METHOD },
    table: {
      ...blinds(1000, 1000),
      players: seats(9, { BTN: 40, BB: 35 }, 30, {
        BTN: { tendencies: L('Min-raises a wide stealing range.', 'Min-raise với range cướp blind rộng.') },
      }),
      heroPos: 'BB',
      heroCards: '9h6h',
    },
    root: 'btn-opens',
    nodes: {
      'btn-opens': { kind: 'script', actions: [{ pos: 'BTN', type: 'raise', toBB: 2 }], next: 'd' },
      d: {
        kind: 'decision',
        prompt: L('BTN min-raises to 2BB, SB folds. Your action?', 'BTN min-raise lên 2BB, SB bỏ. Hành động của bạn?'),
        skills: ['preflop', 'math'],
        concepts: ['bb-defense', 'pot-odds', 'min-raise'],
        leakOpportunities: ['potOdds'],
        options: [
          { id: 'fold', label: L('Fold', 'Bỏ bài'), match: { action: 'fold' }, grade: 'mistake', feedback: L('At this price a suited connector-type hand is a clear defend.', 'Với giá này, tay đồng chất liên kết như vậy phải phòng thủ rõ ràng.'), leaks: ['potOdds'] },
          { id: 'call', label: L('Call', 'Theo'), match: { action: 'call' }, grade: 'excellent', feedback: L('You need only about 18% equity and close the action; calling is standard.', 'Bạn chỉ cần khoảng 18% equity và là người đóng hành động; theo là tiêu chuẩn.') },
          { id: '3bet', label: L('3-bet (not all-in)', '3-bet (không all-in)'), match: { action: 'raise', minBB: 3, maxBB: 34.9 }, grade: 'acceptable', feedback: L('An occasional 3-bet is fine, but 96s plays well enough to simply call.', 'Thỉnh thoảng 3-bet cũng được, nhưng 96s đủ tốt để chỉ cần theo.') },
          { id: 'shove', label: L('All-in', 'All-in'), match: { action: 'allin' }, grade: 'mistake', feedback: L('A 35BB jam with 96s risks your stack to win 4.5BB and gets called by better hands.', 'All-in 35BB với 96s mạo hiểm cả stack để thắng 4.5BB và chỉ bị theo bởi bài mạnh hơn.'), leaks: ['excessivePreflopAllIns'] },
        ],
        explanation: {
          keyReason: L(
            'The pot is 2 (BTN) + 0.5 (SB) + 1 (your BB) + 1 (BB ante) = 4.5BB, and you call 1BB more: 1 / 5.5 ≈ 18% required equity. 96s easily clears that against a wide steal.',
            'Pot là 2 (BTN) + 0.5 (SB) + 1 (BB của bạn) + 1 (ante BB) = 4.5BB, và bạn theo thêm 1BB: 1 / 5.5 ≈ 18% equity cần thiết. 96s vượt mức đó dễ dàng trước range cướp blind rộng.',
          ),
          lesson: L('Small opens plus antes give the big blind a huge price; defend wide, especially with suited hands that realize equity well.', 'Mở nhỏ cộng ante cho BB giá rất tốt; phòng thủ rộng, nhất là với tay đồng chất hiện thực hóa equity tốt.'),
          gto: L('Published BB defense baselines versus a button min-raise with antes defend a very wide range, including most suited hands. No frequencies are claimed here.', 'Chiến lược phòng thủ BB công bố trước BTN min-raise có ante phòng thủ range rất rộng, gồm hầu hết tay đồng chất. Không đưa ra tần suất ở đây.'),
          exploit: L('Against a button who c-bets and barrels relentlessly, keep defending but check-raise and call down more selectively.', 'Gặp BTN c-bet và barrel liên tục, vẫn phòng thủ nhưng check-raise và theo tới cùng có chọn lọc hơn.'),
          ranges: L('Assumed BTN min-raise range: roughly 45–50% of hands.', 'Range min-raise giả định của BTN: khoảng 45–50% số tay.'),
          assumptions: [L('Raw equity overstates realization out of position; suited hands lose less than offsuit ones.', 'Equity thô đánh giá cao khả năng hiện thực hóa khi không có vị trí; tay đồng chất mất ít hơn tay rời chất.')],
          commonMistakes: [L('Folding because "I am out of position" without checking the price.', 'Bỏ bài vì "không có vị trí" mà không kiểm tra giá pot.')],
        },
      },
    },
  }),

  // ───────────────────────────── Module 14 — PKO ─────────────────────────────
  defineScenario({
    id: 'pko-bb-j6o-call-btn-9bb-bounty',
    version: 1,
    mode: 'hero',
    module: '14',
    title: L('PKO: BB J6o versus a 9BB button shove with a bounty', 'PKO: BB J6o trước BTN all-in 9BB có bounty'),
    summary: L('In a progressive knockout, the 9BB button shoves; Hero covers in the big blind with J6o. Villain’s bounty: $100.', 'Trong giải PKO, BTN 9BB all-in; Hero ở BB có nhiều chip hơn với J6o. Bounty của Villain: $100.'),
    format: { game: 'PKO', stage: 'middle', tableSize: 8 },
    difficulty: 3,
    source: { classification: 'MATH_VERIFIED', method: PKO_METHOD },
    table: {
      ...blinds(2000, 2000),
      players: seats(8, { BTN: 9, BB: 40 }, 25, {
        BTN: { bounty: 100, tendencies: L('Shoves a wide range when folded to.', 'All-in rộng khi được bỏ tới.') },
        BB: { bounty: 60 },
      }),
      heroPos: 'BB',
      heroCards: 'Jd6s',
    },
    tournament: PKO_TOURNAMENT,
    root: 'btn-shoves',
    nodes: {
      'btn-shoves': { kind: 'script', actions: [{ pos: 'BTN', type: 'allin' }], next: 'd' },
      d: {
        kind: 'decision',
        prompt: L('BTN shoves 9BB ($100 bounty), SB folds. Your action?', 'BTN all-in 9BB (bounty $100), SB bỏ. Hành động của bạn?'),
        skills: ['preflop', 'pko', 'math'],
        concepts: ['bounty-equity', 'pot-odds', 'covering'],
        leakOpportunities: ['potOdds', 'overcallingBounty'],
        model: { type: 'call', villainPos: 'BTN', villainRange: '22+,A2+,K2s+,K7o+,Q6s+,Q9o+,J7s+,J9o+,T7s+,T9o,97s+,86s+,76s,65s', bountyBB: 10 },
        options: [
          { id: 'fold', label: L('Fold', 'Bỏ bài'), match: { action: 'fold' }, modelKey: 'fold', feedback: L('Folding ignores the bounty you win whenever you knock the button out.', 'Bỏ bài là bỏ qua bounty bạn nhận được mỗi khi loại BTN.'), leaks: ['potOdds'] },
          { id: 'call', label: L('Call', 'Theo'), match: { action: 'call' }, modelKey: 'call', feedback: L('With the bounty added to the pot, the call clears the bar.', 'Khi cộng bounty vào pot, lần theo này vượt ngưỡng cần thiết.') },
        ],
        explanation: {
          keyReason: L(
            'Without the bounty you would need 8 / 19.5 ≈ 41% equity, and J6o (about 35% against this range) falls clearly short. Because you cover, winning also pays a bounty worth ~10BB, which lowers the equity you need enough to make the call profitable in this model.',
            'Nếu không có bounty bạn cần 8 / 19.5 ≈ 41% equity, và J6o (khoảng 35% trước range này) thiếu rõ ràng. Vì bạn có nhiều chip hơn, thắng sẽ được thêm bounty trị giá ~10BB, hạ thấp equity cần thiết đủ để lần theo có lãi theo mô hình này.',
          ),
          lesson: L('Add the bounty’s chip-equivalent to the pot when you cover: required equity = call ÷ (pot after call + bounty).', 'Cộng giá trị chip của bounty vào pot khi bạn có nhiều chip hơn: equity cần thiết = số chip theo ÷ (pot sau khi theo + bounty).'),
          gto: L('Bounties widen calling ranges against short stacks you cover. This is a chip-equivalent model, not a solver output.', 'Bounty mở rộng range theo trước stack ngắn mà bạn có nhiều chip hơn. Đây là mô hình quy đổi chip, không phải kết quả solver.'),
          exploit: L('If the button shoves tighter than assumed, recheck: the bounty does not rescue a hand that is crushed.', 'Nếu BTN all-in chặt hơn giả định, tính lại: bounty không cứu được tay bị áp đảo.'),
          ranges: L(
            'Assumed BTN shove: 22+, A2+, K2s+, K7o+, Q6s+, Q9o+, J7s+, J9o+, T7s+, T9o, 97s+, 86s+, 76s, 65s. Bounty value: you receive half of the $100 bounty = $50 cash; $50 × 4,000,000 chips ÷ $10,000 remaining = 20,000 chips = 10BB at 2,000 per big blind.',
            'Range all-in giả định của BTN: 22+, A2+, K2s+, K7o+, Q6s+, Q9o+, J7s+, J9o+, T7s+, T9o, 97s+, 86s+, 76s, 65s. Giá trị bounty: bạn nhận một nửa bounty $100 = $50 tiền mặt; $50 × 4.000.000 chip ÷ $10.000 còn lại = 20.000 chip = 10BB với BB 2.000.',
          ),
          assumptions: [
            L('Bounty converted at the tournament’s average $/chip; future bounty growth and ICM are ignored.', 'Bounty quy đổi theo tỷ lệ $/chip trung bình của giải; bỏ qua bounty tăng trong tương lai và ICM.'),
            L('The half of the bounty added to your own head is not counted (conservative).', 'Nửa bounty cộng vào đầu của bạn không được tính (thận trọng).'),
          ],
          commonMistakes: [L('Ignoring bounties entirely and playing the hand as a regular freezeout.', 'Bỏ qua bounty hoàn toàn và chơi như giải freezeout thường.')],
        },
      },
    },
  }),

  defineScenario({
    id: 'pko-btn-q7s-20bb-shove-bounty-sb',
    version: 1,
    mode: 'hero',
    module: '14',
    title: L('PKO: BTN Q7s shove when only the SB’s bounty is in reach', 'PKO: BTN Q7s all-in khi chỉ bounty của SB nằm trong tầm'),
    summary: L('Folded to Hero on the button with 20BB in a PKO. The SB has 6BB and a $60 bounty; the BB covers you.', 'Bỏ bài tới Hero ở BTN với 20BB trong giải PKO. SB có 6BB và bounty $60; BB có nhiều chip hơn bạn.'),
    format: { game: 'PKO', stage: 'middle', tableSize: 6 },
    difficulty: 4,
    source: { classification: 'MATH_VERIFIED', method: PKO_METHOD },
    table: {
      ...blinds(2000, 2000),
      players: seats(6, { BTN: 20, SB: 6, BB: 34 }, 25, {
        SB: { bounty: 60, tendencies: L('Short and frustrated; calls shoves wide.', 'Stack ngắn và nóng vội; theo all-in rộng.') },
        BB: { bounty: 120, tendencies: L('Big stack; calls shoves with a solid range.', 'Stack lớn; theo all-in với range chắc chắn.') },
        BTN: { bounty: 80 },
      }),
      heroPos: 'BTN',
      heroCards: 'Qs7s',
    },
    tournament: PKO_TOURNAMENT,
    root: 'folds',
    nodes: {
      folds: { kind: 'script', actions: [], next: 'd' },
      d: {
        kind: 'decision',
        prompt: L('Folded to you on the button with 20BB. Your action?', 'Bỏ bài tới bạn ở BTN với 20BB. Hành động của bạn?'),
        skills: ['preflop', 'pko', 'shortStack'],
        concepts: ['bounty-equity', 'covering', 'multiple-callers'],
        leakOpportunities: ['overcallingBounty', 'excessivePreflopAllIns'],
        model: {
          type: 'shove',
          callers: [
            { pos: 'SB', callRange: '22+,A2+,K2+,Q5+,J7+,T7+,97+,87s', bountyBB: 6 },
            { pos: 'BB', callRange: '55+,A8+,KTs+,KQo' },
          ],
        },
        options: [
          { id: 'fold', label: L('Fold', 'Bỏ bài'), match: { action: 'fold' }, modelKey: 'fold', feedback: L('Folding is safe, but compare it with the model before assuming it is best.', 'Bỏ bài an toàn, nhưng hãy so với mô hình trước khi cho rằng đó là tốt nhất.') },
          { id: 'raise', label: L('Raise (not all-in)', 'Tố (không all-in)'), match: { action: 'raise', minBB: 2, maxBB: 19.9 }, grade: 'acceptable', feedback: L('A small open is a real option at 20BB; it is not modeled here.', 'Mở nhỏ là lựa chọn thực sự ở 20BB; không được mô hình hóa ở đây.') },
          { id: 'shove', label: L('All-in', 'All-in'), match: { action: 'allin' }, modelKey: 'shove', feedback: L('The shove gets called often by the short SB, whose bounty you collect when you win.', 'All-in thường bị SB stack ngắn theo, và bạn nhận bounty của họ khi thắng.') },
        ],
        explanation: {
          keyReason: L(
            'You cover the SB, so busting them pays a bounty (~6BB) on top of the pot; you do NOT cover the BB, so the BB’s larger bounty is irrelevant here. The wide SB calls are against a 6BB stack, so they cost you little, while the BB’s calls risk your whole 20BB.',
            'Bạn có nhiều chip hơn SB, nên loại SB được thêm bounty (~6BB) ngoài pot; bạn KHÔNG có nhiều chip hơn BB, nên bounty lớn của BB không liên quan. SB theo rộng nhưng chỉ với 6BB nên ít tốn kém, còn BB theo thì bạn mạo hiểm cả 20BB.',
          ),
          lesson: L('Only bounties of players you cover count. Separate the cheap, bounty-paying call from the expensive, no-bounty call.', 'Chỉ tính bounty của người mà bạn có nhiều chip hơn. Tách lần bị theo rẻ có bounty khỏi lần bị theo đắt không có bounty.'),
          gto: L('This is a simplified chip-equivalent model with assumed ranges, not solver output.', 'Đây là mô hình quy đổi chip đơn giản với range giả định, không phải kết quả solver.'),
          exploit: L('If the BB calls much wider than assumed, the shove gets worse quickly because those calls risk your full stack.', 'Nếu BB theo rộng hơn nhiều so với giả định, all-in nhanh chóng kém đi vì những lần theo đó mạo hiểm cả stack.'),
          ranges: L(
            'Assumed SB call (6BB): 22+, A2+, K2+, Q5+, J7+, T7+, 97+, 87s. Assumed BB call: 55+, A8+, KTs+, KQo. SB bounty value: half of $60 = $30; $30 × 4,000,000 ÷ $10,000 = 12,000 chips = 6BB at 2,000 per big blind.',
            'Range theo giả định của SB (6BB): 22+, A2+, K2+, Q5+, J7+, T7+, 97+, 87s. Của BB: 55+, A8+, KTs+, KQo. Giá trị bounty SB: một nửa $60 = $30; $30 × 4.000.000 ÷ $10.000 = 12.000 chip = 6BB với BB 2.000.',
          ),
          assumptions: [
            L('Bounty converted at the tournament’s average $/chip; ChipEV only, no ICM.', 'Bounty quy đổi theo tỷ lệ $/chip trung bình của giải; chỉ ChipEV, không ICM.'),
            L('If the SB calls, the BB is assumed to fold (one caller modeled).', 'Nếu SB theo, giả định BB bỏ (chỉ mô hình hóa một người theo).'),
          ],
          commonMistakes: [L('Counting the bounty of a player who covers you.', 'Tính bounty của người có nhiều chip hơn bạn.')],
        },
      },
    },
  }),

  defineScenario({
    id: 'pko-bb-k8o-fold-vs-utg-15bb-bounty',
    version: 1,
    mode: 'hero',
    module: '14',
    title: L('PKO: BB K8o versus a tight 15BB shove with a bounty', 'PKO: BB K8o trước all-in 15BB chặt có bounty'),
    summary: L('UTG shoves 15BB at a 9-max PKO table; Hero covers in the big blind with K8o. Villain’s bounty: $80.', 'UTG all-in 15BB tại bàn PKO 9 người; Hero ở BB có nhiều chip hơn với K8o. Bounty của Villain: $80.'),
    format: { game: 'PKO', stage: 'middle', tableSize: 9 },
    difficulty: 3,
    source: { classification: 'MATH_VERIFIED', method: PKO_METHOD },
    table: {
      ...blinds(2000, 2000),
      players: seats(9, { UTG: 15, BB: 30 }, 25, {
        UTG: { bounty: 80, tendencies: L('Tight; shoves only strong hands from early position.', 'Chặt; chỉ all-in bài mạnh từ vị trí sớm.') },
        BB: { bounty: 70 },
      }),
      heroPos: 'BB',
      heroCards: 'Kc8h',
    },
    tournament: PKO_TOURNAMENT,
    root: 'utg-shoves',
    nodes: {
      'utg-shoves': { kind: 'script', actions: [{ pos: 'UTG', type: 'allin' }], next: 'd' },
      d: {
        kind: 'decision',
        prompt: L('UTG shoves 15BB ($80 bounty), folded to you. Your action?', 'UTG all-in 15BB (bounty $80), bỏ tới bạn. Hành động của bạn?'),
        skills: ['preflop', 'pko', 'math'],
        concepts: ['bounty-equity', 'pot-odds', 'range-strength'],
        leakOpportunities: ['overcallingBounty', 'potOdds'],
        model: { type: 'call', villainPos: 'UTG', villainRange: '66+,ATs+,AJo+,KQs', bountyBB: 8 },
        options: [
          { id: 'fold', label: L('Fold', 'Bỏ bài'), match: { action: 'fold' }, modelKey: 'fold', feedback: L('Correct: the bounty lowers the bar, but K8o is still far below it.', 'Đúng: bounty hạ ngưỡng, nhưng K8o vẫn thấp hơn nhiều.') },
          { id: 'call', label: L('Call', 'Theo'), match: { action: 'call' }, modelKey: 'call', feedback: L('A bounty does not make a dominated hand profitable against a tight range.', 'Bounty không làm một tay bị áp đảo trở nên có lãi trước range chặt.'), leaks: ['overcallingBounty'] },
        ],
        explanation: {
          keyReason: L(
            'You call 14BB into a pot of 17.5BB plus an ~8BB bounty: 14 / (31.5 + 8) ≈ 35% required equity. Against pairs and big aces, K8o has much less.',
            'Bạn theo 14BB vào pot 17.5BB cộng bounty ~8BB: 14 / (31.5 + 8) ≈ 35% equity cần thiết. Trước các đôi và A lớn, K8o có ít hơn nhiều.',
          ),
          lesson: L('Bounties lower the required equity; they do not remove it. Against tight ranges, dominated hands still fold.', 'Bounty hạ equity cần thiết, chứ không xóa bỏ nó. Trước range chặt, tay bị áp đảo vẫn phải bỏ.'),
          gto: L('Chip-equivalent bounty model with an assumed range; not a solver output.', 'Mô hình quy đổi bounty sang chip với range giả định; không phải kết quả solver.'),
          exploit: L('Against a player who shoves wide in PKOs to protect a small stack, more hands become calls.', 'Gặp người all-in rộng trong PKO để bảo vệ stack nhỏ, nhiều tay hơn trở thành theo được.'),
          ranges: L(
            'Assumed UTG shove: 66+, ATs+, AJo+, KQs. Bounty value: half of $80 = $40; $40 × 4,000,000 ÷ $10,000 = 16,000 chips = 8BB at 2,000 per big blind.',
            'Range all-in giả định của UTG: 66+, ATs+, AJo+, KQs. Giá trị bounty: một nửa $80 = $40; $40 × 4.000.000 ÷ $10.000 = 16.000 chip = 8BB với BB 2.000.',
          ),
          assumptions: [L('Bounty converted at the tournament’s average $/chip; ChipEV only, no ICM.', 'Bounty quy đổi theo tỷ lệ $/chip trung bình của giải; chỉ ChipEV, không ICM.')],
          commonMistakes: [L('Calling any two cards because "there is a bounty".', 'Theo với mọi tay chỉ vì "có bounty".')],
        },
      },
    },
  }),

  // ───────────────────────────── Modules 15 / 16 — ICM ─────────────────────────────
  defineScenario({
    id: 'icm-bubble-bb-ato-vs-co-shove',
    version: 1,
    mode: 'hero',
    module: '15',
    title: L('Bubble: BB ATo facing a big-stack shove', 'Bong bóng: BB ATo trước all-in của stack lớn'),
    summary: L(
      'Nine players left, eight paid. The chip leader shoves from the cutoff and covers Hero in the big blind. A 3BB stack sits at this table.',
      'Còn chín người, tám người có giải. Chip leader all-in từ CO và có nhiều chip hơn Hero ở BB. Một stack 3BB đang ngồi cùng bàn.',
    ),
    format: { game: 'MTT', stage: 'bubble', tableSize: 6 },
    difficulty: 5,
    source: { classification: 'MATH_VERIFIED', method: ICM_METHOD },
    table: {
      ...blinds(1000, 1000),
      players: seats(6, { SB: 14, BB: 20, UTG: 3, HJ: 12, CO: 45, BTN: 16 }, 20, {
        CO: { tendencies: L('Chip leader; uses the bubble to shove wide.', 'Chip leader; tận dụng bong bóng để all-in rộng.') },
      }),
      heroPos: 'BB',
      heroCards: 'AdTc',
    },
    tournament: {
      payouts: [3000, 2000, 1400, 1000, 800, 650, 550, 500],
      otherStacksBB: [22, 9, 30],
      playersLeft: 9,
      note: L('Bubble: 9 players remain across two tables, 8 are paid. Three players sit at the other table (22BB, 9BB, 30BB).', 'Bong bóng: còn 9 người ở hai bàn, 8 người có giải. Ba người ở bàn kia (22BB, 9BB, 30BB).'),
    },
    root: 'co-shoves',
    nodes: {
      'co-shoves': { kind: 'script', actions: [{ pos: 'CO', type: 'allin' }], next: 'd' },
      d: {
        kind: 'decision',
        prompt: L('The chip leader shoves from the CO; BTN and SB fold. Your action?', 'Chip leader all-in từ CO; BTN và SB bỏ. Hành động của bạn?'),
        evUnit: 'icmPct',
        skills: ['preflop', 'icm'],
        concepts: ['risk-premium', 'bubble-factor', 'chipev-vs-icm'],
        leakOpportunities: ['icmAdjustments'],
        model: { type: 'call', villainPos: 'CO', villainRange: '22+,A2+,K2+,Q2s+,Q7o+,J6s+,J8o+,T7s+,T8o+,96s+,98o,85s+,75s+,64s+,54s' },
        options: [
          { id: 'fold', label: L('Fold', 'Bỏ bài'), match: { action: 'fold' }, modelKey: 'fold', feedback: L('Folding protects your stack while a 3BB player is about to bust.', 'Bỏ bài bảo vệ stack trong khi người chơi 3BB sắp bị loại.') },
          { id: 'call', label: L('Call', 'Theo'), match: { action: 'call' }, modelKey: 'call', feedback: L('In chips this call profits, but busting on the bubble costs more prize equity than doubling gains.', 'Về chip lần theo này có lãi, nhưng bị loại ở bong bóng mất nhiều giá trị giải thưởng hơn phần được khi gấp đôi.'), leaks: ['icmAdjustments'] },
        ],
        explanation: {
          keyReason: L(
            'In chips you call 19BB to win a final pot of 41.5BB (20 + 20 + SB 0.5 + ante 1), needing about 46% equity; ATo has well over that against this very wide range, so calling is +ChipEV. But busting here pays nothing while a 3BB player is about to bust, and doubling up does not double your prize equity. That risk premium makes folding better under ICM.',
            'Về chip, bạn theo 19BB để thắng pot cuối 41.5BB (20 + 20 + SB 0.5 + ante 1), cần khoảng 46% equity; ATo có nhiều hơn hẳn trước range rất rộng này, nên theo là +ChipEV. Nhưng bị loại ở đây không có giải trong khi một người 3BB sắp bị loại, và gấp đôi chip không làm gấp đôi giá trị giải thưởng. Risk premium đó khiến bỏ bài tốt hơn theo ICM.',
          ),
          lesson: L('On the bubble, a medium stack facing a covering shove needs significantly more equity than pot odds say — the risk premium.', 'Ở bong bóng, stack trung bình đối mặt all-in của người có nhiều chip hơn cần equity cao hơn đáng kể so với pot odds — đó là risk premium.'),
          gto: L('ICM-based calling ranges on the bubble are much tighter than ChipEV ranges; this result comes from an ICM model with an assumed shoving range, not a solver.', 'Range theo dựa trên ICM ở bong bóng chặt hơn nhiều so với ChipEV; kết quả này từ mô hình ICM với range all-in giả định, không phải solver.'),
          exploit: L('The chip leader is exploiting exactly this pressure; accept it with medium hands and fight back with premiums.', 'Chip leader đang khai thác chính áp lực này; chấp nhận với tay trung bình và phản công với bài mạnh nhất.'),
          ranges: L(
            'Assumed CO shove (very wide bubble pressure): 22+, A2+, K2+, Q2s+, Q7o+, J6s+, J8o+, T7s+, T8o+, 96s+, 98o, 85s+, 75s+, 64s+, 54s. Required ChipEV equity: 19 / 41.5 ≈ 46% (only 20BB of the chip leader’s stack is at risk).',
            'Range all-in giả định của CO (gây áp lực bong bóng rất rộng): 22+, A2+, K2+, Q2s+, Q7o+, J6s+, J8o+, T7s+, T8o+, 96s+, 98o, 85s+, 75s+, 64s+, 54s. Equity ChipEV cần thiết: 19 / 41.5 ≈ 46% (chỉ 20BB trong stack của chip leader bị đặt vào rủi ro).',
          ),
          assumptions: [
            L('ICM with payouts 3000/2000/1400/1000/800/650/550/500 and the listed stacks at both tables.', 'ICM với giải thưởng 3000/2000/1400/1000/800/650/550/500 và các stack đã nêu ở cả hai bàn.'),
            L('ICM ignores skill, position and the blinds hitting the short stack next.', 'ICM bỏ qua kỹ năng, vị trí và việc blind sắp đến lượt stack ngắn.'),
          ],
          commonMistakes: [L('Calling because "I am ahead of his range" without accounting for the risk premium.', 'Theo vì "tôi đang hơn range của đối thủ" mà không tính risk premium.')],
        },
      },
    },
  }),

  defineScenario({
    id: 'ft-co-a9o-12bb-shove-icm',
    version: 1,
    mode: 'hero',
    module: '16',
    title: L('Final table: CO A9o at 12BB', 'Bàn chung kết: CO A9o với 12BB'),
    summary: L('Nine-handed final table. Folded to Hero in the cutoff with 12BB; the button and both blinds cover.', 'Bàn chung kết 9 người. Bỏ bài tới Hero ở CO với 12BB; BTN và hai blind đều nhiều chip hơn.'),
    format: { game: 'MTT', stage: 'finalTable', tableSize: 9 },
    difficulty: 4,
    source: { classification: 'MATH_VERIFIED', method: ICM_METHOD },
    table: {
      ...blinds(10000, 10000),
      players: seats(9, { SB: 25, BB: 40, UTG: 7, UTG1: 18, UTG2: 30, LJ: 22, HJ: 15, CO: 12, BTN: 35 }, 20),
      heroPos: 'CO',
      heroCards: 'As9d',
    },
    tournament: {
      payouts: [10000, 7000, 5000, 3800, 2900, 2200, 1700, 1300, 1000],
      playersLeft: 9,
      note: L('Final table, 9 left. Payouts (1st–9th): 10000 / 7000 / 5000 / 3800 / 2900 / 2200 / 1700 / 1300 / 1000.', 'Bàn chung kết, còn 9 người. Giải thưởng (1–9): 10000 / 7000 / 5000 / 3800 / 2900 / 2200 / 1700 / 1300 / 1000.'),
    },
    root: 'folds',
    nodes: {
      folds: { kind: 'script', actions: [], next: 'd' },
      d: {
        kind: 'decision',
        prompt: L('Folded to you in the cutoff with 12BB. Your action?', 'Bỏ bài tới bạn ở CO với 12BB. Hành động của bạn?'),
        evUnit: 'icmPct',
        skills: ['preflop', 'icm', 'shortStack'],
        concepts: ['push-fold', 'icm', 'pay-jumps', 'multiple-callers'],
        leakOpportunities: ['icmAdjustments', 'stackDepthAdjustments'],
        model: {
          type: 'shove',
          callers: [
            { pos: 'BTN', callRange: '77+,AJ+,KQs' },
            { pos: 'SB', callRange: '66+,ATs+,AJo+,KQs' },
            { pos: 'BB', callRange: '55+,A8s+,ATo+,KJs+,KQo' },
          ],
        },
        options: [
          { id: 'fold', label: L('Fold', 'Bỏ bài'), match: { action: 'fold' }, modelKey: 'fold', feedback: L('Folding waits for the 7BB stack to bust; it is close, but slightly worse than shoving in this model.', 'Bỏ bài chờ stack 7BB bị loại; khá sát, nhưng kém hơn all-in một chút theo mô hình này.') },
          { id: 'raise', label: L('Raise (not all-in)', 'Tố (không all-in)'), match: { action: 'raise', minBB: 2, maxBB: 11.9 }, grade: 'marginal', feedback: L('Raise-folding 12BB at a final table burns chips you cannot afford; not modeled here.', 'Tố rồi bỏ với 12BB ở bàn chung kết đốt số chip bạn không thể mất; không được mô hình hóa ở đây.') },
          { id: 'shove', label: L('All-in', 'All-in'), match: { action: 'allin' }, modelKey: 'shove', feedback: L('ICM-aware callers call tightly, so your shove picks up the pot very often.', 'Người theo có tính ICM theo rất chặt, nên all-in của bạn thường xuyên lấy được pot.') },
        ],
        explanation: {
          keyReason: L(
            'Under ICM, the big stacks behind you must call tightly too — losing to a 12BB shove costs them prize equity. That fold equity, plus a 2.5BB pot, keeps A9o a shove under ICM — but the edge is thin: much smaller in prize equity than the chip edge suggests, because busting at a final table is so costly.',
            'Theo ICM, các stack lớn phía sau cũng phải theo chặt — thua một cú all-in 12BB làm họ mất giá trị giải thưởng. Fold equity đó, cộng pot 2.5BB, giúp A9o vẫn nên all-in theo ICM — nhưng lợi thế mỏng: nhỏ hơn nhiều so với lợi thế về chip, vì bị loại ở bàn chung kết rất đắt.',
          ),
          lesson: L('ICM pressure works both ways: it tightens your calls, but it also tightens your opponents’ calls, which makes your shoves stronger.', 'Áp lực ICM tác động hai chiều: nó làm bạn theo chặt hơn, nhưng cũng làm đối thủ theo chặt hơn, khiến all-in của bạn mạnh hơn.'),
          gto: L('ICM push/fold charts still shove strong aces from the cutoff at 12BB; this model uses assumed ICM-tightened calling ranges.', 'Bảng push/fold ICM vẫn all-in các lá A mạnh từ CO ở 12BB; mô hình này dùng range theo giả định đã chặt lại vì ICM.'),
          exploit: L('If a big stack ignores ICM and calls wide, tighten your shoves into that player.', 'Nếu một stack lớn bỏ qua ICM và theo rộng, hãy chặt lại khi all-in vào người đó.'),
          ranges: L(
            'Assumed ICM-tightened calls — BTN: 77+, AJ+, KQs. SB: 66+, ATs+, AJo+, KQs. BB: 55+, A8s+, ATo+, KJs+, KQo. Stated assumptions.',
            'Range theo giả định (đã chặt vì ICM) — BTN: 77+, AJ+, KQs. SB: 66+, ATs+, AJo+, KQs. BB: 55+, A8s+, ATo+, KJs+, KQo. Đây là giả định.',
          ),
          assumptions: [L('ICM with the listed 9-place payouts; skill and future blinds ignored.', 'ICM với cơ cấu giải 9 vị trí đã nêu; bỏ qua kỹ năng và blind tương lai.')],
          commonMistakes: [L('Over-applying ICM: folding good shoves just to wait for the short stack to bust.', 'Áp dụng ICM quá mức: bỏ những cú all-in tốt chỉ để chờ stack ngắn bị loại.')],
        },
      },
    },
  }),
];

export default scenarios;
