/**
 * Patches local backend modules in Node's require.cache BEFORE any route
 * modules are loaded. This works around Vitest 4.x's broken vi.mock() for
 * CJS modules by operating directly on Node's module system.
 *
 * USAGE (in test file, AFTER _patchGcp but BEFORE requiring routes):
 *   require('./_patchLocalModules');
 */

const path = require('path');
// vi is available globally via vitest.config.js globals: true

// Helper: resolve module path and patch require.cache
function patchLocalModule(modulePath, mockExports) {
  try {
    const resolvedPath = require.resolve(modulePath);
    require.cache[resolvedPath] = {
      id: resolvedPath,
      filename: resolvedPath,
      loaded: true,
      exports: mockExports,
      children: [],
      paths: [],
    };
  } catch (_) {
    // Module not found — skip
  }
}

// ─── Create mock implementations for all local modules ──────────────────────

const spies = {};

// lib/rbac.js
spies.requirePermission = vi.fn(() => (req, res, next) => next());
spies.resolvePermissionsForUser = vi.fn().mockResolvedValue({});
patchLocalModule('../../lib/rbac.js', {
  requirePermission: spies.requirePermission,
  resolvePermissionsForUser: spies.resolvePermissionsForUser,
});

// lib/product-store.js
spies.saveProductV2 = vi.fn().mockResolvedValue({});
patchLocalModule('../../lib/product-store.js', {
  saveProductV2: spies.saveProductV2,
});

// lib/product-identity.js
spies.buildIdentityAliasSet = vi.fn(() => []);
spies.computeProductIdentityKey = vi.fn(() => 'test-identity-key');
patchLocalModule('../../lib/product-identity.js', {
  buildIdentityAliasSet: spies.buildIdentityAliasSet,
  computeProductIdentityKey: spies.computeProductIdentityKey,
});

// lib/improve-jobs.js
spies.improveJobsCreateJob = vi.fn().mockResolvedValue({});
spies.improveJobsGetJob = vi.fn().mockResolvedValue(null);
spies.improveJobsUpdateJob = vi.fn().mockResolvedValue({});
patchLocalModule('../../lib/improve-jobs.js', {
  createJob: spies.improveJobsCreateJob,
  getJob: spies.improveJobsGetJob,
  updateJob: spies.improveJobsUpdateJob,
  Timestamp: { now: () => ({ seconds: 0 }), fromDate: (d) => d },
});

// lib/storage.js
spies.uploadBase64Image = vi.fn().mockResolvedValue('https://mock-image-url');
spies.deleteProductImages = vi.fn().mockResolvedValue();
patchLocalModule('../../lib/storage.js', {
  uploadBase64Image: spies.uploadBase64Image,
  deleteProductImages: spies.deleteProductImages,
});

// lib/product-images.js
spies.recordManualProductImage = vi.fn().mockResolvedValue({});
patchLocalModule('../../lib/product-images.js', {
  recordManualProductImage: spies.recordManualProductImage,
});

// lib/web-unlocker.js
spies.fetchWithUnlocker = vi.fn().mockResolvedValue({ text: () => Promise.resolve('') });
patchLocalModule('../../lib/web-unlocker.js', {
  fetchWithUnlocker: spies.fetchWithUnlocker,
});

// lib/ebay-category-governance.js
spies.isBannedEbayBreadcrumb = vi.fn(() => false);
patchLocalModule('../../lib/ebay-category-governance.js', {
  isBannedEbayBreadcrumb: spies.isBannedEbayBreadcrumb,
});

// lib/ebay-taxonomy.js
spies.getCategoryAspectCatalog = vi.fn(() => null);
spies.findEbayCategory = vi.fn(() => null);
spies.getEbayRequiredAspects = vi.fn(() => []);
spies.getEbayCategoryAspectCatalog = vi.fn(() => null);
spies.getEbayCategories = vi.fn(() => ({}));
patchLocalModule('../../lib/ebay-taxonomy.js', {
  getCategoryAspectCatalog: spies.getCategoryAspectCatalog,
  findEbayCategory: spies.findEbayCategory,
  getEbayRequiredAspects: spies.getEbayRequiredAspects,
  getEbayCategoryAspectCatalog: spies.getEbayCategoryAspectCatalog,
  getEbayCategories: spies.getEbayCategories,
});

