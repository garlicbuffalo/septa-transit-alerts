import { defineConfig } from 'vitest/config';

// The bot's tests run in Node (`npm run test:bot` from the repo root, which
// supplies vitest).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    testTimeout: 30000,
  },
});
