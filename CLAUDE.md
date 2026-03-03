# CLAUDE.md — AvyCloud Development Guide

> Dieses Dokument ist die zentrale Anweisung für Claude Code.
> Jede Änderung MUSS die goldene Regel einhalten:
>
> **🛡️ GOLDENE REGEL: Die App in Production darf NIEMALS negativ beeinflusst werden.**
> Kein Breaking Change. Kein Datenverlust. Kein Downtime. Zero Regression.

---

## Projekt-Übersicht

AvyCloud ist ein Product Intelligence Hub für E-Commerce: KI-gestützte Produkterkennung, Multi-Marktplatz-Sync (eBay, Kaufland, BaseLinker), Lagerverwaltung und Auftragsabwicklung.

### Architektur

```
Frontend:  React 18 + TypeScript + Vite + Tailwind → Firebase Hosting
Backend:   Node.js 20 + Express 4.19 (CommonJS) → Google Cloud Run (europe-west3)
Datenbank: Google Cloud Firestore (NoSQL)
Storage:   Google Cloud Storage (gs://prodsandjobs)
KI:        Google Gemini API (@google/generative-ai)
Auth:      Firebase Authentication
```

### Verzeichnisstruktur

```
/                        → Frontend (React/TypeScript/Vite)
├── components/          → React-Komponenten (~50 Dateien)
├── hooks/               → Custom React Hooks
├── context/             → AuthContext, InventoryContext
├── utils/               → Frontend-Utilities
├── api/client.ts        → API-Client (fetch wrapper)
├── types.ts             → TypeScript-Definitionen (843 Zeilen)
├── i18n.tsx             → Internationalisierung (DE/EN/TR)
├── App.tsx              → Haupt-Routing & State
│
├── backend/             → Backend (Node.js/Express)
│   ├── index.js         → Express-Server Entry (~280 Zeilen, Middleware + Router-Mounts)
│   ├── routes/          → 7 Router-Module (products, orders, warehouse, identify, marketplace, admin, auth)
│   ├── lib/             → 81+ Utility-Module (firestore, rbac, auth, product-store, product-canonical, …)
│   ├── services/        → 29+ Service-Module (pricing-engine, inventory-forecast, deduplication, webhooks, …)
│   ├── scripts/         → Utility/Migrations-Scripts
│   ├── __tests__/       → Vitest-Tests (119 Tests, 7 Suiten)
│   ├── package.json     → Backend-Dependencies
│   └── cloudbuild.yaml  → Cloud Build Deployment
│
├── Dockerfile           → Cloud Run Container-Definition
├── firebase.json        → Firebase Hosting Config
└── .github/workflows/   → GitHub Actions (Frontend CI/CD)
```

### Deployment

- **Frontend:** Push to `main` → GitHub Actions → `npm run build` → Firebase Hosting
- **Backend:** Push to `main` → Cloud Build → Docker Build → Cloud Run Deploy
- **Beides läuft automatisch bei Push auf main.**

### Aktiver Task-Stand

**Aktive Tasks stehen in [`TASKS.md`](./TASKS.md)** — dort immer zuerst nachsehen.

Erledigte Phase 1–3 Foundations (Stand 2026-03):
- ✅ P0: Security Headers, Rate-Limiting, Firestore-Normalisierung (products_v2 live), LLM-Policy aktiv
- ✅ P1: Structured Logging (Pino), Health-Check, Graceful Shutdown, Vitest-Infrastruktur (119 Tests), Error Responses
- ✅ P1: Express Router Splitting (7 Router-Module), API Versioning
- ✅ P2: SSE Job-Status, Pricing Engine, Inventory Forecasting, Webhook-System, Produkt-Deduplizierung
- ✅ P3: Competitor Intelligence (priceHistory Collection)
- ✅ Alle Schreibpfade auf `saveProductV2()` umgestellt (product-store.js Abstraktionsschicht)

Aktive Phase 2 Services (alle in `backend/services/` und `backend/lib/`):
- `pricing-engine.js` — Preisvorschläge, pricingRules Collection, Repricing
- `inventory-forecast.js` — salesVelocity, predictedStockOut, Reorder-Alerts
- `deduplication.js` — EAN/MPN/Brand+Model Duplikat-Erkennung, Merge-Logik
- `webhooks.js` — HMAC-SHA256 Signierung, dispatchWebhook(), createWebhook/listWebhooks/deleteWebhook
- `product-store.js` — Dual-Write Abstraktionsschicht (products → products_v2)
- `product-canonical.js` — Normalisierung und Validierung für products_v2

### Bekannte offene Issues

- **Token-in-Query-Parameter (SSE):** JWT wird als `?token=` URL-Parameter übergeben für SSE-Streams (`/api/jobs/:id/stream`, `/api/chat`). Das leakt in Server-Logs und Browser-History. Korrekte Lösung: Cookie-basierte Auth oder eigener SSE-Auth-Header. Dokumentiert in TASKS.md (Someday-Liste).

---

## Regeln für alle Änderungen

### 🛡️ Production Safety (NICHT VERHANDELBAR)

1. **Keine bestehende Route ändern** ohne explizite Anweisung. Alle Routen in `backend/routes/` sind live (products, orders, warehouse, identify, marketplace, admin, auth).
2. **Keine Firestore-Collection-Struktur ändern.** Bestehende Dokument-Felder dürfen nicht umbenannt oder entfernt werden. Neue Felder sind erlaubt (additive changes only).
3. **Keine Dependencies entfernen** aus `backend/package.json` oder root `package.json`.
4. **Keine Environment-Variable umbenennen** die in `backend/cloudbuild.yaml` oder `.github/workflows/` referenziert wird.
5. **Kein `require()`-Pfad in `backend/index.js` oder `backend/routes/*.js` ändern** — alle Router-Imports sind in Produktion aktiv.
6. **Keine Änderung an `Dockerfile`, `firebase.json`, `.firebaserc`, `cloudbuild.yaml`** ohne explizite Anweisung.
7. **Keine Änderung an Auth-Middleware** (`backend/lib/auth.js`, `backend/lib/rbac.js`) ohne explizite Anweisung.

### Code-Stil

