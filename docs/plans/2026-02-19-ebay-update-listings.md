# eBay Listing Update — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bereits gelistete eBay-Artikel aus dem AdminTable heraus gap-basiert aktualisieren (selektiert oder alle auf einmal).

**Architecture:** Neuer Backend-Endpoint `POST /api/ebay/update/bulk` der intern `auditListingGaps` (Gap-Berechnung) + `applySync` (ReviseFixedPriceItem) aufruft. Frontend bekommt zwei neue Aktionen: selektions-abhängiger Button + selektion-unabhängige Bulk-Aktion im Dropdown. Der AdminTable erweitert den SKU-Index-State um `SKU → itemId` für die direkte Auflösung.

**Tech Stack:** Node.js/Express (Backend), React/TypeScript (Frontend), Firestore, eBay Trading API

---

### Task 1: Backend — `bulkUpdateListedProducts` Funktion

**Files:**
- Modify: `backend/lib/ebay-direct.js` (exports am Ende, ca. Zeile 3404–3427)

**Step 1: Funktion vor den exports einfügen**

Suche nach `async function applySync` (Zeile ~2708). Füge diese neue Funktion direkt VOR der `module.exports`-Zeile ein (Ende der Datei, nach `applySync`):

```javascript
async function bulkUpdateListedProducts({ itemIds = null, applyAll = false, actor = null } = {}) {
  let resolvedItemIds;

  if (applyAll) {
    const snap = await firestore
      .collection(EBAY_LISTINGS_COLLECTION)
      .where('active', '==', true)
      .get();
    resolvedItemIds = snap.docs.map((doc) => doc.id);
  } else if (Array.isArray(itemIds) && itemIds.length > 0) {
    resolvedItemIds = itemIds.map((x) => String(x || '').trim()).filter(Boolean);
  } else {
    return { summary: { total: 0, success: 0, failed: 0, skipped: 0 }, results: [], dryRun: null };
  }

  if (!resolvedItemIds.length) {
    return { summary: { total: 0, success: 0, failed: 0, skipped: 0 }, results: [], dryRun: null };
  }

  // Gaps neu berechnen damit applySync aktuelle Diffs vorfindet
  const runId = `update-${Date.now()}`;
  await auditListingGaps({ itemIds: resolvedItemIds, runId, actor });

  return applySync({ itemIds: resolvedItemIds, actor });
}
```

**Step 2: Zur exports-Liste hinzufügen**

In `module.exports = { ... }` (Zeile ~3404) `bulkUpdateListedProducts` anhängen:

```javascript
  bulkPublishProducts,
  bulkUpdateListedProducts,   // <-- neu
};
```

**Step 3: Manuell testen (curl / Postman)**

Noch kein automatischer Test nötig — validieren wir nach dem Endpoint (Task 2).

---

### Task 2: Backend — neuer Endpoint

**Files:**
- Modify: `backend/index.js`

**Step 1: Endpoint nach `/api/ebay/sync/apply` einfügen (Zeile ~2660)**

Füge direkt nach dem `app.post('/api/ebay/sync/apply', ...)` Block ein:

```javascript
app.post('/api/ebay/update/bulk', requirePermission('products', 'write'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const itemIds = Array.isArray(body.itemIds)
      ? body.itemIds.map((x) => String(x || '').trim()).filter(Boolean)
      : null;
    const applyAll = body.applyAll === true;
    if (!applyAll && (!itemIds || !itemIds.length)) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'itemIds oder applyAll erforderlich.' },
      });
    }
    const { bulkUpdateListedProducts } = require('./lib/ebay-direct');
    const out = await bulkUpdateListedProducts({
      itemIds,
      applyAll,
      actor: req.user?.email || req.user?.uid || 'api',
    });
    return res.status(200).json({ ok: true, data: out });
  } catch (error) {
    console.error('Failed to bulk update eBay listings:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to bulk update eBay listings' },
    });
  }
});
```

**Step 2: Commit**

```bash
git add backend/lib/ebay-direct.js backend/index.js
git commit -m "feat: add bulkUpdateListedProducts and POST /api/ebay/update/bulk endpoint"
```

---

### Task 3: API Client

**Files:**
- Modify: `api/client.ts` (nach `fetchEbaySkuIndex`, Zeile ~685)

**Step 1: Funktion einfügen**

```typescript
export async function bulkUpdateEbayListings(params: {
  itemIds?: string[];
  applyAll?: boolean;
}): Promise<{
  summary: { total: number; success: number; failed: number; skipped: number };
  results: any[];
  dryRun: any;
}> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/update/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to bulk update eBay listings');
  }
  return data?.data;
}
```

**Step 2: Commit**

