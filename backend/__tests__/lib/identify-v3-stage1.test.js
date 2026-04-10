'use strict';

// Patch all CJS dependencies before loading the module under test

const extractOcrPayloadMock = vi.fn(async () => ({
  barcodes: ['4548736132610'],
  barcodeDetails: [],
  textSnippets: ['Sony WH-1000XM5'],
  numericValues: [],
  web: { bestGuessLabels: [], webEntities: [], pagesWithMatchingImages: [], logos: [] },
  byFile: [],
}));

const uploadImageMock = vi.fn(async (buf, mime, folder, name) => ({
  url: `https://storage.example.com/${folder}/${name}.jpg`,
  width: 800,
  height: 600,
}));

const lookupEanMock = vi.fn(async () => ({
  found: true,
  source: 'open_ean_db',
  productName: 'Sony WH-1000XM5',
  brand: 'Sony',
  category: 'Elektronik',
  description: null,
  imageUrl: null,
}));

const identifyProductFocusedMock = vi.fn(async () => ({
  brand: 'Sony',
  model: 'WH-1000XM5',
  mpn: 'WH1000XM5B.CE7',
  variant: 'Schwarz',
  ean: '4548736132610',
  gtin: '',
  upc: '',
  condition: 'Neu',
  internalCategory: 'Elektronik > Kopfhoerer > Over-Ear',
  weight_grams: 250,
  color: 'Schwarz',
  size: '',
  material: '',
  notes: '',
  _grounding: {
    model: 'gemini-3-pro-preview',
    searchQueries: ['Sony WH-1000XM5 specs'],
    sources: [{ title: 'Sony.com', url: 'https://sony.com/xm5' }],
  },
}));

// Patch require.cache
const visionOcrPath = require.resolve('../../lib/vision-ocr');
require(visionOcrPath);
require.cache[visionOcrPath] = {
  id: visionOcrPath, filename: visionOcrPath, loaded: true,
  exports: { extractOcrPayload: extractOcrPayloadMock },
};

const storagePath = require.resolve('../../lib/storage');
require(storagePath);
require.cache[storagePath] = {
  id: storagePath, filename: storagePath, loaded: true,
  exports: { uploadImage: uploadImageMock, downloadFile: vi.fn() },
};

const eanDbPath = require.resolve('../../lib/ean-database');
require(eanDbPath);
require.cache[eanDbPath] = {
  id: eanDbPath, filename: eanDbPath, loaded: true,
  exports: { lookupEan: lookupEanMock },
};

const geminiPath = require.resolve('../../lib/gemini3-client');
require(geminiPath);
require.cache[geminiPath] = {
  id: geminiPath, filename: geminiPath, loaded: true,
  exports: {
    identifyProductFocused: identifyProductFocusedMock,
    getGenAIClient: vi.fn(),
    identifyProductWithGrounding: vi.fn(),
    buildImprovePromptExtension: vi.fn(() => ''),
    FULL_PRODUCT_SCHEMA: {},
    RECOGNITION_SCHEMA: {},
    CONTENT_SCHEMA: {},
    DEFAULT_MODEL: 'gemini-3-pro-preview',
  },
};

const { runStage1Recognition } = require('../../lib/identify-v3-stage1');

beforeEach(() => {
  vi.clearAllMocks();
  // Reset mocks to defaults
  extractOcrPayloadMock.mockImplementation(async () => ({
    barcodes: ['4548736132610'],
    textSnippets: ['Sony WH-1000XM5'],
    numericValues: [],
    web: { bestGuessLabels: [], webEntities: [], pagesWithMatchingImages: [], logos: [] },
    byFile: [],
  }));
  lookupEanMock.mockImplementation(async () => ({
    found: true, source: 'open_ean_db', productName: 'Sony WH-1000XM5',
    brand: 'Sony', category: 'Elektronik', description: null, imageUrl: null,
  }));
  identifyProductFocusedMock.mockImplementation(async () => ({
    brand: 'Sony', model: 'WH-1000XM5', mpn: 'WH1000XM5B.CE7',
    variant: 'Schwarz', ean: '4548736132610', condition: 'Neu',
    internalCategory: 'Elektronik > Kopfhoerer > Over-Ear',
    weight_grams: 250, color: 'Schwarz',
    _grounding: { model: 'gemini-3-pro-preview', searchQueries: [], sources: [] },
  }));
});

