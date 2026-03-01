import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.js', '**/__tests__/**/*.js'],
    exclude: ['node_modules', 'scripts', 'lib/ebay-trading-api.test.js', 'services/pick-hints.test.js'],
    testTimeout: 10000,
  },
});
