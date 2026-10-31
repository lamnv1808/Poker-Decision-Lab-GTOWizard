import type { ScenarioInput } from '../scenario/schema';
import m01 from './scenarios/m01-preflop';
import m04 from './scenarios/m04-shortstack';
import packA from './scenarios/pack-a';
import packB from './scenarios/pack-b';
import packC from './scenarios/pack-c';

export * from './helpers';
export { CURRICULUM, type CurriculumModule } from './curriculum';

/** Every authored scenario. Validated by `npm run validate:content` and at seed time. */
export const ALL_SCENARIOS: ScenarioInput[] = [...m01, ...m04, ...packA, ...packB, ...packC];