- **Backend:** CommonJS (`require`/`module.exports`), JavaScript (kein TypeScript — Migration ist separates Ticket)
- **Frontend:** TypeScript, ES Modules (`import`/`export`), React Functional Components + Hooks
- **Einrückung:** 2 Spaces
- **Strings:** Single Quotes im Backend, Double Quotes im Frontend (bestehende Konvention beibehalten)
- **Async:** `async/await` bevorzugen, keine Callbacks
- **Error Handling:** Jeder neue Endpoint braucht try/catch mit strukturierter Fehlerantwort:
  ```js
  try {
    // logic
  } catch (err) {
    console.error(`[POST /api/example] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
  ```

### Testing (NEU — wird aufgebaut)

- Test-Framework: **Vitest** (wird in Phase 1 eingeführt)
- Testdateien: `*.test.js` neben der Quelldatei oder in `__tests__/`
- Bei jeder neuen Funktion/Service: Mindestens 1 Unit-Test mitliefern
- Bestehende Tests nicht löschen: `backend/lib/ebay-trading-api.test.js`, `backend/services/pick-hints.test.js`

### Git-Workflow

- Arbeite auf Feature-Branches: `feat/`, `fix/`, `refactor/`, `chore/`
- Commit-Messages: Conventional Commits (`feat:`, `fix:`, `refactor:`, `chore:`, `test:`)
- Kein Force-Push auf `main`

---

## Priorisierte Task-Liste

> Prioritäten: P0 = Sofort (Sicherheit/Stabilität), P1 = Hoch (Qualität), P2 = Mittel (DX/Features), P3 = Nice-to-have

---

### PHASE 1: Foundation Fix ✅ ABGESCHLOSSEN (2026-02/03)

> Alle Phase 1 Tasks sind erledigt. Die detaillierten Anweisungen unten dienen als Referenz für die Implementierungsentscheidungen.

#### P0-001 — Security Headers mit Helmet.js ✅ DONE

**Problem:** Keine Content-Security-Policy, kein HSTS, kein X-Frame-Options.
**Impact:** Produktions-Sicherheitslücke.

**Anweisung:**
1. `cd backend && npm install helmet`
2. In `backend/index.js` direkt nach den bestehenden `app.use(cors(...))` Zeilen einfügen:
   ```js
   const helmet = require('helmet');
   app.use(helmet({
     contentSecurityPolicy: false, // Frontend wird separat gehostet
     crossOriginEmbedderPolicy: false,
   }));
   ```
3. **NICHT** die bestehende CORS-Konfiguration ändern.
4. Smoke-Test: Alle bestehenden API-Calls müssen weiter funktionieren.

**Validierung:** `curl -I https://<backend-url>/api/health` → Response muss `X-Content-Type-Options: nosniff` und `Strict-Transport-Security` Header enthalten.

---

#### P0-002 — Rate-Limiting auf kostenintensive Endpoints ✅ DONE

**Problem:** Kein Rate-Limit. Jeder `/api/identify`-Call kostet Gemini-API-Credits. Missbrauchspotenzial.
**Impact:** Unkontrollierte API-Kosten.

**Anweisung:**
1. `cd backend && npm install express-rate-limit`
2. Neue Datei erstellen: `backend/lib/rate-limit.js`:
   ```js
   const rateLimit = require('express-rate-limit');

   const identifyLimiter = rateLimit({
     windowMs: 15 * 60 * 1000, // 15 Minuten
     max: 30, // Max 30 Requests pro User
     keyGenerator: (req) => req.user?.uid || req.ip,
     message: { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again in 15 minutes.' } },
     standardHeaders: true,
     legacyHeaders: false,
   });

   const generalLimiter = rateLimit({
     windowMs: 1 * 60 * 1000,
     max: 120,
     keyGenerator: (req) => req.user?.uid || req.ip,
     message: { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests.' } },
     standardHeaders: true,
     legacyHeaders: false,
   });

   module.exports = { identifyLimiter, generalLimiter };
   ```
3. In `backend/index.js`:
   - Import hinzufügen (am Anfang, bei den anderen requires):
     ```js
     const { identifyLimiter, generalLimiter } = require('./lib/rate-limit');
     ```
   - `generalLimiter` als globale Middleware nach CORS/Helmet:
     ```js
     app.use(generalLimiter);
     ```
   - `identifyLimiter` auf die KI-Endpoints anwenden (die Routen-Definition NICHT ändern, nur Middleware einfügen):
     - `app.post('/api/identify', requireAuth, identifyLimiter, ...)`
     - `app.post('/api/v2/identify', requireAuth, identifyLimiter, ...)`
     - `app.post('/api/v2/enrich', requireAuth, identifyLimiter, ...)`
     - `app.post('/api/chat', requireAuth, identifyLimiter, ...)`
4. **WICHTIG:** Die Routen-Handler (die Callback-Funktionen) NICHT ändern. Nur die Middleware-Kette erweitern.

**Validierung:** 31 schnelle Requests auf `/api/identify` → Request 31 bekommt 429 Status.

---

#### P0-003 — .env.local aus Git-Historie entfernen ✅ DONE

**Problem:** `.env.local` ist in `.gitignore` (gut), aber war möglicherweise historisch committed. Enthält Firebase API Keys.
**Impact:** Credential Exposure falls Repo jemals public war/wird.

**Anweisung:**
1. Prüfe ob `.env.local` im Git-Index ist: `git ls-files .env.local`
2. Falls ja: `git rm --cached .env.local` (Datei lokal behalten, aus Git entfernen)
3. Erstelle `/.env.example` mit Platzhaltern:
   ```
   VITE_FIREBASE_API_KEY=your-api-key-here
   VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=your-project-id
   VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
   VITE_FIREBASE_MESSAGING_SENDER_ID=000000000000
   VITE_FIREBASE_APP_ID=your-app-id
   ```
4. **NICHT** `.env.local` selbst löschen — die Datei wird lokal gebraucht.

---

#### P0-004 — Firestore Daten-Normalisierung ✅ DONE (products_v2 live, USE_PRODUCTS_V2=true)

**Problem:** Produktdaten in Firestore sind inkonsistent. Gleiche logische Daten existieren in verschiedenen physischen Formaten. Das betrifft nicht einzelne Felder, sondern systemischen Schema-Drift über die gesamte `products`-Collection.

**Bekannte Inkonsistenzen (durch Code-Analyse belegt):**
- `details.attributes`: Manche Produkte haben Array `[{key, value}]`, andere Object `{key: value}`. 24+ Code-Stellen prüfen defensiv mit `Array.isArray()`.
- Kategorie-Felder: 6+ Varianten für denselben Wert — `categoryId`, `ebayCategoryId`, `ebay_category_id`, `attributes.ebay_category_id`, `attributes['ebay.category_id']`, `attributes.category_id`.
- Gewicht: 5 verschiedene Feldnamen — `weight`, `Gewicht`, `Gewicht(kg)`, `Bruttogewicht`, etc.
- Leere Pflichtfelder: Schema erlaubt `minLength: 0`, Placeholder wie `'unbekannt'`, `'N/A'`, `'-'` existieren in Produktion.
- Marketplace-Metadaten (eBay/Kaufland-Kategorie-IDs) landen direkt in den User-Attributen statt in dedizierten Feldern.

**Impact:** Jede neue Funktion muss defensiv gegen 3-5 Varianten desselben Felds programmieren. Duplikate entstehen, weil Identity-Keys auf inkonsistenten Daten basieren. Quality-Gate-Ergebnisse sind unzuverlässig.

**Strategie: Bestehende Schutzmaßnahmen aktivieren → Parallele Collection → Write-Validator → Cutover**

