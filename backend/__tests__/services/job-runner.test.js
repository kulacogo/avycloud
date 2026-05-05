'use strict';

const jobsPath = require.resolve('../../lib/jobs');
const storagePath = require.resolve('../../lib/storage');
const enrichmentPath = require.resolve('../../services/enrichment');
const identifyGroundingPath = require.resolve('../../services/identify-grounding');
const firestorePath = require.resolve('../../lib/firestore');
const productStorePath = require.resolve('../../lib/product-store');
const identityPath = require.resolve('../../lib/product-identity');
const qualityJobsPath = require.resolve('../../lib/quality-jobs');
const qualityRunnerPath = require.resolve('../../services/quality-runner');
const qualityPath = require.resolve('../../lib/datasheet-quality');

const claimJobMock = vi.fn();
const updateJobMock = vi.fn();
const listJobsByStatusMock = vi.fn();
const moveToDeadLetterMock = vi.fn();
const downloadFileMock = vi.fn();
const runProductIdentificationMock = vi.fn();
const runProductIdentificationGroundingMock = vi.fn();
const getProductMock = vi.fn();
const findProductByIdentityKeyMock = vi.fn();
const findProductByIdentityAliasesMock = vi.fn();
const findProductByStrictIdentifierMock = vi.fn();
const findProductByNameBrandMock = vi.fn();
const adjustPendingIntakeQuantityMock = vi.fn();
const appendProductIdentityAliasesMock = vi.fn();
const removeProductIdentityAliasesMock = vi.fn();
const getInventoryRecordMock = vi.fn();
const setProductInventoryMock = vi.fn();
const saveProductV2Mock = vi.fn();
const computeProductIdentityKeyMock = vi.fn();
const buildIdentityAliasSetMock = vi.fn();
const createQualityJobMock = vi.fn();
const enqueueQualityJobMock = vi.fn();
const evaluateEbayReadyMock = vi.fn();

require.cache[jobsPath] = {
  id: jobsPath,
  filename: jobsPath,
  loaded: true,
  exports: {
    Timestamp: { now: () => ({ toDate: () => new Date() }) },
    claimJob: claimJobMock,
    updateJob: updateJobMock,
    listJobsByStatus: listJobsByStatusMock,
    moveToDeadLetter: moveToDeadLetterMock,
  },
};

require.cache[storagePath] = {
  id: storagePath,
  filename: storagePath,
  loaded: true,
  exports: { downloadFile: downloadFileMock },
};

require.cache[enrichmentPath] = {
  id: enrichmentPath,
  filename: enrichmentPath,
  loaded: true,
  exports: { runProductIdentification: runProductIdentificationMock },
};

require.cache[identifyGroundingPath] = {
  id: identifyGroundingPath,
  filename: identifyGroundingPath,
  loaded: true,
  exports: { runProductIdentificationGrounding: runProductIdentificationGroundingMock },
};

require.cache[firestorePath] = {
  id: firestorePath,
  filename: firestorePath,
  loaded: true,
  exports: {
    getProduct: getProductMock,
    findProductByIdentityKey: findProductByIdentityKeyMock,
    findProductByIdentityAliases: findProductByIdentityAliasesMock,
    findProductByStrictIdentifier: findProductByStrictIdentifierMock,
    findProductByNameBrand: findProductByNameBrandMock,
    adjustPendingIntakeQuantity: adjustPendingIntakeQuantityMock,
    appendProductIdentityAliases: appendProductIdentityAliasesMock,
    removeProductIdentityAliases: removeProductIdentityAliasesMock,
    getInventoryRecord: getInventoryRecordMock,
    setProductInventory: setProductInventoryMock,
  },
};

require.cache[productStorePath] = {
  id: productStorePath,
  filename: productStorePath,
  loaded: true,
  exports: { saveProductV2: saveProductV2Mock },
};

require.cache[identityPath] = {
  id: identityPath,
  filename: identityPath,
  loaded: true,
  exports: {
    computeProductIdentityKey: computeProductIdentityKeyMock,
    buildIdentityAliasSet: buildIdentityAliasSetMock,
  },
};

require.cache[qualityJobsPath] = {
  id: qualityJobsPath,
  filename: qualityJobsPath,
  loaded: true,
  exports: { createJob: createQualityJobMock },
};

