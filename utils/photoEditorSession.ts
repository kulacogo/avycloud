import type { ProductImage } from "../types.ts";

export type PhotoChange = { index: number; expected: ProductImage; image: ProductImage };
export type PhotoHistory<T> = { entries: Array<{ value: T; label: string }>; position: number };

/** Hosting and Cloud Run deploy independently. Never send nested image assets to an older save handler. */
export async function assertPhotoEditorBackend(images: ProductImage[], request: () => Promise<{ ok: boolean; version?: number }>): Promise<void> {
  if (!images.some(image => image?.photoEditor)) return;
  let ready = false;
  try { const capability = await request(); ready = capability.ok && capability.version === 1; } catch { /* Fail before the product POST. */ }
  if (!ready) throw new Error("Die Bildwerkstatt kann gerade noch nicht sicher speichern. Bitte kurz warten und erneut speichern. Ihre Änderungen bleiben im Datenblatt erhalten.");
}

export function createPhotoHistory<T>(value: T): PhotoHistory<T> {
  return { entries: [{ value, label: "Ausgangsstand" }], position: 0 };
}

export function pushPhotoHistory<T>(history: PhotoHistory<T>, value: T, label: string): PhotoHistory<T> {
  if (JSON.stringify(history.entries[history.position].value) === JSON.stringify(value)) return history;
  const entries = [...history.entries.slice(0, history.position + 1), { value, label }].slice(-60);
  return { entries, position: entries.length - 1 };
}

/** Apply a whole image batch or nothing; stale indexes never overwrite a different photo. */
export function applyPhotoChanges(images: ProductImage[], changes: PhotoChange[]): ProductImage[] | null {
  const indexes = new Set<number>();
  for (const change of changes) {
    if (!Number.isInteger(change.index) || indexes.has(change.index) ||
      JSON.stringify(images[change.index]) !== JSON.stringify(change.expected)) return null;
    indexes.add(change.index);
  }
  const next = [...images];
  for (const change of changes) next[change.index] = change.image;
  return next;
}