Die Idee: Zuerst die bereits vorhandene (aber deaktivierte!) Validierungsinfrastruktur einschalten, dann neue saubere Collection `products_v2` aufbauen, alle Schreibvorgänge über einen Validator schützen, dann umschalten. Alte Collection bleibt als Backup.

---

**Schritt 0: Bestehende LLM-Validierung aktivieren (SOFORT, kein Code-Change nötig)**

> ⚠️ Es existiert bereits eine 3-stufige Validierung für LLM-Output, die per Default ABGESCHALTET ist.
> Das ist die Hauptursache für inkonsistente Daten: Die LLM-Features (Identify, Improve, Chat) schreiben
> ohne aktive Schutzmaßnahmen in Firestore.

**Bestehende Infrastruktur (bereits im Code, nur deaktiviert):**

| Modul | Zweck | Status |
|---|---|---|
| `lib/product-schema.js` | JSON-Schema-Validierung aller LLM-Outputs via Ajv | ✅ Aktiv (in enrichment.js) |
| `lib/llm-policy-pack.js` | Strikte Prompt-Regeln (Titel-Schema, Barcode-Validierung, Attribute-Format) | ❌ `LLM_POLICY_ENABLED=false` |
| `lib/llm-rulebook.js` | Post-LLM-Validierung (Title-Policy, Highlights, Attribute-Dedup, Placeholder-Elimination) | ❌ `RULEBOOK_ENABLED=false` |
| `lib/llm-config.js` | Admin-konfigurierbares Config-System per Scope (5 Scopes: identify, improve, chat, quality, image) | ✅ Aktiv |
| `lib/title-policy.js` | Titel-Längenregeln per Kategorie (65-80 Zeichen) | ⚡ Nur wenn Rulebook aktiv |
| `lib/highlights-policy.js` | 3-6 Bullet Points, <100 Zeichen, keine Duplikate | ⚡ Nur wenn Rulebook aktiv |
| `lib/attribute-policy.js` | Attribute-Deduplizierung, Blocked Keys, Max 60 Zeichen | ⚡ Nur wenn Rulebook aktiv |

**Anweisung — Environment-Variablen in Cloud Run aktivieren:**

1. **Zuerst auf Staging/Dev testen** (falls vorhanden), ansonsten mit kleinem Batch:
   ```
   LLM_POLICY_ENABLED=true
   RULEBOOK_ENABLED=true
   ```
2. **NICHT** `CHAT_STRICT_RULES_ENABLED` sofort aktivieren — Chat ist weniger kritisch und braucht Flexibilität.
3. **Monitoring:** Nach Aktivierung die Logs beobachten auf:
   - `LLM_RULEBOOK_VIOLATION` Errors in enrichment.js (Identify-Pfad → strikte Rejection)
   - `rulebook_apply_v1.issues` in gespeicherten Produkten (Improve-Pfad → Best-Effort-Tracking)
4. **Rollback:** Falls zu viele Identify-Jobs fehlschlagen: `RULEBOOK_ENABLED=false` zurücksetzen.

**Warum das wichtig ist:** Solange die Validierung aus ist, schreibt jeder Identify/Improve-Lauf potenziell inkonsistente Daten. Die Migration (Schritt 3) wäre sinnlos, wenn gleichzeitig neue schmutzige Daten reinkommen.

**Risiko:** Niedrig. Die Validierung existiert seit Monaten im Code. `normalizeProductStrict()` im Identify-Pfad wirft einen Error (Job schlägt fehl, aber kein Datenverlust). `normalizeProductForPolicyApply()` im Improve-Pfad ist Best-Effort (trackt Issues, speichert trotzdem).

---

**Schritt 1: Kanonisches Schema + Write-Validator**

