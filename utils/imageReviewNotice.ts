/** Studio persists review notes with the image, so warnings survive saving/reopening. */
export function imageReviewNotice(notes?: string | null): string | null {
  if (!notes) return null;
  if (notes.startsWith('Studio-Rückfall:')) return notes;
  for (const marker of [' — Produkttreue nicht geprüft', ' — Bitte prüfen:']) {
    const at = notes.indexOf(marker);
    if (at >= 0) return notes.slice(at + 3);
  }
  return null;
}
