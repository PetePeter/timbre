import { defineConfig } from 'vitest/config';

/** Model evaluation: slow, needs live models; never part of `npm test`. */
export default defineConfig({
  test: {
    include: ['eval/**/*.eval.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 15 * 60_000,
    hookTimeout: 60_000,
  },
});