// services/improve.js
spies.improveExistingProduct = vi.fn().mockResolvedValue({});
patchLocalModule('../../services/improve.js', {
  improveExistingProduct: spies.improveExistingProduct,
});

// lib/price-enrichment.js
spies.enrichPriceForProductBestEffort = vi.fn().mockResolvedValue({});
patchLocalModule('../../lib/price-enrichment.js', {
  enrichPriceForProductBestEffort: spies.enrichPriceForProductBestEffort,
});

// lib/jobs.js
patchLocalModule('../../lib/jobs.js', {
  FieldValue: { serverTimestamp: () => null, increment: (n) => n },
});

// lib/warehouse.js
spies.listBinsForProduct = vi.fn().mockResolvedValue([]);
spies.getProductBinSummaryMap = vi.fn().mockResolvedValue(new Map());
patchLocalModule('../../lib/warehouse.js', {
  listBinsForProduct: spies.listBinsForProduct,
  getProductBinSummaryMap: spies.getProductBinSummaryMap,
});

// services/label-printer.js
spies.buildProductLabelsHtml = vi.fn().mockResolvedValue('<html></html>');
spies.buildBinLabelHtml = vi.fn(() => '<html></html>');
spies.buildBinLabelsHtml = vi.fn(() => '<html></html>');
spies.buildBinLabelsPdf = vi.fn().mockResolvedValue(Buffer.from('pdf'));
spies.buildInventoryLabelPdf = vi.fn().mockResolvedValue(Buffer.from('pdf'));
patchLocalModule('../../services/label-printer.js', {
  buildProductLabelsHtml: spies.buildProductLabelsHtml,
  buildBinLabelHtml: spies.buildBinLabelHtml,
  buildBinLabelsHtml: spies.buildBinLabelsHtml,
  buildBinLabelsPdf: spies.buildBinLabelsPdf,
  buildInventoryLabelPdf: spies.buildInventoryLabelPdf,
});

// services/scanner.js
spies.scanToBuffer = vi.fn().mockResolvedValue(Buffer.from('image'));
patchLocalModule('../../services/scanner.js', {
  scanToBuffer: spies.scanToBuffer,
});

// lib/admin-bulk-jobs.js
spies.adminBulkJobsCreateJob = vi.fn().mockResolvedValue({ jobId: 'test-job' });
spies.adminBulkJobsGetJob = vi.fn().mockResolvedValue(null);
patchLocalModule('../../lib/admin-bulk-jobs.js', {
  createJob: spies.adminBulkJobsCreateJob,
  getJob: spies.adminBulkJobsGetJob,
});

// services/admin-bulk-runner.js
spies.enqueueAdminBulkJob = vi.fn().mockResolvedValue({ jobId: 'test-job' });
patchLocalModule('../../services/admin-bulk-runner.js', {
  enqueueAdminBulkJob: spies.enqueueAdminBulkJob,
});

// lib/quality-jobs.js
spies.qualityJobsCreateJob = vi.fn().mockResolvedValue({ jobId: 'test-job' });
spies.qualityJobsGetJob = vi.fn().mockResolvedValue(null);
spies.qualityJobsUpdateJob = vi.fn().mockResolvedValue({});
patchLocalModule('../../lib/quality-jobs.js', {
  createJob: spies.qualityJobsCreateJob,
  getJob: spies.qualityJobsGetJob,
  updateJob: spies.qualityJobsUpdateJob,
  Timestamp: { now: () => ({ seconds: 0 }) },
});

// services/quality-runner.js
spies.enqueueQualityJob = vi.fn().mockResolvedValue({ jobId: 'test-job' });
patchLocalModule('../../services/quality-runner.js', {
  enqueueQualityJob: spies.enqueueQualityJob,
});

// services/improve-runner.js
spies.enqueueImproveJob = vi.fn().mockResolvedValue({ jobId: 'test-job' });
patchLocalModule('../../services/improve-runner.js', {
  enqueueImproveJob: spies.enqueueImproveJob,
});