1. Neue Datei: `backend/lib/product-canonical.js`
   ```js
   /**
    * Kanonisches Produkt-Schema.
    * JEDER Schreibvorgang auf products_v2 MUSS durch normalizeProduct() laufen.
    * Dieses Modul ist die EINZIGE Quelle der Wahrheit für die Datenstruktur.
    */

   /**
    * Normalisiert ein Produkt-Dokument in das kanonische Format.
    * Idempotent: Kann auf bereits normalisierte Dokumente angewendet werden.
    */
   function normalizeProduct(raw) {
     const product = structuredClone(raw);

     // ── 1. Attributes: Array → Object ──
     if (Array.isArray(product.details?.attributes)) {
       const obj = {};
       for (const entry of product.details.attributes) {
         const key = (entry?.key || '').trim();
         if (key) obj[key] = entry?.value ?? '';
       }
       product.details.attributes = obj;
     }
     if (!product.details) product.details = {};
     if (!product.details.attributes || typeof product.details.attributes !== 'object') {
       product.details.attributes = {};
     }

     // ── 2. Kategorie-Felder: Konsolidieren → details.categoryId ──
     if (!product.details.categoryId) {
       product.details.categoryId =
         product.details?.ebayCategoryId ||
         product.details?.ebay_category_id ||
         product.details?.attributes?.['ebay_category_id'] ||
         product.details?.attributes?.['ebay.category_id'] ||
         product.details?.attributes?.category_id ||
         product.details?.attributes?.categoryId ||
         null;
     }
     // Legacy-Felder entfernen (nur aus dem normalisierten Dokument)
     delete product.details.ebayCategoryId;
     delete product.details.ebay_category_id;

     // ── 3. Marketplace-Metadaten aus Attributes extrahieren ──
     if (!product.details.marketplace) product.details.marketplace = {};
     const attrs = product.details.attributes;
     const marketplaceKeys = [];
     for (const key of Object.keys(attrs)) {
       if (key.startsWith('ebay.') || key.startsWith('ebay_') ||
           key.startsWith('kaufland.') || key.startsWith('kaufland_')) {
         // In dediziertes marketplace-Objekt verschieben
         product.details.marketplace[key] = attrs[key];
         marketplaceKeys.push(key);
       }
     }
     for (const key of marketplaceKeys) {
       delete attrs[key];
     }

     // ── 4. Gewicht: Normalisieren → attributes.Gewicht ──
     const weightAliases = ['weight', 'Gewicht(kg)', 'Bruttogewicht', 'Artikelgewicht'];
     for (const alias of weightAliases) {
       if (attrs[alias] !== undefined && attrs['Gewicht'] === undefined) {
         attrs['Gewicht'] = attrs[alias];
       }
       if (alias !== 'Gewicht') delete attrs[alias];
     }

     // ── 5. Placeholder bereinigen → null statt Fake-Werte ──
     const placeholders = ['unbekannt', 'unknown', 'n/a', 'na', '-', '—', '--', 'null', 'N/A'];
     if (product.identification) {
       for (const field of ['name', 'brand', 'category']) {
         const val = (product.identification[field] || '').trim();
         if (!val || placeholders.includes(val.toLowerCase())) {
           product.identification[field] = null;
         }
       }
     }

     // ── 6. Pflichtfelder sicherstellen (mit Defaults) ──
     product.identification = product.identification || {};
     product.identification.method = product.identification.method || 'unknown';
     product.identification.barcodes = product.identification.barcodes || [];
     product.identification.confidence = product.identification.confidence ?? 0;
     product.details.short_description = product.details.short_description || '';
     product.details.key_features = product.details.key_features || [];
     product.details.identifiers = product.details.identifiers || {};
     product.details.images = product.details.images || [];
     product.details.pricing = product.details.pricing || {};
     product.ops = product.ops || {};
     product.notes = product.notes || {};

     // ── 7. Produkt-ID kanonisieren ──
     // Problem: 4 verschiedene ID-Formate existieren (EAN, prod-UUID, reiner UUID, Firestore Auto-ID).
     // Lösung: Kanonische ID-Hierarchie — bevorzuge Barcode-basierte IDs.
     const canonicalId = _pickCanonicalId(product);
     if (canonicalId && canonicalId !== product.id) {
       product.ops._originalId = product.id; // Original-ID als Backup
       product.id = canonicalId;
     }

     // ── 8. Normalisierungs-Metadaten ──
     product.ops._normalized = true;
     product.ops._normalizedAt = new Date().toISOString();
     product.ops._schemaVersion = 2;

     return product;
   }

   /**
    * Ermittelt die kanonische Produkt-ID nach Priorität:
    * 1. Gültige EAN/GTIN (13 oder 12 Ziffern)
    * 2. Gültige UPC (12 Ziffern)
    * 3. SKU (wenn vorhanden und kein Platzhalter)
    * 4. Bestehende ID beibehalten (UUID, Firestore Auto-ID etc.)
    *
    * WICHTIG: Gibt nur eine ID zurück wenn eine BESSERE gefunden wird.
    * Bestehende barcode-basierte IDs werden nicht verändert.
    */
   function _pickCanonicalId(product) {
     const identifiers = product.details?.identifiers || {};
     const barcodes = product.identification?.barcodes || [];

     // Kandidaten sammeln (Reihenfolge = Priorität)
     const candidates = [
       identifiers.ean,
       identifiers.gtin,
       ...barcodes,
       identifiers.upc,
     ]
       .map(v => v ? String(v).trim() : '')
       .filter(v => /^\d{12,14}$/.test(v)); // Nur gültige Barcodes (12-14 Ziffern)

     if (candidates.length > 0) {
       return candidates[0].replace(/\//g, '_'); // Firestore-safe
     }

     // Kein Barcode gefunden → bestehende ID beibehalten
     return null;
   }

   /**
    * Validiert ob ein Produkt dem kanonischen Schema entspricht.
    * Gibt { valid: true } oder { valid: false, errors: [...] } zurück.
    */
   function validateCanonical(product) {
     const errors = [];

     // Attributes MUSS Object sein, kein Array
     if (Array.isArray(product.details?.attributes)) {
       errors.push('details.attributes is Array, must be Object');
     }

     // Keine Legacy-Kategorie-Felder
     if (product.details?.ebayCategoryId) errors.push('Legacy field: details.ebayCategoryId');
     if (product.details?.ebay_category_id) errors.push('Legacy field: details.ebay_category_id');

     // Keine Marketplace-Keys in Attributes
     if (product.details?.attributes) {
       for (const key of Object.keys(product.details.attributes)) {
         if (key.startsWith('ebay.') || key.startsWith('ebay_') ||
             key.startsWith('kaufland.') || key.startsWith('kaufland_')) {
           errors.push(`Marketplace key in attributes: ${key}`);
         }
       }
     }

     // Produkt-ID Format prüfen
     if (product.id) {
       const id = String(product.id);
       // Warnung wenn UUID oder Firestore Auto-ID statt Barcode/SKU
       if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id) || /^prod-/.test(id)) {
         // Prüfe ob Barcode verfügbar wäre
         const identifiers = product.details?.identifiers || {};
         const barcodes = product.identification?.barcodes || [];
         const hasBarcode = [identifiers.ean, identifiers.gtin, ...barcodes]
           .some(v => v && /^\d{12,14}$/.test(String(v).trim()));
         if (hasBarcode) {
           errors.push(`Non-canonical ID "${id}" — barcode-based ID available but not used`);
         }
       }
     }

     // Keine Placeholder in Pflichtfeldern
     const placeholders = ['unbekannt', 'unknown', 'n/a', 'na', '-', '—', '--', 'null'];
     for (const field of ['name', 'brand', 'category']) {
       const val = (product.identification?.[field] || '').trim().toLowerCase();
       if (placeholders.includes(val)) {
         errors.push(`Placeholder in identification.${field}: "${val}"`);
       }
     }

     return errors.length ? { valid: false, errors } : { valid: true };
   }

   module.exports = { normalizeProduct, validateCanonical };
   ```

2. **NICHT** den bestehenden `saveProduct()` in `backend/lib/firestore.js` ändern. Der bleibt für die alte Collection.

---

**Schritt 2: Collection-Abstraktionsschicht**

1. Neue Datei: `backend/lib/product-store.js`
   ```js
   /**
    * Abstraktionsschicht für Produkt-Persistenz.
    * Entscheidet welche Collection genutzt wird (products vs products_v2).
    * Erzwingt Normalisierung bei allen Schreibvorgängen auf v2.
    */
   const { firestore } = require('./firestore');
   const { normalizeProduct, validateCanonical } = require('./product-canonical');

   // Feature-Flag: Umschalten zwischen alter und neuer Collection
   const COLLECTION = process.env.PRODUCT_COLLECTION || 'products';
   const V2_COLLECTION = 'products_v2';
   const USE_V2 = process.env.USE_PRODUCTS_V2 === 'true';

   function getCollection() {
     return USE_V2 ? V2_COLLECTION : COLLECTION;
   }

   /**
    * Produkt speichern — erzwingt Normalisierung wenn v2 aktiv.
    * Signatur identisch zu bestehendem saveProduct() für Drop-in-Replacement.
    */
   async function saveProductV2(productId, data, options = {}) {
     const collection = getCollection();

     if (collection === V2_COLLECTION) {
       // Normalisierung erzwingen
       const normalized = normalizeProduct(data);
       const validation = validateCanonical(normalized);
       if (!validation.valid) {
         console.error(`[saveProductV2] Validation failed for ${productId}:`, validation.errors);
         // Trotzdem speichern, aber Fehler loggen (kein Datenverlust)
         normalized.ops._validationErrors = validation.errors;
       }
       await firestore.collection(V2_COLLECTION).doc(productId).set(normalized, { merge: true });
       return normalized;
     }

     // Legacy-Pfad: unverändertes Verhalten
     await firestore.collection(COLLECTION).doc(productId).set(data, { merge: true });
     return data;
   }

   /**
    * Produkt lesen — aus aktiver Collection.
    */
   async function getProductV2(productId) {
     const doc = await firestore.collection(getCollection()).doc(productId).get();
     return doc.exists ? { id: doc.id, ...doc.data() } : null;
   }

   /**
    * Alle Produkte lesen — aus aktiver Collection.
    */
   async function getAllProductsV2(queryFn) {
     let ref = firestore.collection(getCollection());
     if (queryFn) ref = queryFn(ref);
     const snap = await ref.get();
     return snap.docs.map(d => ({ id: d.id, ...d.data() }));
   }

   module.exports = {
     saveProductV2,
     getProductV2,
     getAllProductsV2,
     getCollection,
     COLLECTION,
     V2_COLLECTION,
     USE_V2,
   };
   ```