```bash
git add api/client.ts
git commit -m "feat: add bulkUpdateEbayListings API client function"
```

---

### Task 4: AdminTable — State erweitern

**Files:**
- Modify: `components/AdminTable.tsx`

**Step 1: Import ergänzen**

Zeile 4 — `bulkUpdateEbayListings` zur Import-Liste hinzufügen:

```typescript
import { fetchProducts, ..., bulkPublishToEbay, fetchEbaySkuIndex, bulkUpdateEbayListings, type ProductBulkActionName } from '../api/client';
```

**Step 2: Neuen State hinzufügen**

Nach `const [ebayLinkedMap, setEbayLinkedMap] = useState<Map<string, string>>(new Map());` (Zeile ~258):

```typescript
const [ebayItemIdMap, setEbayItemIdMap] = useState<Map<string, string>>(new Map()); // SKU → itemId
const [ebayUpdateInProgress, setEbayUpdateInProgress] = useState(false);
```

**Step 3: useEffect der den SKU-Index lädt erweitern**

Den bestehenden `useEffect` der `fetchEbaySkuIndex` aufruft (Zeile ~293) so ändern dass er BEIDE Maps befüllt:

```typescript
useEffect(() => {
  fetchEbaySkuIndex()
    .then((entries) => {
      const urlMap = new Map<string, string>();
      const itemIdMap = new Map<string, string>();
      entries.forEach((entry) => {
        if (!entry.sku) return;
        const key = String(entry.sku).trim().toUpperCase();
        const url = entry.viewItemUrl || `https://www.ebay.de/itm/${encodeURIComponent(entry.itemId)}`;
        urlMap.set(key, url);
        itemIdMap.set(key, entry.itemId);
      });
      setEbayLinkedMap(urlMap);
      setEbayItemIdMap(itemIdMap);
    })
    .catch(() => {});
}, []);
```

**Step 4: After-Publish-Reload ebenfalls beide Maps befüllen**

Den Block nach dem Publish (Zeile ~1293, der `fetchEbaySkuIndex().then(...)` aufruft) identisch wie oben aktualisieren:

```typescript
fetchEbaySkuIndex().then((entries) => {
  const urlMap = new Map<string, string>();
  const itemIdMap = new Map<string, string>();
  entries.forEach((entry) => {
    if (!entry.sku) return;
    const key = String(entry.sku).trim().toUpperCase();
    const url = entry.viewItemUrl || `https://www.ebay.de/itm/${encodeURIComponent(entry.itemId)}`;
    urlMap.set(key, url);
    itemIdMap.set(key, entry.itemId);
  });
  setEbayLinkedMap(urlMap);
  setEbayItemIdMap(itemIdMap);
}).catch(() => {});
```

---

### Task 5: AdminTable — Handler implementieren

**Files:**
- Modify: `components/AdminTable.tsx`

**Step 1: `handleBatchUpdateEbay` direkt nach `handleBatchPublishEbay` einfügen**

```typescript
const handleBatchUpdateEbay = async () => {
  const ids = Array.from(selectedIds);
  // Selektierte Produkte → itemIds über SKU-Lookup
  const listedItemIds = ids
    .map((pid) => {
      const product = products.find((p) => p.id === pid);
      if (!product) return null;
      const sku = String(
        (product as any)?.identification?.sku || product.details?.identifiers?.sku || ''
      ).trim().toUpperCase();
      return sku ? ebayItemIdMap.get(sku) : null;
    })
    .filter((id): id is string => Boolean(id));

  if (!listedItemIds.length) {
    setNotice({
      tone: 'error',
      title: 'eBay Update',
      message: 'Keine der ausgewählten Produkte ist auf eBay gelistet.',
    });
    return;
  }

  if (!window.confirm(
    `${listedItemIds.length} eBay-Listing${listedItemIds.length !== 1 ? 's' : ''} aktualisieren?\nNur geänderte Felder werden übertragen.\n\nFortfahren?`
  )) return;

  setEbayUpdateInProgress(true);
  setNotice({ tone: 'info', title: 'eBay Update', message: `Aktualisiere ${listedItemIds.length} Listing${listedItemIds.length !== 1 ? 's' : ''}...` });

  try {
    const result = await bulkUpdateEbayListings({ itemIds: listedItemIds });
    const { success, failed, skipped } = result.summary;
    setNotice({
      tone: failed === 0 ? 'success' : 'warning',
      title: 'eBay Update abgeschlossen',
      message: `Aktualisiert: ${success}${failed > 0 ? `, Fehlgeschlagen: ${failed}` : ''}${skipped > 0 ? `, Übersprungen: ${skipped}` : ''}`,
    });
  } catch (err: any) {
    setNotice({ tone: 'error', title: 'eBay Update fehlgeschlagen', details: err?.message || String(err) });
  } finally {
    setEbayUpdateInProgress(false);
  }
};

