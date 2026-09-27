const { mockFile, mockBucket } = require('../api/_patchGcp');
const sharp = require('sharp');
const { preparePhotoEditorBuffer, uploadPhotoEditorAsset } = require('../../lib/storage');
const asData = (buffer, mime = 'png') => `data:image/${mime};base64,${buffer.toString('base64')}`;
const png = (width, height) => sharp({ create: { width, height, channels: 4, background: { r: 31, g: 71, b: 111, alpha: 0.35 } } }).png().toBuffer();

describe('photo-editor storage quality and immutability', () => {
  beforeEach(() => { mockFile.save.mockReset().mockResolvedValue(); mockBucket.file.mockClear(); });
  it('keeps prepared 2400px photos byte-identical rather than legacy 2000px resampling', async () => {
    const source = await png(2400, 1600);
    const result = await preparePhotoEditorBuffer(asData(source), 'render');
    expect(result.width).toBe(2400);
    expect(result.buffer.equals(source)).toBe(true);
  });
  it('does not enlarge small originals or alter their alpha values', async () => {
    const source = await png(32, 24);
    const result = await preparePhotoEditorBuffer(asData(source), 'original');
    expect(result).toMatchObject({ width: 32, height: 24, mimeType: 'image/png' });
    expect(result.buffer.equals(source)).toBe(true);
  });
  it('retains JPEG originals without another lossy encoding', async () => {
    const source = await sharp(await png(640, 480)).jpeg().toBuffer();
    const result = await preparePhotoEditorBuffer(asData(source, 'jpeg'), 'original');
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.buffer.equals(source)).toBe(true);
  });
  it('bounds a large mask to 4096px without losing alpha or changing aspect ratio', async () => {
    const result = await preparePhotoEditorBuffer(asData(await png(5000, 2500)), 'mask');
    expect(result).toMatchObject({ width: 4096, height: 2048, mimeType: 'image/png' });
    const { data, info } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    expect(data[3]).toBeGreaterThan(80);
    expect(data[3]).toBeLessThan(100);
  });
  it('normalizes EXIF orientation exactly once', async () => {
    const source = await sharp(await png(80, 40)).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const result = await preparePhotoEditorBuffer(asData(source, 'jpeg'), 'original');
    expect(result).toMatchObject({ width: 40, height: 80, mimeType: 'image/png' });
    const second = await preparePhotoEditorBuffer(asData(result.buffer), 'original');
    expect(second.buffer.equals(result.buffer)).toBe(true);
  });
  it('stores under content-hashed product names with create-only precondition', async () => {
    const source = await png(32, 24);
    const result = await uploadPhotoEditorAsset(asData(source), 'p', 'original');
    expect(result.url).toMatch(/\/products\/p\/photo-editor-original_[0-9a-f]{64}\.png$/);
    expect(mockFile.save).toHaveBeenCalledWith(source, expect.objectContaining({ preconditionOpts: { ifGenerationMatch: 0 }, validation: 'crc32c' }));
    mockFile.save.mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 412 }));
    expect((await uploadPhotoEditorAsset(asData(source), 'p', 'original')).url).toBe(result.url);
  });
  it('encodes valid punctuation in product IDs without changing the actual object name', async () => {
    const productId = 'SKU: A#B?C%20';
    const result = await uploadPhotoEditorAsset(asData(await png(16, 16)), productId, 'original');
    expect(mockBucket.file.mock.calls.at(-1)[0]).toContain(`products/${productId}/photo-editor-original_`);
    const url = new URL(result.url);
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(url.pathname).toContain(`/products/${encodeURIComponent(productId)}/`);
    expect(decodeURIComponent(url.pathname)).toContain(`/products/${productId}/`);
  });
  it('propagates storage failures and rejects invalid rasters instead of keeping inline bytes', async () => {
    mockFile.save.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(uploadPhotoEditorAsset(asData(await png(16, 16)), 'p', 'render')).rejects.toThrow('storage unavailable');
    await expect(preparePhotoEditorBuffer(asData(Buffer.from('not an image')), 'original')).rejects.toMatchObject({ code: 'INVALID_PHOTO_EDITOR' });
    const jpeg = await sharp(await png(16, 16)).jpeg().toBuffer();
    await expect(preparePhotoEditorBuffer(asData(jpeg, 'jpeg'), 'mask')).rejects.toMatchObject({ code: 'INVALID_PHOTO_EDITOR' });
  });
});