2. **WICHTIG:** Die bestehenden `saveProduct`/`getProduct`/`getAllProducts` in `firestore.js` NICHT ändern oder entfernen. `product-store.js` ist ein neuer Layer DARÜBER.

---

**Schritt 3: Migrations-Script**

1. Neue Datei: `backend/scripts/migrate-products-v2.js`
   ```js
   /**
    * Migration: products → products_v2
    *
    * Liest alle Produkte aus der alten Collection,
    * normalisiert sie und schreibt sie in products_v2.
    *
    * Usage:
    *   DRY_RUN=true node scripts/migrate-products-v2.js   # Nur Analyse, kein Schreiben
    *   node scripts/migrate-products-v2.js                 # Tatsächliche Migration
    */
   const { firestore } = require('../lib/firestore');
   const { normalizeProduct, validateCanonical } = require('../lib/product-canonical');

   const DRY_RUN = process.env.DRY_RUN !== 'false';
   const BATCH_SIZE = 500;

   async function migrate() {
     console.log(`=== Products v2 Migration (DRY_RUN=${DRY_RUN}) ===`);

     const snapshot = await firestore.collection('products').get();
     console.log(`Found ${snapshot.size} products to migrate.`);

     let migrated = 0, errors = 0, skipped = 0;
     const issues = { attributeArray: 0, legacyCategory: 0, placeholders: 0, marketplaceInAttrs: 0, idRewritten: 0, duplicatesFound: 0 };
     const idMap = new Map(); // canonicalId → [originalIds] für Duplikat-Erkennung
     let batch = firestore.batch();
     let batchCount = 0;

     for (const doc of snapshot.docs) {
       try {
         const raw = { id: doc.id, ...doc.data() };
         const normalized = normalizeProduct(raw);
         const validation = validateCanonical(normalized);

         // Statistik sammeln
         if (Array.isArray(doc.data().details?.attributes)) issues.attributeArray++;
         if (doc.data().details?.ebayCategoryId || doc.data().details?.ebay_category_id) issues.legacyCategory++;
         if (!validation.valid) {
           validation.errors.forEach(e => {
             if (e.includes('Placeholder')) issues.placeholders++;
             if (e.includes('Marketplace key')) issues.marketplaceInAttrs++;
           });
         }

         // ID-Rewrite tracken
         if (normalized.id !== doc.id) issues.idRewritten++;

         // Duplikat-Erkennung: gleiche kanonische ID von verschiedenen Original-Docs
         const targetId = normalized.id || doc.id;
         if (idMap.has(targetId)) {
           idMap.get(targetId).push(doc.id);
           issues.duplicatesFound++;
           console.warn(`  DUPLICATE: ${doc.id} → ${targetId} (also: ${idMap.get(targetId).join(', ')})`);
         } else {
           idMap.set(targetId, [doc.id]);
         }

         if (!DRY_RUN) {
           batch.set(firestore.collection('products_v2').doc(targetId), normalized);
           batchCount++;
           if (batchCount >= BATCH_SIZE) {
             await batch.commit();
             batch = firestore.batch();
             batchCount = 0;
             console.log(`  ...committed ${migrated + batchCount} products`);
           }
         }
         migrated++;
       } catch (err) {
         console.error(`Error migrating ${doc.id}: ${err.message}`);
         errors++;
       }
     }

     if (!DRY_RUN && batchCount > 0) await batch.commit();

     console.log(`\n=== Migration Complete ===`);
     console.log(`Migrated: ${migrated}, Errors: ${errors}, Skipped: ${skipped}`);
     console.log(`\nIssues found & fixed:`);
     console.log(`  Attributes as Array: ${issues.attributeArray}`);
     console.log(`  Legacy category fields: ${issues.legacyCategory}`);
     console.log(`  Placeholder values: ${issues.placeholders}`);
     console.log(`  Marketplace keys in attributes: ${issues.marketplaceInAttrs}`);
     console.log(`  IDs rewritten to barcode: ${issues.idRewritten}`);
     console.log(`  Duplicates detected: ${issues.duplicatesFound}`);

     if (DRY_RUN) {
       console.log(`\n⚠️  DRY RUN — No data was written. Run with DRY_RUN=false to execute.`);
     }
   }

   migrate().catch(console.error);
   ```

2. **Reihenfolge der Ausführung:**
   - Erst: `DRY_RUN=true node scripts/migrate-products-v2.js` → Analyse & Zahlen
   - Dann: Ergebnisse prüfen, Schema-Regeln ggf. anpassen
   - Dann: `DRY_RUN=false node scripts/migrate-products-v2.js` → Tatsächliche Migration
   - Dann: Stichprobenprüfung in Firestore Console
   - Dann: `USE_PRODUCTS_V2=true` in Cloud Run Environment setzen

---

**Schritt 4: Cutover (Umschaltung)**

1. In `backend/cloudbuild.yaml` neue Environment-Variable hinzufügen:
   ```yaml
   '--set-env-vars', 'USE_PRODUCTS_V2=true'
   ```
   **ERST setzen NACHDEM Migration + Stichprobenprüfung erfolgreich.**

2. Alte `products`-Collection NICHT löschen. Sie bleibt als Backup.
   Frühestens nach 30 Tagen fehlerfreiem Betrieb archivieren.

3. **Rollback-Plan:** `USE_PRODUCTS_V2=false` setzen → sofort zurück auf alte Collection.

---

**Schritt 5: Schrittweise Integration in bestehende Schreibpfade**

> ⚠️ ERST nach erfolgreichem Cutover. NICHT vorher.

Alle Stellen die Produkte schreiben müssen schrittweise auf `saveProductV2()` umgestellt werden. Die kritischen Schreibpfade sind:

