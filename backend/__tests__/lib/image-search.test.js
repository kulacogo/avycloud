'use strict';

const serpapiPath = require.resolve('../../lib/serpapi');
const callSerpApiMock = vi.fn();

require.cache[serpapiPath] = {
  id: serpapiPath,
  filename: serpapiPath,
  loaded: true,
  exports: {
    callSerpApi: callSerpApiMock,
    summarizeSerpEntries: vi.fn(() => []),
    extractImageMeta: vi.fn(),
    isLowResImage: vi.fn(() => false),
  },
};

const { searchProductImages, isSerpApiLikelyConfigured } = require('../../lib/image-search');

describe('image-search SerpAPI configuration guards', () => {
  const prevSerp = process.env.SERPAPI_KEY;
  const prevGcp = process.env.GCP_PROJECT;
  const prevGoogle = process.env.GOOGLE_CLOUD_PROJECT;
  const prevGcloud = process.env.GCLOUD_PROJECT;

  afterEach(() => {
    process.env.SERPAPI_KEY = prevSerp;
    process.env.GCP_PROJECT = prevGcp;
    process.env.GOOGLE_CLOUD_PROJECT = prevGoogle;
    process.env.GCLOUD_PROJECT = prevGcloud;
    callSerpApiMock.mockReset();
  });

  it('returns false when no direct key and no cloud project env is set', () => {
    delete process.env.SERPAPI_KEY;
    delete process.env.GCP_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;
    expect(isSerpApiLikelyConfigured()).toBe(false);
  });

  it('skips external call when SerpAPI is not configured', async () => {
    delete process.env.SERPAPI_KEY;
    delete process.env.GCP_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;

    const result = await searchProductImages(
      { identification: { brand: 'Bosch', name: 'Filter' } },
      { query: 'Bosch Filter' }
    );
    expect(result).toEqual([]);
    expect(callSerpApiMock).not.toHaveBeenCalled();
  });
});
