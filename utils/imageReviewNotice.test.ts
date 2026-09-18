import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageReviewNotice } from './imageReviewNotice.ts';

test('zeigt unsichere oder fehlende Studio-Prüfung dauerhaft am betroffenen Bild', () => {
  assert.match(imageReviewNotice('Studio-Foto (Gemini) — Produkttreue nicht geprüft; bitte Original vergleichen.')!, /nicht geprüft/);
  assert.match(imageReviewNotice('Studio-Foto (Gemini) — Bitte prüfen: Material verändert')!, /Material verändert/);
});
test('benennt einen originalerhaltenden Rückfall ehrlich', () => {
  assert.match(imageReviewNotice('Studio-Rückfall: Originalfoto auf weißer Leinwand; keine generative Retusche übernommen.')!, /Originalfoto/);
});
test('macht aus sonstigen Bildnotizen keine Warnung', () => {
  assert.equal(imageReviewNotice('Studio-Foto (Originaldetails erhalten)'), null);
  assert.equal(imageReviewNotice(undefined), null);
});
