const path = require('path');
const fetchSpy = vi.fn();
const guardSpy = vi.fn();
function patch(name, exports) {
  const id = require.resolve(name);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
const realGuard = require('../lib/ssrf-guard');
patch('node-fetch', fetchSpy);
patch(path.resolve(__dirname, '../lib/ssrf-guard'), { ...realGuard, assertPublicHost: guardSpy });
const { researchDownload } = require('../lib/research-download');
const response = (status = 200, mime = 'text/html') => ({
  status, ok: status === 200,
  body: { destroy: vi.fn() },
  headers: { get: key => key === 'location' ? 'http://169.254.169.254/private' : mime },
  buffer: async () => Buffer.from('page'),
});

beforeEach(() => {
  vi.clearAllMocks();
  guardSpy.mockImplementation(async url => {
    if (String(url).includes('169.254')) throw new Error('private destination');
    return new URL(url);
  });
  fetchSpy.mockResolvedValue(response());
});

test('guards initial URL and every redirect, never fetching metadata targets', async () => {
  fetchSpy.mockResolvedValue(response(302));
  await expect(researchDownload('https://retailer.example/item')).rejects.toThrow('private');
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(fetchSpy.mock.calls[0][1].redirect).toBe('manual');
});

test('rejects credentials and nonstandard ports before download', async () => {
  for (const url of ['https://user:secret@shop.example/item', 'https://shop.example:8080/item']) await expect(researchDownload(url)).rejects.toThrow('credentials/port');
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('uses bounded downloads and refuses HTML served as a product image', async () => {
  await expect(researchDownload('https://shop.example/photo', { image: true })).rejects.toThrow('unsupported');
  expect(fetchSpy.mock.calls[0][1].size).toBe(12 * 1024 * 1024);
  fetchSpy.mockResolvedValue(response());
  expect((await researchDownload('https://shop.example/item')).body).toBe('page');
  expect(fetchSpy.mock.calls.at(-1)[1].size).toBe(2 * 1024 * 1024);
});

test('expired deadlines never issue requests', async () => {
  await expect(researchDownload('https://shop.example', { deadline: Date.now() - 1 })).rejects.toThrow('deadline');
  expect(fetchSpy).not.toHaveBeenCalled();
});