| Schreibpfad | Datei | Priorität | Warum |
|---|---|---|---|
| Enrichment (Identify) | `backend/services/enrichment.js` | 🔴 Höchste | **Hauptverursacher** inkonsistenter Daten. LLM-Output → Firestore. Hat 3-stufige Validierung, aber schreibt über altes `saveProduct()`. |
| Improve Runner | `backend/services/improve.js` | 🔴 Höchste | **Zweitgrößter Verursacher.** Best-Effort-Rulebook trackt Issues, aber speichert trotzdem unsauber. |
| Product Chat | `backend/services/product-chat.js` | 🟡 Hoch | Chat kann Produktdaten modifizieren. Weniger strikt als Identify/Improve. |
| Manuelles Speichern (UI) | `backend/index.js` → `saveProduct()` Calls | 🟡 Hoch | User-Input → direkt in Firestore, keine Schema-Validierung. |
| Quality Gate | `backend/services/quality-gate.js` | 🟢 Mittel | Schreibt `ops.data_quality`-Felder, nicht Produktdaten selbst. |
| Bulk Actions | `backend/services/admin-bulk-actions.js` | 🟢 Mittel | Massenoperationen — multipliziert Inkonsistenzen wenn unsauber. |
| BaseLinker Sync | `backend/services/inventory-sync.js` | ⚪ Niedrig | Schreibt primär Inventar-Felder, nicht Produktstammdaten. |
| Rulebook Runner | `backend/services/rulebook-runner.js` | ⚪ Niedrig | Normalisiert bestehende Daten — wird durch v2 teilweise obsolet. |

**Vorgehen pro Schreibpfad:**
1. `saveProduct()` Call durch `saveProductV2()` ersetzen
2. Import hinzufügen: `const { saveProductV2 } = require('./lib/product-store');`
3. Testen dass der Pfad weiterhin funktioniert
4. **NICHT** mehrere Schreibpfade gleichzeitig umstellen — einer nach dem anderen

---

#### P1-001 — Structured Logging einführen ✅ DONE (Pino + pino-http)

**Problem:** Nur `console.log`/`console.error`. Kein Request-Tracing, keine strukturierten Logs für Cloud Run.
**Impact:** Debugging in Produktion extrem schwierig.

**Anweisung:**
1. `cd backend && npm install pino pino-http`
2. Neue Datei: `backend/lib/logger.js`:
   ```js
   const pino = require('pino');

   const logger = pino({
     level: process.env.LOG_LEVEL || 'info',
     // Cloud Run erwartet severity-Feld für Log Explorer
     messageKey: 'message',
     formatters: {
       level(label) {
         const severityMap = { trace: 'DEBUG', debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR', fatal: 'CRITICAL' };
         return { severity: severityMap[label] || 'DEFAULT' };
       },
     },
   });

   module.exports = logger;
   ```
3. Neue Datei: `backend/lib/request-logger.js`:
   ```js
   const pinoHttp = require('pino-http');
   const logger = require('./logger');

   const requestLogger = pinoHttp({
     logger,
     autoLogging: {
       ignore: (req) => req.url === '/health' || req.url === '/ready',
     },
     customLogLevel: (req, res, err) => {
       if (res.statusCode >= 500 || err) return 'error';
       if (res.statusCode >= 400) return 'warn';
       return 'info';
     },
   });

   module.exports = requestLogger;
   ```
4. In `backend/index.js`:
   - Import hinzufügen: `const requestLogger = require('./lib/request-logger');`
   - Nach CORS/Helmet/Rate-Limit Middleware einfügen: `app.use(requestLogger);`
5. **NICHT** bestehende `console.log`/`console.error` Aufrufe entfernen oder ändern. Die bleiben erstmal. Neue Logs nutzen den Logger.

---

#### P1-002 — Health-Check & Graceful Shutdown ✅ DONE

**Problem:** Kein Health-Endpoint. Kein Graceful Shutdown für Cloud Run.
**Impact:** Cloud Run kann Container-Gesundheit nicht prüfen. Laufende Requests werden bei Deployments abgebrochen.

**Anweisung:**
1. In `backend/index.js`, neue Routen ÜBER den authentifizierten Routen (vor `requireAuth` Middleware):
   ```js
   // Health checks — keine Auth nötig
   app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
   app.get('/ready', (req, res) => res.json({ status: 'ready' }));
   ```
2. Graceful Shutdown am Ende der Datei (nach `app.listen`):
   ```js
   // Graceful shutdown für Cloud Run
   process.on('SIGTERM', () => {
     console.log('SIGTERM received. Shutting down gracefully...');
     server.close(() => {
       console.log('HTTP server closed.');
       process.exit(0);
     });
     // Force-close nach 10s
     setTimeout(() => process.exit(1), 10000);
   });
   ```
   Dafür muss `app.listen` ein `server`-Objekt zurückgeben:
   ```js
   const server = app.listen(PORT, () => { ... });
   ```
   **Prüfe** ob `app.listen` bereits einer Variable zugewiesen ist. Falls nicht, ändere nur die Zuweisung.
3. **NICHT** bestehende Startup-Logik ändern (Runner-Starts, Order-Sync-Intervall etc.).

---

#### P1-003 — Vitest Infrastruktur aufsetzen ✅ DONE (119 Tests, 7 Suiten)

**Problem:** Keine Test-Infrastruktur. 2 existierende Test-Dateien, kein Framework konfiguriert.
**Impact:** Keine automatische Regression-Erkennung.

**Anweisung:**
1. `cd backend && npm install --save-dev vitest`
2. Neue Datei: `backend/vitest.config.js`:
   ```js
   import { defineConfig } from 'vitest/config';

   export default defineConfig({
     test: {
       globals: true,
       environment: 'node',
       include: ['**/*.test.js', '**/__tests__/**/*.js'],
       exclude: ['node_modules', 'scripts'],
       testTimeout: 10000,
     },
   });
   ```
3. In `backend/package.json` Script hinzufügen:
   ```json
   "scripts": {
     "start": "node index.js",
     "test": "vitest run",
     "test:watch": "vitest"
   }
   ```
4. Starter-Tests erstellen — **nur für risikofreie Pure Functions**, keine API-Calls:
   - `backend/lib/__tests__/gtin.test.js` — Teste GTIN-Validierung
   - `backend/lib/__tests__/product-identity.test.js` — Teste Identity-Key-Building
   - `backend/lib/__tests__/brand-normalize.test.js` — Teste Brand-Normalisierung
5. **NICHT** bestehende Test-Dateien (`ebay-trading-api.test.js`, `pick-hints.test.js`) ändern.
6. **NICHT** Tests schreiben die externe APIs aufrufen (Firestore, Gemini, eBay etc.).

**Validierung:** `cd backend && npm test` → Tests laufen erfolgreich.

---

#### P1-004 — Error Response Standardisierung ✅ DONE (AppError + errorHandler)

**Problem:** Inkonsistente Fehlerantworten. Manche Endpoints geben `{ ok: false, error: {...} }`, andere raw Status-Codes.
**Impact:** Frontend muss verschiedene Fehlerformate handeln.

