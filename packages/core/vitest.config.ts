import { defineConfig } from 'vitest/config';

// Simulator suites play hundreds of full hands; coverage instrumentation makes them ~3x slower.
export default defineConfig({ test: { testTimeout: 30_000 } });
