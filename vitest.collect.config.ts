import { defineConfig } from 'vitest/config';

/** Nightly real-call collection: archives recordings and replays them with a teacher model; never part of `npm test`. */
export default defineConfig({
  test: {
    include: ['eval/collect-calls.run.ts'],
    fileParallelism: false,
    hookTimeout: 60_000,
  },
});
