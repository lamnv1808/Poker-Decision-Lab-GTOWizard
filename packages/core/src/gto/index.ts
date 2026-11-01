import { type PushFoldSolution, registerPushFoldSolutions } from './pushfold';
import solutions from './pushfold-solutions.json';

registerPushFoldSolutions(solutions as unknown as { solutions: Record<string, PushFoldSolution> });
export const PUSHFOLD_DATA_INFO = {
  methodVersion: (solutions as { methodVersion: string }).methodVersion,
  equityMethod: (solutions as { equityMethod: string }).equityMethod,
  iterations: (solutions as { iterations: number }).iterations,
  maxExploitabilityBB: (solutions as { maxExploitabilityBB: number }).maxExploitabilityBB,
};
export * from './pushfold';
export * from './quiz';
export * from './audit';