describe('runStage1Recognition', () => {
  const fakeFiles = [{
    buffer: Buffer.from('fake-image-data'),
    mimetype: 'image/jpeg',
    originalname: 'test.jpg',
    size: 1000,
  }];

  it('merges identity from grounding + EAN DB', async () => {
    const result = await runStage1Recognition({
      files: fakeFiles,
      barcodes: '4548736132610',
    });

    expect(result.identity.brand).toBe('Sony');
    expect(result.identity.model).toBe('WH-1000XM5');
    expect(result.identity.mpn).toBe('WH1000XM5B.CE7');
    expect(result.identity.internalCategory).toBe('Elektronik > Kopfhoerer > Over-Ear');
  });

  it('runs OCR, EAN lookup, and grounding', async () => {
    await runStage1Recognition({ files: fakeFiles, barcodes: '4548736132610' });

    expect(extractOcrPayloadMock).toHaveBeenCalledTimes(1);
    expect(lookupEanMock).toHaveBeenCalledWith('4548736132610');
    expect(identifyProductFocusedMock).toHaveBeenCalledTimes(1);
  });

  it('merges barcodes from OCR + grounding + explicit', async () => {
    const result = await runStage1Recognition({
      files: fakeFiles,
      barcodes: '4548736132610',
    });

    expect(result.barcodes.ean).toBe('4548736132610');
    expect(result.barcodes.ranked.length).toBeGreaterThan(0);
    expect(result.barcodes.explicit).toEqual(['4548736132610']);
  });

  it('handles EAN lookup timeout without blocking', async () => {
    lookupEanMock.mockImplementation(() => Promise.reject(new Error('Timeout')));

    const result = await runStage1Recognition({
      files: fakeFiles,
      barcodes: '4548736132610',
    });

    // Should still have identity from grounding
    expect(result.identity.brand).toBe('Sony');
    expect(result.eanLookup).toBeNull();
  });

  it('handles grounding failure gracefully', async () => {
    identifyProductFocusedMock.mockRejectedValueOnce(new Error('Gemini down'));

    const result = await runStage1Recognition({
      files: fakeFiles,
      barcodes: '4548736132610',
    });

    // Falls back to EAN DB data
    expect(result.identity.brand).toBe('Sony');
    expect(result._meta.groundingUsed).toBe(false);
  });

  it('works with barcode-only mode (no images)', async () => {
    extractOcrPayloadMock.mockImplementation(async () => ({
      barcodes: [], textSnippets: [], numericValues: [],
      web: { bestGuessLabels: [], webEntities: [], pagesWithMatchingImages: [], logos: [] },
      byFile: [],
    }));

    const result = await runStage1Recognition({
      files: [],
      barcodes: '4548736132610',
    });

    expect(result.barcodes.ean).toBe('4548736132610');
    expect(lookupEanMock).toHaveBeenCalled();
  });

  it('skips EAN lookup for invalid barcodes', async () => {
    const result = await runStage1Recognition({
      files: fakeFiles,
      barcodes: 'INVALID',
    });

    expect(lookupEanMock).not.toHaveBeenCalled();
    expect(result.eanLookup).toBeNull();
  });

  it('includes timing metadata', async () => {
    const result = await runStage1Recognition({ files: fakeFiles, barcodes: '4548736132610' });

    expect(result._meta).toBeDefined();
    expect(result._meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(result._meta.groundingUsed).toBe(true);
  });

  it('cross-checks EAN DB brand against grounding brand', async () => {
    const result = await runStage1Recognition({ files: fakeFiles, barcodes: '4548736132610' });
    expect(result.eanBrandMatch).toBe(true);
  });

  it('detects brand mismatch between EAN DB and grounding', async () => {
    lookupEanMock.mockImplementation(async () => ({
      found: true, source: 'open_ean_db', productName: 'Different Product',
      brand: 'Samsung', category: 'Elektronik', description: null, imageUrl: null,
    }));

    const result = await runStage1Recognition({ files: fakeFiles, barcodes: '4548736132610' });
    expect(result.eanBrandMatch).toBe(false);
  });

  it('includes uploaded images in result', async () => {
    const result = await runStage1Recognition({ files: fakeFiles, barcodes: '' });
    expect(result.uploadedImages.length).toBeGreaterThan(0);
    expect(result.uploadedImages[0]).toHaveProperty('url');
  });
});
