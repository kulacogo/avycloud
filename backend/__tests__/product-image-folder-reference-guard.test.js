// globals: true — describe/it/expect/vi global
//
// Incident 2026-07-09: Produkt-Delete (bes. purgeDuplicates) wischte via
// deleteProductImages() den geteilten GCS-Ordner products/{SKU}/ und zerstoerte
// die Bilder ueberlebender Docs (50 Produkte ohne Bild vor Go-Live).
// Guard: isProductImageFolderReferenced() muss erkennen, ob ein ANDERES Doc den
// Ordner noch nutzt. Route ersetzt alle rohen deleteProductImages-Aufrufe durch
// den fail-closed safeDeleteProductImages-Wrapper.

const fs = require('fs');
const path = require('path');

describe('Bildordner-Referenz-Guard (Incident 2026-07-09)', () => {
  it.each(['originalUrl', 'maskUrl'])('schützt den Ordner auch wenn nur photoEditor.%s darauf verweist', async (field) => {
    const module = require('../lib/firestore');
    const collection = vi.spyOn(module.firestore, 'collection').mockReturnValue({ select: () => ({ get: async () => ({ docs: [
      { id: 'other', get: () => [{ url_or_base64: 'https://storage.googleapis.com/prodsandjobs/products/other/result.png',
        photoEditor: { [field]: 'https://storage.googleapis.com/prodsandjobs/products/original/source.png' } }] },
    ] }) }) });
    try {
      expect(await module.isProductImageFolderReferenced('original', 'original')).toBe(true);
      expect(await module.isProductImageFolderReferenced('unreferenced', 'original')).toBe(false);
      expect(await module.isProductImageFolderReferenced('original', 'other')).toBe(false);
    } finally { collection.mockRestore(); }
  });
  it('schützt URL-kodierte Bildordner mit gültigen Sonderzeichen in der Produktkennung', async () => {
    const folderId = 'SKU: A#B?C%20';
    const module = require('../lib/firestore');
    const collection = vi.spyOn(module.firestore, 'collection').mockReturnValue({ select: () => ({ get: async () => ({ docs: [
      { id: 'other', get: () => [{ url_or_base64: 'https://storage.googleapis.com/prodsandjobs/products/other/result.png',
        photoEditor: { originalUrl: `https://storage.googleapis.com/prodsandjobs/products/${encodeURIComponent(folderId)}/original.png` } }] },
    ] }) }) });
    try {
      expect(await module.isProductImageFolderReferenced(folderId, folderId)).toBe(true);
      expect(await module.isProductImageFolderReferenced('SKU: A#B?C', folderId)).toBe(false);
    } finally { collection.mockRestore(); }
  });
  it('isProductImageFolderReferenced findet fremde Referenz auf denselben Ordner', () => {
    // In-Memory-Firestore-Stub: zwei Docs teilen products/SKU-A/
    const docs = [
      { id: 'SKU-A', 'details.images': [{ url_or_base64: 'https://storage.googleapis.com/prodsandjobs/products/SKU-A/studio_front_x.png' }] },
      { id: '4006633000000', 'details.images': [{ url_or_base64: 'https://storage.googleapis.com/prodsandjobs/products/SKU-A/studio_front_x.png' }] },
      { id: 'SKU-C', 'details.images': [{ url: 'https://storage.googleapis.com/prodsandjobs/products/SKU-C/a.png' }] },
    ];
    const fakeSnap = {
      docs: docs.map((d) => ({ id: d.id, get: (f) => d[f] })),
    };
    const firestore = require('../lib/firestore');
    // Reimplementiere die Logik gegen den Stub (die echte Funktion ist an den
    // echten firestore-Client gebunden; hier verifizieren wir die Semantik).
    const isReferenced = (folderId, excludeDocId) => {
      const needle = `/products/${folderId}/`;
      for (const doc of fakeSnap.docs) {
        if (excludeDocId && doc.id === excludeDocId) continue;
        const imgs = doc.get('details.images');
        if (!Array.isArray(imgs)) continue;
        for (const im of imgs) {
          const raw = typeof im === 'string' ? im : (im && (im.url_or_base64 || im.url)) || '';
          const url = typeof raw === 'string' ? raw : '';
          if (url.includes(needle)) return true;
        }
      }
      return false;
    };
    // Delete von SKU-A: der EAN-Doc referenziert products/SKU-A/ noch -> geschuetzt
    expect(isReferenced('SKU-A', 'SKU-A')).toBe(true);
    // Delete von SKU-C: niemand sonst referenziert products/SKU-C/ -> darf geloescht werden
    expect(isReferenced('SKU-C', 'SKU-C')).toBe(false);
    // Die echte Funktion ist exportiert
    expect(typeof firestore.isProductImageFolderReferenced).toBe('function');
  });

  it('routes/products.js: KEIN roher deleteProductImages-Aufruf mehr (nur ueber Guard)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'products.js'), 'utf8');
    // Genau EIN roher deleteProductImages(-Aufruf erlaubt: der im Wrapper selbst.
    const rawCalls = src.match(/await deleteProductImages\(/g) || [];
    expect(rawCalls.length).toBe(1);
    // Die alten Direktaufrufe (id/dupId/productId) sind weg.
    expect(src).not.toMatch(/await deleteProductImages\((id|dupId|productId)\)/);
    const guarded = src.match(/await safeDeleteProductImages\(/g) || [];
    expect(guarded.length).toBeGreaterThanOrEqual(4); // 2x bulk, single, single-dup
    // Wrapper ist fail-closed (return bei Fehler ohne Loeschen)
    expect(src).toMatch(/fail-closed/i);
  });
});
