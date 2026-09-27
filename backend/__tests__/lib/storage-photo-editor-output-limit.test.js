const { mockFile } = require('../api/_patchGcp');
const { MAX_ASSET_BYTES } = require('../../lib/photo-editor-assets');

// A small compressed source can expand beyond the editor's download limit when
// resized/auto-oriented to lossless PNG. Model that encoder output without a
// costly multi-megapixel random-image fixture.
const pipeline = {
  metadata: async () => ({ format: 'jpeg', width: 5000, height: 3000 }),
  rotate() { return this; }, resize() { return this; }, png() { return this; },
  toBuffer: async () => ({ data: Buffer.alloc(MAX_ASSET_BYTES + 1), info: { width: 4096, height: 2458 } }),
};
const sharpPath = require.resolve('sharp');
require.cache[sharpPath] = { id: sharpPath, filename: sharpPath, loaded: true, exports: () => pipeline, children: [], paths: [] };
const { uploadPhotoEditorAsset } = require('../../lib/storage');

it('rejects normalized PNG larger than the reopen limit before uploading any asset', async () => {
  mockFile.save.mockClear();
  await expect(uploadPhotoEditorAsset('data:image/jpeg;base64,aGVsbG8=', 'p', 'original'))
    .rejects.toMatchObject({ code: 'INVALID_PHOTO_EDITOR', status: 422 });
  expect(mockFile.save).not.toHaveBeenCalled();
});
