# Photo editor persistence — 2026-09-27

`details.images[]` gains one optional additive field. Existing image identity,
source, AI/provenance flags and arbitrary metadata are preserved:

```ts
photoEditor?: {
  version: 1;
  originalUrl: string;
  originalMimeType?: "image/png" | "image/jpeg" | "image/webp";
  maskUrl?: string;
  recipe: object;
  updatedAt: string; // ISO timestamp
}
```

The frontend supplies the first original as a data URL from its loaded image,
including external web photos. Subsequent edits reuse the durable original URL.
The mask contains segmentation alpha before crop/rotation/colour adjustments,
with the original aspect ratio and at most 4096 pixels on the longest edge.
It must be lossless PNG. Source transparency is applied by the renderer only
once; brush corrections remain in the recipe.

`POST /api/save` validates every editor image before uploading any of them.
`backend/lib/photo-editor-assets.js` then prepares original, mask and render;
`backend/lib/storage.js:uploadPhotoEditorAsset()` creates content-hashed objects
under the existing product folder with a create-only generation precondition.
Object URL path segments are encoded independently of the literal object name;
valid punctuation in a product ID cannot become a query string or fragment.
An already existing identical object is reused. No external image download or
new collection/route is introduced. Only owned HTTPS GCS product URLs and inline
PNG/JPEG/WebP are accepted in editor assets; inline bytes never reach Firestore.

The editor path is independent of legacy image normalization. It does not
enlarge small images and allows up to 4096 pixels on the longest edge. Images
already within this size and without pending EXIF rotation are stored byte for
byte; larger or EXIF-oriented assets are normalized once to lossless PNG. This
retains original pixels within the working resolution; it is not an archive of
larger camera originals. Existing legacy uploads retain their previous limits.

Asset input is capped at 20 MB and 64 megapixels. The prepared upload is also
capped at 20 MB, so a normalized PNG cannot exceed the editor's reopen limit.
Recipes are bounded plain JSON
up to 64 KiB, with at most 30 mask strokes of 60 points. Aggregate editor metadata
is capped at 256 KiB per product to leave space for ordinary product data. The
existing HTTP body limit still applies to the combined inline upload payload.

Any editor validation/upload failure aborts the product save before
`saveProductV2()` (`422 INVALID_PHOTO_EDITOR` or
`503 PHOTO_EDITOR_UPLOAD_FAILED`). Already uploaded content-addressed assets may
remain unreferenced after a later failure; retries are idempotent. The product
and its existing images are not replaced by a partial result. Legacy image
upload behavior is unchanged.

Normal product persistence and API hydration preserve the nested object.
`isProductImageFolderReferenced()` additionally examines `originalUrl` and
`maskUrl`, preventing deletion of a shared old folder merely because only the
editor source now points at it. Restore after reopening uses the durable source
and recipe; the transient undo/redo stack is a frontend concern.

Tests: `backend/__tests__/photo-editor-assets.test.js`,
`backend/__tests__/lib/storage-photo-editor.test.js`,
`backend/__tests__/api/products-photo-editor.test.js`, and
`backend/__tests__/product-image-folder-reference-guard.test.js`. Route tests
exercise save/read hydration and ensure each failed asset blocks product writes;
storage tests use real Sharp buffers with mocked GCS, never production assets.
