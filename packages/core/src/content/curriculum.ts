import type { Localized, ModuleId, SkillKey } from '../scenario/schema';
import { L } from './helpers';

export interface CurriculumModule {
  id: ModuleId;
  title: Localized;
  objectives: Localized[];
  skills: SkillKey[];
  /** Difficulty band of the module's content (1 = fundamentals, 5 = expert). */
  levels: [number, number];
  /** Math Lab quiz kinds that support this module. */
  quizKinds: string[];
}

export const CURRICULUM: CurriculumModule[] = [
  { id: '01', title: L('Preflop fundamentals', 'Nền tảng preflop'), skills: ['preflop'], levels: [1, 2], quizKinds: ['combos'],
    objectives: [L('Know why position and stack depth change hand values.', 'Hiểu vì sao vị trí và độ sâu stack thay đổi giá trị bài.'), L('Count starting-hand combos.', 'Đếm số combo bài khởi đầu.')] },
  { id: '02', title: L('Opening ranges by position', 'Range mở bài theo vị trí'), skills: ['preflop'], levels: [1, 3], quizKinds: ['combos'],
    objectives: [L('Open tighter early and wider late.', 'Mở chặt ở vị trí sớm và rộng ở vị trí muộn.'), L('Choose open sizes by stack depth.', 'Chọn cỡ mở theo độ sâu stack.')] },
  { id: '03', title: L('3-Bet / 4-Bet / Squeeze', '3-Bet / 4-Bet / Squeeze'), skills: ['preflop'], levels: [2, 4], quizKinds: ['potOdds'],
    objectives: [L('Build linear and polarized 3-bet ranges.', 'Xây range 3-bet tuyến tính và phân cực.'), L('Defend correctly versus 3-bets.', 'Phòng thủ đúng trước 3-bet.')] },
  { id: '04', title: L('Short-stack push/fold', 'Push/fold stack ngắn'), skills: ['preflop', 'shortStack'], levels: [1, 3], quizKinds: ['potOdds', 'shoveEv'],
    objectives: [L('Use fold equity at 15BB and below.', 'Tận dụng fold equity ở 15BB trở xuống.'), L('Call shoves using pot odds versus ranges.', 'Theo all-in bằng pot odds trước range.')] },
  { id: '05', title: L('BB defense and pot odds', 'Phòng thủ BB và pot odds'), skills: ['preflop', 'math'], levels: [1, 3], quizKinds: ['potOdds'],
    objectives: [L('Compute the price the big blind is getting.', 'Tính giá mà BB đang nhận.'), L('Defend wide versus small opens.', 'Phòng thủ rộng trước các lần mở nhỏ.')] },
  { id: '06', title: L('Flop c-betting', 'C-bet trên flop'), skills: ['flop'], levels: [2, 3], quizKinds: ['bluffBreakEven'],
    objectives: [L('Recognize range and nut advantage.', 'Nhận biết lợi thế range và lợi thế bài mạnh nhất.'), L('Pick sizes by board texture.', 'Chọn cỡ cược theo kết cấu board.')] },
  { id: '07', title: L('Facing flop aggression', 'Đối mặt hung hăng trên flop'), skills: ['flop', 'math'], levels: [2, 4], quizKinds: ['mdf', 'outs'],
    objectives: [L('Use MDF as a reference, not a rule.', 'Dùng MDF làm mốc tham chiếu, không phải luật.'), L('Value draws by outs and implied odds.', 'Đánh giá bài hút qua outs và implied odds.')] },
  { id: '08', title: L('Turn barreling', 'Barrel trên turn'), skills: ['turn'], levels: [2, 4], quizKinds: ['bluffBreakEven', 'outs'],
    objectives: [L('Choose turn cards that improve your range.', 'Chọn lá turn có lợi cho range của bạn.'), L('Select bluffs with equity and blockers.', 'Chọn bluff có equity và blocker.')] },
  { id: '09', title: L('River value betting', 'Cược lấy giá trị trên river'), skills: ['river'], levels: [2, 4], quizKinds: ['bluffRatio'],
    objectives: [L('Find thin value versus calling ranges.', 'Tìm value mỏng trước range theo.'), L('Size bets to the hands that call.', 'Chọn cỡ cược theo những tay sẽ theo.')] },
  { id: '10', title: L('River bluff catching', 'Bắt bluff trên river'), skills: ['river', 'math'], levels: [2, 5], quizKinds: ['potOdds', 'mdf', 'bluffRatio'],
    objectives: [L('Compare required equity to Villain’s bluff share.', 'So sánh equity cần thiết với tỷ lệ bluff của Villain.'), L('Use blockers when choosing bluff-catchers.', 'Dùng blocker khi chọn tay bắt bluff.')] },
  { id: '11', title: L('Blockers and combo counting', 'Blocker và đếm combo'), skills: ['rangeReading', 'math'], levels: [2, 4], quizKinds: ['combos'],
    objectives: [L('Count combos after card removal.', 'Đếm combo sau khi loại bỏ lá đã biết.'), L('Measure how blockers shift value/bluff ratios.', 'Đo cách blocker thay đổi tỷ lệ value/bluff.')] },
  { id: '12', title: L('Range construction', 'Xây dựng range'), skills: ['rangeReading'], levels: [3, 5], quizKinds: ['bluffRatio', 'combos'],
    objectives: [L('Build balanced betting ranges.', 'Xây range cược cân bằng.'), L('Distinguish polarized and merged ranges.', 'Phân biệt range phân cực và range hợp nhất.')] },
  { id: '13', title: L('Multiway pots', 'Pot nhiều người'), skills: ['flop', 'exploit'], levels: [2, 4], quizKinds: ['potOdds'],
    objectives: [L('Bluff less and value bet stronger multiway.', 'Bluff ít hơn và value mạnh hơn khi nhiều người.')] },
  { id: '14', title: L('Bounty and PKO strategy', 'Chiến lược Bounty/PKO'), skills: ['pko', 'shortStack'], levels: [2, 4], quizKinds: ['bounty'],
    objectives: [L('Convert bounties into a chip-equivalent model.', 'Quy đổi bounty sang mô hình tương đương chip.'), L('Know when bounties justify wider calls.', 'Biết khi nào bounty cho phép theo rộng hơn.')] },
  { id: '15', title: L('Bubble and ICM', 'Bubble và ICM'), skills: ['icm'], levels: [3, 5], quizKinds: ['icm'],
    objectives: [L('Understand risk premium and bubble factors.', 'Hiểu risk premium và bubble factor.'), L('Tighten calls when chips lost cost more than chips won.', 'Chặt lại khi chip mất đáng giá hơn chip thắng.')] },
  { id: '16', title: L('Final-table decisions', 'Quyết định bàn chung kết'), skills: ['icm', 'shortStack'], levels: [3, 5], quizKinds: ['icm'],
    objectives: [L('Account for pay jumps and stack distribution.', 'Tính đến bước nhảy giải thưởng và phân bố stack.')] },
  { id: '17', title: L('Exploitative adjustments', 'Điều chỉnh khai thác'), skills: ['exploit'], levels: [2, 5], quizKinds: ['bluffBreakEven', 'potOdds'],
    objectives: [L('Deviate from baselines when evidence supports it.', 'Lệch khỏi chiến lược cơ sở khi có bằng chứng.'), L('Avoid result-oriented conclusions.', 'Tránh kết luận theo kết quả.')] },
  { id: '18', title: L('Full-hand decision trees', 'Cây quyết định toàn ván'), skills: ['preflop', 'flop', 'turn', 'river'], levels: [2, 5], quizKinds: [],
    objectives: [L('Plan a hand across streets.', 'Lên kế hoạch cho cả ván qua các vòng.')] },
];
