import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ['tests/**/*.test.ts', 'web/**/*.test.ts'],
    // Keep filesystem and child-process integration tests reliable on Windows.
    maxWorkers: 4,
    testTimeout: 15_000,
  },
});
