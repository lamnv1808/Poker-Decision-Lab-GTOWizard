/** Writes a small V2-format directory built from the anonymised real-hand fixtures; prints its path (tests/e2e). */
import { buildV2Fixture } from '../test/v2fixture';
console.log(buildV2Fixture().dir);
