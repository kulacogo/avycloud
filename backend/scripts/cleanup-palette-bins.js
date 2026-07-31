/* eslint-disable no-console */
/**
 * Entfernt die Alt-Paletten-Struktur (Zone 'P', Bin-Codes P{ETAGE}{NNN} wie
 * PEG001) nach dem Umstieg auf die Los-Struktur (L-/NL-Lose, 2026-07-31).
 *
 * Safety (fail-closed):
 *   - Dry-run by default: listet alle Paletten-Bins inkl. productCount,
 *     products[] und Behälter (Child-Bins), löscht NICHTS.
 *   - --apply löscht NUR, wenn ALLE Paletten-Bins (inkl. Behälter) leer sind —
 *     ein einziger nicht-leerer Bin bricht den gesamten Lauf ab (all-or-nothing,
 *     kein halber Zustand). Danach werden auch die Zonen-Docs P_GA/P_UG/P_EG
 *     aus warehouseZones entfernt.
 *
 * Usage:
 *   node backend/scripts/cleanup-palette-bins.js
 *   node backend/scripts/cleanup-palette-bins.js --apply
 */

const { Firestore } = require('@google-cloud/firestore');

const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
});

const APPLY = process.argv.slice(2).includes('--apply');
const ETAGEN = ['GA', 'UG', 'EG'];

async function main() {
  console.log(`\n=== Paletten-Bins Cleanup (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

  const binsCol = firestore.collection('warehouseBins');
  const zonesCol = firestore.collection('warehouseZones');

  // Alle Paletten-Bins (createPaletteBins hat immer zone:'P' gesetzt)
  const paletteSnap = await binsCol.where('zone', '==', 'P').get();
  const paletteBins = paletteSnap.docs.map((d) => ({ id: d.id, ref: d.ref, data: d.data() || {} }));

  // Behälter (Child-Bins) unterhalb von Paletten-Bins einsammeln
  const children = [];
  for (const bin of paletteBins) {
    const childSnap = await binsCol.where('parentBinCode', '==', bin.id).get();
    childSnap.docs.forEach((d) => children.push({ id: d.id, ref: d.ref, data: d.data() || {}, parent: bin.id }));
  }

  console.log(`Gefundene Paletten-Bins: ${paletteBins.length}`);
  console.log(`Gefundene Behälter darunter: ${children.length}\n`);

  let blocked = 0;
  for (const bin of [...paletteBins, ...children]) {
    const productEntries = Array.isArray(bin.data.products) ? bin.data.products.length : 0;
    const stock = (bin.data.productCount || 0) > 0
      || (Array.isArray(bin.data.products) && bin.data.products.some((p) => (p?.quantity || 0) > 0));
    const nonEmpty = stock || productEntries > 0;
    if (nonEmpty) blocked += 1;
    console.log(
      `  ${bin.id.padEnd(12)} etage=${bin.data.etage || '-'} productCount=${bin.data.productCount || 0} ` +
      `productEntries=${productEntries}${bin.parent ? ` parent=${bin.parent}` : ''}${nonEmpty ? '  << NICHT LEER' : ''}`
    );
  }

  const zoneDocs = [];
  for (const etage of ETAGEN) {
    const snap = await zonesCol.doc(`P_${etage}`).get();
    if (snap.exists) zoneDocs.push({ id: snap.id, ref: snap.ref });
  }
  console.log(`\nZonen-Docs (warehouseZones): ${zoneDocs.map((z) => z.id).join(', ') || 'keine'}`);

  if (!APPLY) {
    console.log(`\nDRY-RUN beendet. ${blocked ? `ACHTUNG: ${blocked} Bin(s) nicht leer — --apply würde abbrechen.` : 'Alle Bins leer — --apply würde löschen.'}`);
    return;
  }

  if (blocked > 0) {
    console.error(`\nABBRUCH: ${blocked} Paletten-Bin(s) sind nicht leer. Erst Bestand umbuchen, dann erneut ausführen. NICHTS wurde gelöscht.`);
    process.exitCode = 1;
    return;
  }

  const toDelete = [...children.map((c) => c.ref), ...paletteBins.map((b) => b.ref), ...zoneDocs.map((z) => z.ref)];
  const chunkSize = 400;
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += chunkSize) {
    const batch = firestore.batch();
    toDelete.slice(i, i + chunkSize).forEach((ref) => batch.delete(ref));
    await batch.commit();
    deleted += Math.min(chunkSize, toDelete.length - i);
  }
  console.log(`\nGELÖSCHT: ${paletteBins.length} Paletten-Bins, ${children.length} Behälter, ${zoneDocs.length} Zonen-Doc(s) (${deleted} Dokumente gesamt).`);
}

main().catch((err) => {
  console.error('Cleanup fehlgeschlagen:', err);
  process.exitCode = 1;
});