// lib/secret-values.js
spies.getSecretValue = vi.fn().mockResolvedValue('secret-value');
patchLocalModule('../../lib/secret-values.js', {
  getSecretValue: spies.getSecretValue,
});

// services/image-generation.js
spies.generateImagesForProduct = vi.fn().mockResolvedValue([]);
patchLocalModule('../../services/image-generation.js', {
  generateImagesForProduct: spies.generateImagesForProduct,
});

// services/pricing-engine.js
spies.calculateOptimalPrice = vi.fn().mockResolvedValue({ price: 29.99 });
spies.savePricingRule = vi.fn().mockResolvedValue({});
spies.listPricingRules = vi.fn().mockResolvedValue([]);
spies.runRepricingJob = vi.fn().mockResolvedValue({});
patchLocalModule('../../services/pricing-engine.js', {
  calculateOptimalPrice: spies.calculateOptimalPrice,
  savePricingRule: spies.savePricingRule,
  listPricingRules: spies.listPricingRules,
  runRepricingJob: spies.runRepricingJob,
});

// services/inventory-forecast.js
spies.calculateSalesVelocity = vi.fn().mockResolvedValue({ salesVelocity: 2.5 });
spies.predictStockOut = vi.fn().mockResolvedValue({ predictedStockOut: '2024-06-01' });
spies.generateReorderAlerts = vi.fn().mockResolvedValue([]);
patchLocalModule('../../services/inventory-forecast.js', {
  calculateSalesVelocity: spies.calculateSalesVelocity,
  predictStockOut: spies.predictStockOut,
  generateReorderAlerts: spies.generateReorderAlerts,
});

// services/webhooks.js
spies.createWebhook = vi.fn().mockResolvedValue({});
spies.listWebhooks = vi.fn(() => []);
spies.deleteWebhook = vi.fn().mockResolvedValue();
patchLocalModule('../../services/webhooks.js', {
  createWebhook: spies.createWebhook,
  listWebhooks: spies.listWebhooks,
  deleteWebhook: spies.deleteWebhook,
});

// services/deduplication.js
spies.findDuplicates = vi.fn().mockResolvedValue([]);
spies.suggestMerge = vi.fn().mockResolvedValue({});
spies.executeMerge = vi.fn().mockResolvedValue({});
patchLocalModule('../../services/deduplication.js', {
  findDuplicates: spies.findDuplicates,
  suggestMerge: spies.suggestMerge,
  executeMerge: spies.executeMerge,
});

// services/order-sync.js (for orders.test.js)
spies.syncNewOrders = vi.fn().mockResolvedValue({ synced: 0 });
spies.markOrderAsPicked = vi.fn().mockResolvedValue({});
spies.markOrderAsPacked = vi.fn().mockResolvedValue({});
patchLocalModule('../../services/order-sync.js', {
  syncNewOrders: spies.syncNewOrders,
  markOrderAsPicked: spies.markOrderAsPicked,
  markOrderAsPacked: spies.markOrderAsPacked,
});

// services/pick-hints.js (for orders.test.js)
spies.attachPickHintsToOrders = vi.fn((orders) => orders);
patchLocalModule('../../services/pick-hints.js', {
  attachPickHintsToOrders: spies.attachPickHintsToOrders,
});

// lib/sevdesk.js (for orders.test.js)
spies.getCheckAccountBalances = vi.fn().mockResolvedValue([]);
spies.getShippingCostsFromSevDesk = vi.fn().mockResolvedValue({});
patchLocalModule('../../lib/sevdesk.js', {
  getCheckAccountBalances: spies.getCheckAccountBalances,
  getShippingCostsFromSevDesk: spies.getShippingCostsFromSevDesk,
});

// lib/sendcloud.js (for orders.test.js)
spies.getShippingCostsSummary = vi.fn().mockResolvedValue({});
patchLocalModule('../../lib/sendcloud.js', {
  getShippingCostsSummary: spies.getShippingCostsSummary,
});

// lib/ebay-finances.js (for orders.test.js)
spies.getEbayNetRevenueSummary = vi.fn().mockResolvedValue({});
patchLocalModule('../../lib/ebay-finances.js', {
  getEbayNetRevenueSummary: spies.getEbayNetRevenueSummary,
});

module.exports = { spies };
