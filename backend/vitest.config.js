import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'threads',
    include: ['**/*.test.js', '**/*.test.mjs', '**/__tests__/**/*.js', '**/__tests__/**/*.mjs'],
    exclude: ['node_modules', 'scripts', 'lib/ebay-trading-api.test.js', 'services/pick-hints.test.js', '**/__tests__/**/_*.js', '**/__tests__/**/_*.mjs'],
    testTimeout: 10000,
    server: {
      deps: {
        inline: ['p-queue'],
      },
    },
  },
});
