const { preparePhotoEditorImage, validatePhotoEditorImages, imageAssetUrls } = require('../lib/photo-editor-assets');

const data = 'data:image/png;base64,aGVsbG8=';
const ownUrl = (name) => `https://storage.googleapis.com/prodsandjobs/products/p/${name}.png`;
const editorImage = () => ({
  source: 'upload', variant: 'front', url_or_base64: data, notes: 'Originalaufnahme',
  customEvidence: { retained: true },
  photoEditor: { version: 1, originalUrl: data, originalMimeType: 'image/png', maskUrl: data,
    recipe: { exposure: 0.2, crop: { x: 0, y: 0, width: 1, height: 1 } }, updatedAt: '2026-09-27T12:00:00.000Z' },
});

describe('durable photo-editor assets', () => {
  let upload;
  beforeEach(() => {
    upload = vi.fn(async (_src, _product, role) => ({ url: ownUrl(role), mimeType: 'image/png', width: 2400, height: 1800 }));
  });
  it('uploads all inline assets before returning, keeps recipe and arbitrary existing image evidence', async () => {
    const input = editorImage();
    const result = await preparePhotoEditorImage(input, 'p', upload);
    expect(upload.mock.calls.map((call) => call[2])).toEqual(['original', 'mask', 'render']);
    expect(result).toMatchObject({ source: 'upload', customEvidence: { retained: true }, width: 2400, height: 1800,
      url_or_base64: ownUrl('render'), photoEditor: { originalUrl: ownUrl('original'), maskUrl: ownUrl('mask'), recipe: input.photoEditor.recipe } });
    expect(JSON.stringify(result)).not.toContain('data:');
    expect(input.url_or_base64).toBe(data);
    expect(input.photoEditor.originalUrl).toBe(data);
  });
  it('reuses durable source and mask when editing again without uploading them', async () => {
    const input = editorImage();
    input.photoEditor.originalUrl = ownUrl('original');
    input.photoEditor.maskUrl = ownUrl('mask');
    await preparePhotoEditorImage(input, 'p', upload);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][2]).toBe('render');
  });
  it('restores the durable original with no new uploads', async () => {
    const input = editorImage();
    input.url_or_base64 = input.photoEditor.originalUrl = ownUrl('original');
    delete input.photoEditor.maskUrl;
    const result = await preparePhotoEditorImage(input, 'p', upload);
    expect(upload).not.toHaveBeenCalled();
    expect(result.url_or_base64).toBe(ownUrl('original'));
  });
  it.each(['original', 'mask', 'render'])('never returns a partial image when %s fails', async (failedRole) => {
    upload.mockImplementation(async (_src, _product, role) => {
      if (role === failedRole) throw new Error('offline');
      return { url: ownUrl(role), mimeType: 'image/png' };
    });
    await expect(preparePhotoEditorImage(editorImage(), 'p', upload)).rejects.toMatchObject({ code: 'PHOTO_EDITOR_UPLOAD_FAILED', status: 503 });
  });
  it.each(['https://example.org/original.jpg', 'blob:abc', 'http://127.0.0.1/x', 'https://storage.googleapis.com/foreign/products/p/a.png'])('rejects non-durable source %s before uploads', async (url) => {
    const input = editorImage(); input.photoEditor.originalUrl = url;
    await expect(preparePhotoEditorImage(input, 'p', upload)).rejects.toMatchObject({ status: 422 });
    expect(upload).not.toHaveBeenCalled();
  });
  it('rejects embedded assets and oversized recipe state before uploads', async () => {
    const input = editorImage(); input.photoEditor.recipe = { bad: data };
    await expect(preparePhotoEditorImage(input, 'p', upload)).rejects.toMatchObject({ status: 422 });
    input.photoEditor.recipe = { bad: 'x'.repeat(20000) };
    await expect(preparePhotoEditorImage(input, 'p', upload)).rejects.toMatchObject({ status: 422 });
    expect(upload).not.toHaveBeenCalled();
  });
  it('rejects unsupported versions and invalid timestamps instead of losing the recipe', async () => {
    const input = editorImage(); input.photoEditor.version = 2;
    await expect(preparePhotoEditorImage(input, 'p', upload)).rejects.toMatchObject({ status: 422 });
    input.photoEditor.version = 1; input.photoEditor.updatedAt = 'not a date';
    await expect(preparePhotoEditorImage(input, 'p', upload)).rejects.toMatchObject({ status: 422 });
  });
  it('allows bounded manual mask corrections and caps aggregate document metadata', () => {
    const input = editorImage();
    input.photoEditor.recipe = { maskStrokes: Array.from({ length: 30 }, () => ({ mode: 'erase', radius: 0.025,
      points: Array.from({ length: 60 }, () => ({ x: 0.1234, y: 0.5678 })) })) };
    expect(() => validatePhotoEditorImages([input])).not.toThrow();
    expect(() => validatePhotoEditorImages(Array.from({ length: 10 }, () => input))).toThrow(/umfangreich/);
    input.photoEditor.recipe.maskStrokes.push({ mode: 'restore', radius: 0.02, points: [] });
    expect(() => validatePhotoEditorImages([input])).toThrow(/Korrekturen/);
  });
  it('leaves legacy photos untouched', async () => {
    const image = { url_or_base64: 'https://example.org/a.png', source: 'web' };
    expect(await preparePhotoEditorImage(image, 'p', upload)).toBe(image);
    expect(upload).not.toHaveBeenCalled();
  });
  it('finds all original and mask folder references, including legacy source shapes', () => {
    expect(imageAssetUrls({ url_or_base64: { url: ownUrl('render') }, photoEditor: { originalUrl: ownUrl('original'), maskUrl: ownUrl('mask') } }))
      .toEqual([ownUrl('render'), ownUrl('original'), ownUrl('mask')]);
    expect(imageAssetUrls(ownUrl('legacy'))).toEqual([ownUrl('legacy')]);
  });
});