**Anweisung:**
1. Neue Datei: `backend/lib/error-handler.js`:
   ```js
   class AppError extends Error {
     constructor(code, message, statusCode = 500) {
       super(message);
       this.code = code;
       this.statusCode = statusCode;
     }
   }

   function errorHandler(err, req, res, next) {
     const statusCode = err.statusCode || 500;
     const code = err.code || 'INTERNAL_ERROR';
     const message = err.message || 'An unexpected error occurred';

     if (statusCode >= 500) {
       console.error(`[${req.method} ${req.path}] ${code}: ${message}`, err.stack);
     }

     res.status(statusCode).json({
       ok: false,
       error: { code, message },
     });
   }

   module.exports = { AppError, errorHandler };
   ```
2. In `backend/index.js`, ganz am Ende (nach allen Routen, vor `app.listen`):
   ```js
   const { errorHandler } = require('./lib/error-handler');
   app.use(errorHandler);
   ```
3. **NICHT** bestehende try/catch-Blöcke in existierenden Routen ändern. Die bleiben wie sie sind. Nur NEUE Endpoints nutzen `next(err)` mit `AppError`.

---

### PHASE 2: Code-Qualität & DX ✅ ABGESCHLOSSEN (2026-02/03)

#### P1-005 — Express Router Splitting ✅ DONE (7 Router-Module in backend/routes/)

**Problem:** 7.571 Zeilen, 149 Routen in einer Datei.
**Impact:** Schwer wartbar, Merge-Konflikte, langsames Onboarding.

**Anweisung:**
1. Neue Verzeichnisstruktur erstellen:
   ```
   backend/routes/
   ├── products.js
   ├── orders.js
   ├── warehouse.js
   ├── identify.js
   ├── marketplace.js
   ├── admin.js
   └── auth.js
   ```
2. **SCHRITTWEISE** migrieren — EIN Router pro PR. Nicht alles auf einmal.
3. Jeder Router exportiert einen Express Router:
   ```js
   const router = require('express').Router();
   const { requireAuth, requirePermission } = require('../lib/auth');
   // ... routes
   module.exports = router;
   ```
4. In `backend/index.js` werden Router eingehängt:
   ```js
   app.use('/api/products', require('./routes/products'));
   ```
5. **KRITISCH:** Die Original-Route in `index.js` erst entfernen, NACHDEM der Router getestet ist. Keine Route darf zwischendurch fehlen.
6. **Reihenfolge:** Starte mit den einfachsten, isoliertesten Routen (z.B. `/api/warehouse/*`).

---

#### P1-006 — API Versioning Strategie ✅ DONE

**Problem:** Nur 2 von 149 Routen haben Versionierung (`/api/v2/enrich`, `/api/v2/identify`).
**Impact:** Breaking Changes können nicht graceful eingeführt werden.

**Anweisung:**
1. Neue Routen IMMER unter `/api/v1/` erstellen.
2. Bestehende unversionierte Routen (`/api/products`, `/api/orders` etc.) bleiben als Legacy erhalten.
3. Erstelle Datei `backend/lib/api-version.js`:
   ```js
   // API-Versionierung: Legacy-Routen werden auf v1 gemappt
   // Neue Features nur in versionierten Routen
   const API_VERSIONS = {
     current: 'v1',
     supported: ['v1'],
     deprecated: [], // Legacy-Routen ohne Version-Prefix
   };

   module.exports = { API_VERSIONS };
   ```
4. **NICHT** bestehende Routen-Pfade umbenennen. Das würde das Frontend brechen.

---

#### P2-001 — SSE für Job-Status ✅ DONE (useJobStream.ts Hook im Frontend)

**Problem:** Frontend pollt alle paar Sekunden den Job-Status. Ineffizient bei vielen Nutzern.
**Impact:** Unnötige API-Last, verzögerte Status-Updates.

**Anweisung:**
1. Server-Sent Events (SSE) bevorzugen — einfacher als WebSockets, reicht für Job-Status.
2. Neuer Endpoint: `GET /api/jobs/:id/stream`
   ```js
   app.get('/api/jobs/:id/stream', requireAuth, (req, res) => {
     res.writeHead(200, {
       'Content-Type': 'text/event-stream',
       'Cache-Control': 'no-cache',
       'Connection': 'keep-alive',
     });

     const jobId = req.params.id;
     // Firestore onSnapshot listener
     const unsubscribe = firestore.collection('identificationJobs').doc(jobId)
       .onSnapshot((snap) => {
         if (snap.exists) {
           res.write(`data: ${JSON.stringify(snap.data())}\n\n`);
         }
       });

     req.on('close', () => {
       unsubscribe();
       res.end();
     });
   });
   ```
3. **Frontend:** Neuen Hook `useJobStream.ts` erstellen der `EventSource` nutzt.
4. **WICHTIG:** Den bestehenden Polling-Mechanismus im Frontend NICHT entfernen. SSE als Upgrade anbieten, Polling als Fallback behalten.

---

### PHASE 3: Feature Development ✅ ABGESCHLOSSEN (2026-02/03)

#### P2-002 — Smart Pricing Engine ✅ DONE (services/pricing-engine.js)

**Problem:** Preisfindung ist manuell. Nur punktuelle Konkurrenzabfragen.
**Impact:** Verpasste Margen-Optimierung. Höchster Hebel für Umsatzsteigerung.

**Anweisung:**
1. Neuer Service: `backend/services/pricing-engine.js`
2. Funktionen:
   - `calculateOptimalPrice(productId)` — Basierend auf: Konkurrenzpreise, Lagerbestand-Alter, Kategorie-Durchschnitt, eigene Kosten
   - `runRepricingJob()` — Batch-Job der alle aktiven Listings prüft und Preisvorschläge generiert
   - `applyPriceRule(productId, rule)` — Regelbasiert: "Immer 5% unter günstigstem Konkurrent"
3. Neues Firestore-Schema (additiv):
   ```
   Collection: pricingRules
   Document: { productId, ruleType, params, active, lastApplied }

   Product-Feld (additiv): product.pricing.suggestedPrice, product.pricing.lastPriceCheck
   ```
4. Neue Routen:
   - `POST /api/v1/pricing/suggest/:productId`
   - `POST /api/v1/pricing/rules`
   - `GET /api/v1/pricing/rules`
   - `POST /api/v1/pricing/reprice-batch`
5. **NICHT** bestehende Preis-Felder (`product.pricing.buyPrice`, `product.pricing.sellPrice`) überschreiben. Neue Felder daneben.

---

#### P2-003 — Inventory Forecasting ✅ DONE (services/inventory-forecast.js)

**Problem:** Keine Vorhersage von Stock-Outs.
**Impact:** Verpasste Verkäufe durch unerwarteten Leerbestand.

**Anweisung:**
1. Neuer Service: `backend/services/inventory-forecast.js`
2. Funktionen:
   - `calculateSalesVelocity(productId, days = 30)` — Durchschnittliche Verkäufe/Tag
   - `predictStockOut(productId)` — Geschätztes Datum bei aktueller Geschwindigkeit
   - `generateReorderAlerts()` — Alle Produkte mit Stock-Out in < 14 Tagen