require.cache[qualityRunnerPath] = {
  id: qualityRunnerPath,
  filename: qualityRunnerPath,
  loaded: true,
  exports: { enqueueQualityJob: enqueueQualityJobMock },
};

require.cache[qualityPath] = {
  id: qualityPath,
  filename: qualityPath,
  loaded: true,
  exports: { evaluateEbayReady: evaluateEbayReadyMock },
};

const { _testables } = require('../../services/job-runner');

function buildJobSnapshot() {
  return {
    id: 'job-1',
    attempts: 1,
    payload: {
      files: [{ path: 'gs://bucket/file.jpg', originalName: 'file.jpg', mimeType: 'image/jpeg' }],
      barcodes: '4012345678901',
      locale: 'de-DE',
    },
  };
}

function buildProduct(id = 'prod-1') {
  return {
    id,
    identification: {
      name: 'Bosch Teil',
      brand: 'Bosch',
      barcodes: ['4012345678901'],
      sku: 'SKU-1',
    },
    details: {
      categoryId: '12345',
      identifiers: { ean: '4012345678901' },
      images: [{ url_or_base64: 'https://img.example/1.jpg' }],
      attributes: {},
    },
    ops: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.IDENTIFY_GROUNDING = 'true';

  claimJobMock.mockResolvedValue(buildJobSnapshot());
  updateJobMock.mockResolvedValue({});
  listJobsByStatusMock.mockResolvedValue([]);
  moveToDeadLetterMock.mockResolvedValue({});
  downloadFileMock.mockResolvedValue({ buffer: Buffer.from('img'), size: 3 });
  runProductIdentificationMock.mockResolvedValue({ bundle: { products: [buildProduct('legacy-1')] }, serpTrace: [] });
  runProductIdentificationGroundingMock.mockResolvedValue({
    bundle: { products: [buildProduct('ground-1')] },
    serpTrace: [],
    modelUsed: 'gemini',
  });
  getProductMock.mockResolvedValue(null);
  findProductByIdentityKeyMock.mockResolvedValue(null);
  findProductByIdentityAliasesMock.mockResolvedValue(null);
  findProductByStrictIdentifierMock.mockResolvedValue(null);
  findProductByNameBrandMock.mockResolvedValue(null);
  adjustPendingIntakeQuantityMock.mockResolvedValue(1);
  appendProductIdentityAliasesMock.mockResolvedValue({});
  removeProductIdentityAliasesMock.mockResolvedValue({});
  getInventoryRecordMock.mockResolvedValue(null);
  setProductInventoryMock.mockResolvedValue({});
  saveProductV2Mock.mockResolvedValue({});
  computeProductIdentityKeyMock.mockReturnValue('identity-key');
  buildIdentityAliasSetMock.mockReturnValue(['alias:a']);
  createQualityJobMock.mockResolvedValue({});
  enqueueQualityJobMock.mockResolvedValue({});
  evaluateEbayReadyMock.mockReturnValue({
    ok: true,
    issues: [],
    issuesDetailed: [],
    snapshot: { ready: true },
  });
});

describe('job-runner processJob', () => {
  it('saves product in system mode with identify save options', async () => {
    await _testables.processJob('job-1');

    expect(saveProductV2Mock).toHaveBeenCalledTimes(1);
    const [productArg, optionsArg] = saveProductV2Mock.mock.calls[0];
    expect(productArg.ops.identify_pipeline).toBe('grounding');
    expect(productArg.ops.data_quality.identify_job_quality_v1).toBeTruthy();
    expect(optionsArg).toEqual(
      expect.objectContaining({
        mode: 'system',
        source: 'identify',
        overwriteTextFields: true,
        replaceAttributes: true,
        syncIdentifiersFromBarcodes: true,
      })
    );
    expect(updateJobMock).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'done' })
    );
  });

  it('falls back to legacy pipeline and tags identify_pipeline accordingly', async () => {
    runProductIdentificationGroundingMock.mockRejectedValueOnce(new Error('grounding down'));

    await _testables.processJob('job-1');

    expect(runProductIdentificationMock).toHaveBeenCalledTimes(1);
    const [productArg] = saveProductV2Mock.mock.calls[0];
    expect(productArg.ops.identify_pipeline).toBe('legacy');
  });
});