const handleUpdateAllEbay = async () => {
  const total = ebayLinkedMap.size;
  if (!window.confirm(
    `Alle ${total} aktiven eBay-Listings aktualisieren?\nNur geänderte Felder werden übertragen.\nDies kann mehrere Minuten dauern.\n\nFortfahren?`
  )) return;

  setEbayUpdateInProgress(true);
  setNotice({ tone: 'info', title: 'eBay Update', message: `Aktualisiere alle ${total} aktiven Listings...` });

  try {
    const result = await bulkUpdateEbayListings({ applyAll: true });
    const { success, failed, skipped } = result.summary;
    setNotice({
      tone: failed === 0 ? 'success' : 'warning',
      title: 'eBay Update abgeschlossen',
      message: `Aktualisiert: ${success}${failed > 0 ? `, Fehlgeschlagen: ${failed}` : ''}${skipped > 0 ? `, Übersprungen: ${skipped}` : ''}`,
    });
  } catch (err: any) {
    setNotice({ tone: 'error', title: 'eBay Update fehlgeschlagen', details: err?.message || String(err) });
  } finally {
    setEbayUpdateInProgress(false);
  }
};
```

---

### Task 6: AdminTable — UI Buttons

**Files:**
- Modify: `components/AdminTable.tsx`

**Step 1: Computed variable für "hat selektierte gelistete Produkte"**

Direkt nach dem `ebayUpdateInProgress` State (oder in der Nähe der anderen berechneten Werte) hinzufügen:

```typescript
const hasSelectedEbayListings = useMemo(() => {
  return Array.from(selectedIds).some((pid) => {
    const product = products.find((p) => p.id === pid);
    if (!product) return false;
    const sku = String(
      (product as any)?.identification?.sku || product.details?.identifiers?.sku || ''
    ).trim().toUpperCase();
    return Boolean(sku && ebayItemIdMap.has(sku));
  });
}, [selectedIds, products, ebayItemIdMap]);
```

Sicherstellen dass `ebayItemIdMap` in der `useMemo`-Dependency-Liste aller bestehenden Memos mit eBay-Logik ergänzt wird falls nötig.

**Step 2: "eBay aktualisieren" ActionButton einfügen**

Direkt NACH dem bestehenden "Auf eBay listen" `<ActionButton>` Block (Zeile ~2295):

```tsx
{hasSelectedEbayListings && (
  <ActionButton
    icon={
      <svg className="w-4 h-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M4 4v5h5M16 16v-5h-5" />
        <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m18 0 4.36 4.36A9 9 0 0 1 3.51 15" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    }
    label={ebayUpdateInProgress ? 'Wird aktualisiert...' : 'eBay aktualisieren'}
    onClick={handleBatchUpdateEbay}
    disabled={ebayUpdateInProgress || ebayPublishInProgress}
    tone="primary"
  />
)}
```

**Step 3: "Alle eBay-Listings aktualisieren" ins Dropdown-Menü einfügen**

Im `<details>` Dropdown (Zeile ~2315ff.), direkt nach dem bestehenden `handleBatchPublishEbay`-Button im Menü:

```tsx
<button
  type="button"
  onClick={handleUpdateAllEbay}
  disabled={ebayUpdateInProgress || ebayLinkedMap.size === 0}
  className={menuItemClass}
>
  {ebayUpdateInProgress ? 'eBay Update läuft...' : `Alle eBay-Listings aktualisieren (${ebayLinkedMap.size})`}
</button>
```

**Step 4: Commit**

```bash
git add components/AdminTable.tsx api/client.ts
git commit -m "feat: add eBay listing update UI — selected products and all-listings actions"
```

---

### Task 7: TypeScript prüfen

```bash
npx tsc --noEmit 2>&1 | grep AdminTable
```

Erwartet: keine Ausgabe (= keine Fehler in AdminTable.tsx).

Falls Fehler: beheben und committen.

---

### Task 8: End-to-End Smoke Test

1. App starten
2. Im AdminTable ein Produkt auswählen das auf eBay gelistet ist (eBay-Badge zeigt "gelistet")
3. Button "eBay aktualisieren" erscheint → klicken → Confirm-Dialog erscheint mit korrekter Anzahl
4. Nach Bestätigung: Notice zeigt "Aktualisiert: X"
5. Im Dropdown-Menü: "Alle eBay-Listings aktualisieren (N)" ist sichtbar und klickbar

```bash
git add -A
git commit -m "feat: eBay listing update feature complete"
```