3. Neues Firestore-Schema (additiv):
   ```
   Product-Feld (additiv): product.forecast.salesVelocity, product.forecast.predictedStockOut, product.forecast.lastCalculated
   ```
4. Neue Routen:
   - `GET /api/v1/forecast/:productId`
   - `GET /api/v1/forecast/alerts`
5. Runner: `backend/services/forecast-runner.js` — Täglich als Cloud Run Job oder Intervall.

---

#### P2-004 — Webhook-System ✅ DONE (services/webhooks.js)

**Problem:** Keine Möglichkeit für externe Systeme, auf Events zu reagieren.
**Impact:** Kein Ökosystem, keine Automatisierung mit Dritttools.

**Anweisung:**
1. Neuer Service: `backend/services/webhooks.js`
2. Firestore Collection: `webhooks`
   ```
   { url, events: ['order.created', 'order.shipped', 'product.updated'], secret, active, createdBy }
   ```
3. Dispatch-Funktion:
   ```js
   async function dispatchWebhook(event, payload) {
     const hooks = await getActiveWebhooksForEvent(event);
     for (const hook of hooks) {
       const signature = crypto.createHmac('sha256', hook.secret).update(JSON.stringify(payload)).digest('hex');
       // Fire-and-forget mit Retry-Queue
       fetch(hook.url, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': signature },
         body: JSON.stringify({ event, payload, timestamp: Date.now() }),
       }).catch(err => console.error(`Webhook ${hook.url} failed: ${err.message}`));
     }
   }
   ```
4. Admin-Routen:
   - `POST /api/v1/webhooks`
   - `GET /api/v1/webhooks`
   - `DELETE /api/v1/webhooks/:id`
5. Integration: `dispatchWebhook()` in bestehende Order-Sync und Produkt-Save Logik einbauen — aber NUR als zusätzlichen Aufruf am Ende, NICHT die bestehende Logik verändern.

---

#### P2-005 — Produkt-Deduplizierung ✅ DONE (services/deduplication.js)

**Problem:** Keine automatische Erkennung von Duplikaten. Manuelles Löschen bei Tausenden SKUs nicht skalierbar.
**Impact:** Datenqualität, falsche Lagerbestände, doppelte Listings.

**Anweisung:**
1. Neuer Service: `backend/services/deduplication.js`
2. Funktionen:
   - `findDuplicates()` — Suche nach gleicher EAN/MPN/Brand+Model Kombination
   - `suggestMerge(productIdA, productIdB)` — Zeige Unterschiede, schlage Merge vor
   - `executeMerge(keepId, removeId)` — Übertrage Daten von removeId → keepId, markiere removeId als archived
3. **NIEMALS** automatisch löschen. Immer Vorschlag + manuelle Bestätigung.
4. Neue Routen:
   - `GET /api/v1/products/duplicates`
   - `POST /api/v1/products/merge`

---

#### P3-001 — Competitor Intelligence Dashboard ✅ DONE (priceHistory Collection)

**Problem:** Nur Momentaufnahme der Konkurrenzpreise, keine Trends.

**Anweisung:**
1. Neues Firestore-Schema (additiv):
   ```
   Collection: priceHistory
   Document: { productId, competitor, price, source, timestamp }
   ```
2. Bei jedem Preis-Check: Ergebnis in `priceHistory` speichern (nicht nur überschreiben).
3. Neue Routen:
   - `GET /api/v1/competitors/:productId/history?days=30`
   - `GET /api/v1/competitors/overview`
4. Frontend: Chart-Komponente mit Recharts (bereits als Dependency vorhanden).

---

### PHASE 4: SaaS-Readiness (Langfristig)

#### P3-002 — Multi-Tenancy Vorbereitung

> ⚠️ Großes Refactoring. Nur mit expliziter Anweisung starten.

**Konzept:**
- Jedes Firestore-Dokument bekommt ein `orgId`-Feld.
- Alle Queries werden um `orgId`-Filter erweitert.
- Auth-Middleware extrahiert `orgId` aus User-Profil.
- **Migration:** Bestehende Dokumente bekommen Default-`orgId`.

**Anweisung:** NICHT eigenständig starten. Warte auf explizites Go.

---

#### P3-003 — Billing mit Stripe

> ⚠️ Nur mit expliziter Anweisung.

**Konzept:**
- 3 Tiers: Starter (50 Produkte), Pro (500 Produkte), Enterprise (unlimited)
- Usage-Tracking: Identify-Calls, Storage, Active Listings
- Stripe Checkout + Webhooks für Subscription Management

---

## Referenz: Bestehende externe Integrationen

Nicht ändern ohne explizite Anweisung:

| Integration | Datei(en) | Zweck |
|---|---|---|
| eBay OAuth + Trading API | `lib/ebay-oauth.js`, `lib/ebay-api.js`, `lib/ebay-trading-api.js`, `lib/ebay-direct.js` | Listing CRUD, Orders |
| Kaufland API | `lib/kaufland-api.js`, `lib/kaufland-taxonomy.js` | Product Sync |
| BaseLinker API | `lib/baselinker-*.js`, `services/baselinker-*.js`, `services/inventory-sync.js` | Orders, Inventory |
| Google Gemini | `lib/gemini-client.js`, `lib/gemini.js`, `lib/gemini-structured.js` | KI-Identifikation |
| SerpApi | `services/enrichment-v2.js` | Preisrecherche |
| BrightData | `lib/web-unlocker.js` | Web Scraping Proxy |
| SendCloud | `lib/sendcloud.js` | Versand |
| SevDesk | `lib/sevdesk.js` | Buchhaltung |
| Firebase Auth | `lib/auth.js` | Authentifizierung |
| Cloud Storage | `lib/storage.js` | Bildupload |

## Referenz: Job-Runner-System

Das Backend startet mehrere Worker-Prozesse beim Hochfahren. Diese NICHT ändern:

| Runner | Datei | Zweck |
|---|---|---|
| Job Runner | `services/job-runner.js` | Produktidentifikation via Gemini |
| Improve Runner | `services/improve-runner.js` | Datenverbesserung |
| Quality Runner | `services/quality-runner.js` | Quality-Gate Validierung |
| BaseLinker Sync | `services/baselinker-sync-runner.js` | Inventar-Sync |
| Admin Bulk | `services/admin-bulk-runner.js` | Massen-Operationen |
| Rulebook Runner | `services/rulebook-runner.js` | Regel-Ausführung |

---

## Checkliste vor jedem Commit

- [ ] Bestehende Routen unverändert? (oder explizit angewiesen)
- [ ] Keine Firestore-Felder umbenannt/entfernt?
- [ ] Keine Dependencies entfernt?
- [ ] Neue Funktion hat try/catch mit strukturiertem Error?
- [ ] Neue Funktion hat mindestens 1 Test?
- [ ] `cd backend && npm test` läuft erfolgreich?
- [ ] Frontend baut: `npm run build` ohne Fehler?
- [ ] Kein Secret/Key im Code hardcoded?
