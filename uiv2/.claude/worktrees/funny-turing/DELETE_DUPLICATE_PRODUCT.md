DELETE DUPLICATE PRODUCT (SKU)
==============================

Zweck: Schnell ein einzelnes Produkt (inkl. Bilder und Bin-Zuordnung) per SKU aus Firestore entfernen. Skript läuft lokal im Repo und nutzt die bestehenden Helfer.

Schnellbefehl (SKU einsetzen)
----------------------------

```bash
cd /Users/oguz/Dev/avycloud && node - <<'NODE'
const { getProduct, deleteProduct } = require('./backend/lib/firestore');
const { deleteProductImages } = require('./backend/lib/storage');
const { removeProductFromBin } = require('./backend/lib/warehouse');

const SKU = 'SKU-REPLACE-ME';

(async () => {
  try {
    const product = await getProduct(SKU);
    if (!product) {
      console.log('not found', SKU);
      return;
    }
    if (product.storage?.binCode) {
      try {
        await removeProductFromBin(product.storage.binCode, product.id);
        console.log('bin cleared', SKU);
      } catch (err) {
        console.warn('bin clear failed', SKU, err?.message || err);
      }
    }
    await deleteProductImages(SKU).catch(() => {});
    await deleteProduct(SKU, { existingData: product });
    console.log('deleted', SKU);
  } catch (err) {
    console.error('error', SKU, err?.message || err);
  }
})();
NODE
```

Hinweise
--------
- SKU exakt setzen (z. B. `SKU-2116824185`).
- Läuft gegen die lokal konfigurierten GCP/Firestore-Creds (gleiche Umgebung wie die Anwendung).
- Falls stattdessen die HTTP-Route genutzt werden soll: `DELETE /api/products/cleanup-by-alias/:alias` mit Header `x-admin-delete-token` (siehe `backend/index.js`), Alias kann `sku 2116824185` oder `2116824185` sein.
