/**
 * Shared spyOn setup for integration tests.
 *
 * PROBLEM: Vitest 4.x cannot mock local CJS modules with vi.mock(path, factory).
 *
 * SOLUTION:
 * 1. Each test file must vi.mock() the npm packages directly (hoisted by Vitest)
 * 2. This file loads lib/firestore.js and creates spies on all exports
 * 3. The test file requires this BEFORE requiring any route files
 *
 * Usage:
 *   // In test file:
 *   vi.mock('@google-cloud/firestore', () => { ... });  // npm mocks (hoisted)
 *   vi.mock('firebase-admin', () => { ... });
 *   vi.mock('@google-cloud/storage', () => { ... });
 *   const { spies } = require('./_setupMocks');           // spies on lib modules
 *   const { router } = require('../../routes/products');  // gets spied versions
 */

const firestoreModule = require('../../lib/firestore');

// Create spies on ALL exported functions
const spies = {};
for (const [key, value] of Object.entries(firestoreModule)) {
  if (typeof value === 'function') {
    spies[key] = vi.spyOn(firestoreModule, key).mockResolvedValue(
      key.startsWith('get') || key.startsWith('find') || key.startsWith('list') ? null :
      key.startsWith('compute') ? 0 :
      undefined
    );
  }
}

// Set sensible default return types
spies.getAllProducts?.mockResolvedValue([]);
spies.getAllProductsForTenant?.mockResolvedValue([]);
spies.listOrders?.mockResolvedValue([]);
spies.listInventories?.mockResolvedValue([]);
spies.listOrdersByStatus?.mockResolvedValue([]);
spies.findProductIdsByAliases?.mockResolvedValue([]);
spies.getDashboardMetrics?.mockResolvedValue({});
spies.saveProduct?.mockResolvedValue({});
spies.deleteProduct?.mockResolvedValue();

module.exports = { spies, firestoreModule };
