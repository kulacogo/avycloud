'use strict';

// Editor assets are durable before the product is written. Never leave an
// inline original/mask in Firestore or silently save only the edited preview.
const MAX_RECIPE_BYTES = 64 * 1024;
const MAX_EDITOR_METADATA_BYTES = 256 * 1024;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;

function editorError(message, code = 'INVALID_PHOTO_EDITOR', status = 422) {
  return Object.assign(new Error(message), { code, status });
}

function isOwnedImageUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    const bucket = String(process.env.STORAGE_BUCKET || 'prodsandjobs').replace(/^gs:\/\//i, '').replace(/\/+$/, '');
    return url.protocol === 'https:' && url.hostname === 'storage.googleapis.com' &&
      !url.username && !url.password && !url.port && !url.search && !url.hash &&
      url.pathname.startsWith(`/${bucket}/products/`);
  } catch { return false; }
}

function validateAsset(value, role) {
  if (isOwnedImageUrl(value)) return;
  const mime = role === 'mask' ? 'png' : '(?:png|jpeg|webp)';
  const pattern = new RegExp(`^data:image/${mime};base64,[A-Za-z0-9+/]+={0,2}$`);
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_ASSET_BYTES * 4 / 3) + 64 || !pattern.test(value)) {
    throw editorError(`Bildbearbeitung: ${role === 'original' ? 'Original' : role === 'mask' ? 'Freistellung' : 'Ergebnis'} muss als Bilddatei oder gesicherte Bildadresse vorliegen.`);
  }
}

function validateRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) throw editorError('Ungültige Bildbearbeitungseinstellungen.');
  let nodes = 0;
  const visit = (value, depth) => {
    if (++nodes > 15000 || depth > 8) throw editorError('Bildbearbeitungseinstellungen sind zu umfangreich.');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value === 'string' && value.length <= 256 && !/^(?:data|blob|https?):/i.test(value)) return;
    if (!value || typeof value !== 'object') throw editorError('Ungültige Bildbearbeitungseinstellungen.');
    for (const [key, nested] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || key.length > 64) throw editorError('Ungültige Bildbearbeitungseinstellungen.');
      visit(nested, depth + 1);
    }
  };
  visit(recipe, 0);
  if (Buffer.byteLength(JSON.stringify(recipe)) > MAX_RECIPE_BYTES) throw editorError('Bildbearbeitungseinstellungen sind zu umfangreich.');
  if (recipe.maskStrokes != null && (!Array.isArray(recipe.maskStrokes) || recipe.maskStrokes.length > 30 ||
    recipe.maskStrokes.some((stroke) => !stroke || !['erase', 'restore'].includes(stroke.mode) || !Array.isArray(stroke.points) || stroke.points.length > 60))) {
    throw editorError('Zu viele Korrekturen der Freistellung.');
  }
}

function validateEditorMetadata(editor) {
  if (!editor || typeof editor !== 'object' || Array.isArray(editor) || editor.version !== 1) throw editorError('Diese Version der Bildbearbeitung wird nicht unterstützt.');
  validateAsset(editor.originalUrl, 'original');
  if (editor.maskUrl != null) validateAsset(editor.maskUrl, 'mask');
  if (editor.originalMimeType != null && !['image/png', 'image/jpeg', 'image/webp'].includes(editor.originalMimeType)) throw editorError('Ungültiges Originalbildformat.');
  if (typeof editor.updatedAt !== 'string' || editor.updatedAt.length > 40 || !Number.isFinite(Date.parse(editor.updatedAt))) throw editorError('Ungültiger Bearbeitungszeitpunkt.');
  validateRecipe(editor.recipe);
  // Remove inline pixels before measuring document metadata. These are uploaded,
  // never persisted; unknown editor fields are rejected, not silently dropped.
  const allowed = ['version', 'originalUrl', 'originalMimeType', 'maskUrl', 'recipe', 'updatedAt'];
  if (Object.keys(editor).some((key) => !allowed.includes(key))) throw editorError('Unbekannte Bildbearbeitungsmetadaten.');
  // Account for stored URL lengths too. Inline payloads become a bounded GCS
  // object URL; the bytes themselves never enter the Firestore document.
  const storedUrl = (value) => value?.startsWith('data:') ? 'x'.repeat(512) : value;
  return Buffer.byteLength(JSON.stringify({ ...editor, originalUrl: storedUrl(editor.originalUrl), maskUrl: storedUrl(editor.maskUrl) }));
}

function validatePhotoEditorImages(images) {
  let bytes = 0;
  for (const image of Array.isArray(images) ? images : []) {
    if (image?.photoEditor == null) continue;
    bytes += validateEditorMetadata(image.photoEditor);
    validateAsset(image.url_or_base64, 'render');
    if (bytes > MAX_EDITOR_METADATA_BYTES) throw editorError('Die Bildbearbeitungen dieses Produkts sind zu umfangreich.');
  }
}

async function preparePhotoEditorImage(image, productId, uploadAsset) {
  if (image?.photoEditor == null) return image;
  validatePhotoEditorImages([image]);
  const editor = { ...image.photoEditor };
  const prepared = { ...image, photoEditor: editor };
  const upload = async (value, role) => {
    if (!value.startsWith('data:')) return null;
    try {
      const result = await uploadAsset(value, productId, role);
      if (!isOwnedImageUrl(result?.url)) throw new Error('Missing durable image URL');
      return result;
    } catch (error) {
      if (error?.code === 'INVALID_PHOTO_EDITOR') throw error;
      throw editorError('Bildbearbeitung konnte nicht vollständig gesichert werden. Bitte erneut speichern; das Produkt wurde nicht verändert.', 'PHOTO_EDITOR_UPLOAD_FAILED', 503);
    }
  };
  const original = await upload(editor.originalUrl, 'original');
  if (original) { editor.originalUrl = original.url; editor.originalMimeType = original.mimeType; }
  if (editor.maskUrl) {
    const mask = await upload(editor.maskUrl, 'mask');
    if (mask) editor.maskUrl = mask.url;
  }
  const render = await upload(image.url_or_base64, 'render');
  if (render) {
    prepared.url_or_base64 = render.url;
    prepared.mimeType = render.mimeType;
    prepared.width = render.width;
    prepared.height = render.height;
  }
  return prepared;
}

function imageAssetUrls(image) {
  const raw = typeof image === 'string' ? image : image?.url_or_base64 || image?.url || image?.href;
  const main = typeof raw === 'string' ? raw : raw?.url;
  return [main, image?.photoEditor?.originalUrl, image?.photoEditor?.maskUrl].filter((value) => typeof value === 'string' && value.length > 0);
}

module.exports = { preparePhotoEditorImage, validatePhotoEditorImages, validateEditorMetadata, imageAssetUrls, MAX_ASSET_BYTES, editorError };
