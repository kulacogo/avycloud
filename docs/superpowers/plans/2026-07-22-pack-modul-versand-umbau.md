# Pack-Modul Versand-Umbau Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Beim Verpacken einer Bestellung Gewicht immer abfragen, dann eine kurze kuratierte Versand-Produktliste (Plakat-Nomenklatur, keine Zusatzleistungen) nach Gewicht+Zielland anbieten und das Label mit exaktem SendCloud-v3-Code erstellen.

**Architecture:** Additiv, hinter Flag `PACK_CURATED_SHIPPING`. Neue Katalog-Config + reiner Resolver mappen die LIVE-v3-Optionen von SendCloud auf kuratierte Produkt-Slots (selbst-korrigierend: zeigt nur, was SendCloud wirklich anbietet; benennt jedes Produkt ehrlich). Neuer Endpoint `GET /api/orders/:id/shipping-options` liefert die Liste; `ship` akzeptiert einen exakten `shippingOptionCode`, der den Fuzzy-Resolver umgeht. Der alte Flow (Versandregeln) bleibt in Phase 1 als Fallback unverändert; Entfernung erst Phase 2 nach Owner-Abnahme.

**Tech Stack:** Node.js 20 CommonJS (Backend), Vitest (require.cache-Patching, kein vi.mock), React 18 + TypeScript + Vite (Frontend), SendCloud v3 API.

## Global Constraints

- Backend: CommonJS, 2 Spaces, Single Quotes, async/await, try/catch mit strukturiertem Error `{ ok:false, error:{ code, message } }`.
- Frontend: TypeScript, 2 Spaces, Double Quotes, Functional Components + Hooks, nur Design-Tokens (`bg-accent`, `text-txt-primary`), Dark-Mode-Default + `[data-theme='light']`.
- Tests: `cd backend && npm test`. Vitest globals (kein `require('vitest')`). CJS-Mocking via require.cache-Patching, NIE `vi.mock()`.
- Produktions-Sicherheit: additive only. Keine Firestore-Felder umbenennen/löschen. Kein `omsStatus`-Direct-Write (nur `transitionOrder()`). Yellow-Zone-Dateien (`routes/orders.js`, `api/client.ts`, `MobileOperationsView.tsx`, `OrderDetail.tsx`, `services/shipping-engine.js`) nur additiv.
- Conventional Commits (`feat:`, `test:`, `refactor:`), kein Force-Push, kein Commit auf `main` (Branch `feat/pack-curated-shipping`).
- Keine Zusatzleistungen im Katalog: NIE `gogreen|eco_delivery|premium|service_point|locker|filial|alterssicht|agecheck|transportversicherung|insurance|express|sperrgut`.
- Zonen sind TrendOcean-Business-Regeln, NICHT SendClouds `countries` — der Katalog erzwingt `allowedCountries` selbst.
- Label immer über exakten v3-`shippingOptionCode`; „Ohne Tracking" ist kein Sonderfall (SendCloud liefert immer eine Sendungsnummer, die der bestehende Marktplatz-Push überträgt).

---

## File Structure

**Backend (neu):**
- `backend/config/shipping-catalog.js` — Katalog-Daten: Produkt-Slots (`match(code)`-Prädikate), Zonen, DPD_EUROPA, verbotene Modifier.
- `backend/lib/shipping-catalog-resolver.js` — reine Funktionen `classifyDestination`, `resolveCuratedOptions`, `modifierCount`, `optionWeightFits`.
- `backend/scripts/probe-shipping-options.js` — Read-only-Probe: dumpt echte v3-Codes pro Lane (läuft in Prod/mit Creds).
- Tests: `backend/__tests__/shipping-catalog-resolver.test.js`, `backend/__tests__/ship-with-option-code.test.js`, `backend/__tests__/shipping-options-endpoint.test.js`.

**Backend (modifiziert, additiv):**
- `backend/services/shipping-engine.js` — `createParcel`/`shipOrder` akzeptieren `shippingOptionCode`; neue `listCuratedShippingOptions({ order, weightKg })`; Export ergänzen.
- `backend/routes/orders.js` — neuer `GET /orders/:orderId/shipping-options`; `POST /orders/:orderId/ship` liest `shippingOptionCode`.

**Frontend (modifiziert, additiv):**
- `api/client.ts` — `fetchShippingOptions()`, Typen; `shipOrder`-opts um `shippingOptionCode`.
- `components/orders/ShippingDecisionDialog.tsx` — neuer `ShippingOptionModal` (kuratierte Liste); `WeightPromptModal` bleibt (immer gezeigt + vorbefüllt).
- `components/OrderDetail.tsx` + `components/MobileOperationsView.tsx` — neuen Flow feature-detektiert einbinden (alt bleibt Fallback).

---

## Task 1: Kuratierter Katalog + Resolver (reine Logik)

**Files:**
- Create: `backend/config/shipping-catalog.js`
- Create: `backend/lib/shipping-catalog-resolver.js`
- Test: `backend/__tests__/shipping-catalog-resolver.test.js`

**Interfaces:**
- Produces:
  - `shipping-catalog.js` exports: `{ ZONE_1: string[], ZONE_2: string[], DPD_EUROPA: string[], FORBIDDEN: RegExp, PRODUCTS: Array<{ key, displayName, carrier, scope:'national'|'international', maxWeightKg:number, tracking:boolean, rank:number, allowedCountries?:string[], requiresFlag?:string, match:(code:string)=>boolean }> }`
  - `shipping-catalog-resolver.js` exports: `classifyDestination(country:string) => { country:string, scope:'national'|'international', warn:boolean }`, `resolveCuratedOptions(liveOptions:Array<{code:string,weight?:{min?:{value},max?:{value}}}>, { country:string, weightKg:number, flags?:object }) => { scope, country, warn, products: Array<{ key, displayName, carrier, tracking, shippingOptionCode, rank }> }`, `optionWeightFits(o, weightKg)`, `modifierCount(code:string)=>number`.

- [ ] **Step 1: Write the failing test**

Create `backend/__tests__/shipping-catalog-resolver.test.js`:

```js
'use strict';
const {
  classifyDestination,
  resolveCuratedOptions,
  modifierCount,
} = require('../lib/shipping-catalog-resolver');

// Live-Optionen wie SendCloud v3 /shipping-options sie liefert (echte Codes beobachtet).
const opt = (code, min = 0, max = 31.5) => ({ code, weight: { min: { value: min }, max: { value: max } } });

describe('classifyDestination', () => {
  it('DE ist national ohne Warnung', () => {
    expect(classifyDestination('DE')).toEqual({ country: 'DE', scope: 'national', warn: false });
  });
  it('leer -> DE national', () => {
    expect(classifyDestination('').scope).toBe('national');
  });
  it('Zone-1-Land (FR) ist international ohne Warnung', () => {
    expect(classifyDestination('fr')).toEqual({ country: 'FR', scope: 'international', warn: false });
  });
  it('Nicht-Zone-Land (GR) ist international MIT Warnung', () => {
    expect(classifyDestination('GR')).toEqual({ country: 'GR', scope: 'international', warn: true });
  });
});

describe('modifierCount', () => {
  it('zaehlt Modifier nach dem Slash', () => {
    expect(modifierCount('dhl_de:dhl_paket')).toBe(0);
    expect(modifierCount('dp:grossbrief/mailbox')).toBe(1);
    expect(modifierCount('dp:maxibrief_integral/extra_fee,mailbox,signature')).toBe(3);
  });
});

describe('resolveCuratedOptions – national (DE)', () => {
  const live = [
    opt('dp:grossbrief/mailbox', 0, 0.5),
    opt('dp:warensendung/mailbox', 0, 1),
    opt('dhl_de:warenpost', 0, 1),
    opt('dhl_de:dhl_paket', 0, 31.5),
    opt('dpd:classic', 0, 5),
    // Rauschen, das ausgeschlossen werden muss:
    opt('dhl_de:warenpost/gogreen', 0, 1),
    opt('dhl_de:paket_eco_delivery/home_address_only', 0, 31.5),
    opt('dhl_de:dhl_paket/service_point', 0, 31.5),
    opt('dhl_de:warenpostinternational', 0, 1),
  ];

  it('zeigt fuer 0,45 kg die nationalen Produkte, billigste zuerst, ohne Zusatzleistungen', () => {
    const r = resolveCuratedOptions(live, { country: 'DE', weightKg: 0.45 });
    expect(r.scope).toBe('national');
    expect(r.warn).toBe(false);
    expect(r.products.map((p) => p.key)).toEqual(['grossbrief', 'warensendung', 'kleinpaket', 'dpd_classic', 'dhl_paket']);
    // exakter Code, plainste Variante:
    expect(r.products.find((p) => p.key === 'kleinpaket').shippingOptionCode).toBe('dhl_de:warenpost');
    // keine international-Produkte bei DE:
    expect(r.products.find((p) => p.key === 'warenpost_int')).toBeUndefined();
  });

  it('filtert nach Gewicht: 3 kg entfernt Brief/Warensendung/Kleinpaket', () => {
    const r = resolveCuratedOptions(live, { country: 'DE', weightKg: 3 });
    expect(r.products.map((p) => p.key)).toEqual(['dpd_classic', 'dhl_paket']);
  });

  it('Buechersendung erscheint nur mit Flag', () => {
    const withBuch = [opt('dp:buchersendung/mailbox', 0, 1), opt('dhl_de:dhl_paket', 0, 31.5)];
    const off = resolveCuratedOptions(withBuch, { country: 'DE', weightKg: 0.3 });
    expect(off.products.find((p) => p.key === 'buchersendung')).toBeUndefined();
    const on = resolveCuratedOptions(withBuch, { country: 'DE', weightKg: 0.3, flags: { allowBuchersendung: true } });
    expect(on.products.find((p) => p.key === 'buchersendung')).toBeTruthy();
  });
});

describe('resolveCuratedOptions – international', () => {
  const live = [
    opt('dhl_de:warenpostinternational', 0, 1),
    opt('dpd:classic', 0, 5),
    opt('dhl_de:weltpaket', 0, 31.5),
    opt('dhl_de:warenpostinternational/premium', 0, 1), // muss raus
  ];

  it('FR (Zone1, DPD-Land): Warenpost Int + DPD Classic Europa + DHL Paket Int, keine Warnung', () => {
    const r = resolveCuratedOptions(live, { country: 'FR', weightKg: 0.8 });
    expect(r.warn).toBe(false);
    expect(r.products.map((p) => p.key)).toEqual(['warenpost_int', 'dpd_classic_europa', 'dhl_paket_int']);
  });

  it('IT (Zone2, NICHT DPD-Land): kein DPD Classic Europa', () => {
    const r = resolveCuratedOptions(live, { country: 'IT', weightKg: 5 });
    expect(r.products.find((p) => p.key === 'dpd_classic_europa')).toBeUndefined();
    expect(r.products.map((p) => p.key)).toEqual(['dhl_paket_int']);
  });

  it('GR (Nicht-Zone): International erlaubt, aber warn=true', () => {
    const r = resolveCuratedOptions(live, { country: 'GR', weightKg: 5 });
    expect(r.warn).toBe(true);
    expect(r.products.find((p) => p.key === 'dhl_paket_int')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run __tests__/shipping-catalog-resolver.test.js`
Expected: FAIL — `Cannot find module '../lib/shipping-catalog-resolver'`.

- [ ] **Step 3: Write the catalog config**

Create `backend/config/shipping-catalog.js`:

```js
'use strict';

// Zonen — TrendOcean-Business-Regeln (NICHT SendClouds Länderlisten).
const ZONE_1 = ['BE', 'DK', 'FR', 'LU', 'MC', 'NL', 'AT', 'PL', 'CZ'];
const ZONE_2 = ['AD', 'IT', 'SM', 'SE', 'SK', 'SI', 'ES', 'HU', 'VA'];
const DPD_EUROPA = ['BE', 'LU', 'NL', 'AT', 'DK', 'CZ', 'FR'];

// Zusatzleistungen, die NIE genutzt werden — jeder Code, der matcht, fliegt raus.
const FORBIDDEN = /gogreen|eco[_-]?delivery|premium|service[_-]?point|locker|filial|alterssicht|age[_-]?check|agecheck|transportvers|insur|express|sperrgut|extra_fee|signature/i;

// Kuratierte Produkte (Plakat-Nomenklatur). `match(code)` prüft den v3-Basis-Produktcode.
// tracking = nur Anzeige-Indikator (Sendungsnummer existiert immer).
// Ein Produkt kann über mehrere Gewichts-Tiers matchen (z. B. DPD Classic 0-5/5-10/…);
// der Resolver wählt die gewichts-passende, plainste Variante.
const PRODUCTS = [
  // ── DEUTSCHLAND (scope: national) ──
  { key: 'grossbrief',   displayName: 'Großbrief',    carrier: 'dp',     scope: 'national', maxWeightKg: 0.5,  tracking: false, rank: 1,
    match: (c) => /^dp:grossbrief(\b|\/|,|$)/i.test(c) },
  { key: 'warensendung', displayName: 'Warensendung', carrier: 'dp',     scope: 'national', maxWeightKg: 1,    tracking: false, rank: 2,
    match: (c) => /^dp:warensendung(\b|\/|,|$)/i.test(c) },
  { key: 'buchersendung', displayName: 'Büchersendung', carrier: 'dp',   scope: 'national', maxWeightKg: 1,    tracking: false, rank: 2, requiresFlag: 'allowBuchersendung',
    match: (c) => /^dp:buchersendung(\b|\/|,|$)/i.test(c) },
  { key: 'kleinpaket',   displayName: 'Kleinpaket',   carrier: 'dhl_de', scope: 'national', maxWeightKg: 1,    tracking: true,  rank: 3,
    match: (c) => /^dhl_de:warenpost(\b|\/|,|$)/i.test(c) && !/international/i.test(c) },
  { key: 'dpd_classic',  displayName: 'DPD Classic',  carrier: 'dpd',    scope: 'national', maxWeightKg: 31.5, tracking: true,  rank: 4,
    match: (c) => /^dpd:classic(\b|\/|,|$)/i.test(c) },
  { key: 'dhl_paket',    displayName: 'DHL Paket',    carrier: 'dhl_de', scope: 'national', maxWeightKg: 31.5, tracking: true,  rank: 5,
    match: (c) => /^dhl_de:dhl_paket(\b|\/|,|$)/i.test(c) },

  // ── EU / INTERNATIONAL (scope: international) ──
  { key: 'warenpost_int',      displayName: 'Warenpost International',  carrier: 'dhl_de', scope: 'international', maxWeightKg: 1,    tracking: false, rank: 1,
    match: (c) => /^dhl_de:warenpostinternational(\b|\/|,|$)/i.test(c) },
  { key: 'dpd_classic_europa', displayName: 'DPD Classic Europa',      carrier: 'dpd',    scope: 'international', maxWeightKg: 31.5, tracking: true,  rank: 2, allowedCountries: DPD_EUROPA,
    match: (c) => /^dpd:classic(\b|\/|,|$)/i.test(c) },
  { key: 'dhl_paket_int',      displayName: 'DHL Paket International',  carrier: 'dhl_de', scope: 'international', maxWeightKg: 31.5, tracking: true,  rank: 3,
    match: (c) => /^dhl_de:(europaket|weltpaket|paket_international|dhl_paket_international)(\b|\/|,|$)/i.test(c) },
];

module.exports = { ZONE_1, ZONE_2, DPD_EUROPA, FORBIDDEN, PRODUCTS };
```

- [ ] **Step 4: Write the resolver**

Create `backend/lib/shipping-catalog-resolver.js`:

```js
'use strict';
const { ZONE_1, ZONE_2, FORBIDDEN, PRODUCTS } = require('../config/shipping-catalog');

function classifyDestination(rawCountry) {
  const country = String(rawCountry || 'DE').trim().toUpperCase().slice(0, 2) || 'DE';
  if (country === 'DE') return { country, scope: 'national', warn: false };
  const inZone = ZONE_1.includes(country) || ZONE_2.includes(country);
  return { country, scope: 'international', warn: !inZone };
}

function optionWeightFits(o, weightKg) {
  if (weightKg == null) return true;
  const min = Number(o?.weight?.min?.value ?? 0) || 0;
  const max = Number(o?.weight?.max?.value ?? 0) || Infinity;
  return weightKg >= min && weightKg <= max;
}

function modifierCount(code) {
  const s = String(code || '');
  const afterColon = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
  const after = afterColon.includes('/') ? afterColon.slice(afterColon.indexOf('/') + 1) : '';
  return after ? after.split(/[/,]/).filter(Boolean).length : 0;
}

function resolveCuratedOptions(liveOptions, { country, weightKg, flags = {} } = {}) {
  const dest = classifyDestination(country);
  const options = (Array.isArray(liveOptions) ? liveOptions : []).filter((o) => typeof o?.code === 'string');
  const products = [];
  for (const product of PRODUCTS) {
    if (product.scope !== dest.scope) continue;
    if (product.requiresFlag && !flags[product.requiresFlag]) continue;
    if (product.allowedCountries && !product.allowedCountries.includes(dest.country)) continue;
    if (weightKg != null && product.maxWeightKg != null && weightKg > product.maxWeightKg) continue;

    const candidates = options
      .filter((o) => !FORBIDDEN.test(o.code))
      .filter((o) => product.match(o.code))
      .filter((o) => optionWeightFits(o, weightKg));
    if (!candidates.length) continue;

    candidates.sort((a, b) => modifierCount(a.code) - modifierCount(b.code));
    products.push({
      key: product.key,
      displayName: product.displayName,
      carrier: product.carrier,
      tracking: product.tracking,
      shippingOptionCode: candidates[0].code,
      rank: product.rank,
    });
  }
  products.sort((a, b) => a.rank - b.rank);
  return { scope: dest.scope, country: dest.country, warn: dest.warn, products };
}

module.exports = { classifyDestination, resolveCuratedOptions, optionWeightFits, modifierCount };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npx vitest run __tests__/shipping-catalog-resolver.test.js`
Expected: PASS (all cases green).

- [ ] **Step 6: Commit**

```bash
git add backend/config/shipping-catalog.js backend/lib/shipping-catalog-resolver.js backend/__tests__/shipping-catalog-resolver.test.js
git commit -m "feat(versand): kuratierter Versand-Katalog + Resolver (reine Logik)"
```

---

## Task 2: Read-only Probe-Script (v3-Code-Verifikation)

**Files:**
- Create: `backend/scripts/probe-shipping-options.js`

**Interfaces:**
- Consumes: `services/shipping-engine.js` (`_listV3ShippingOptions`, `_getV3FromAddress`), `lib/sendcloud-auth.js` (`getSendCloudAuthHeader`). Läuft nur mit SendCloud-Creds (Prod/Secret-Manager) — dient der Verifikation der ⚠️-Codes (Großbrief/Warensendung/DHL Paket International).
- Produces: Konsolen-Dump der echten v3-Codes pro Lane. Kein Firestore-Write.

- [ ] **Step 1: Write the script**

Create `backend/scripts/probe-shipping-options.js`:

```js
'use strict';
// Read-only: dumpt echte SendCloud-v3-Optionen für repräsentative Lanes,
// damit der Katalog gegen die Realität geprüft werden kann. KEIN Write.
// Nutzung (mit Creds, z. B. in Cloud Run / mit exportierten Keys):
//   node backend/scripts/probe-shipping-options.js
const engine = require('../services/shipping-engine');
const { getSendCloudAuthHeader } = require('../lib/sendcloud-auth');

const LANES = [
  { label: 'DE Brief 0,3kg',   toCountry: 'DE', toPostal: '10115', weightKg: 0.3 },
  { label: 'DE Paket 2kg',     toCountry: 'DE', toPostal: '10115', weightKg: 2 },
  { label: 'DE Paket 15kg',    toCountry: 'DE', toPostal: '10115', weightKg: 15 },
  { label: 'FR Paket 2kg',     toCountry: 'FR', toPostal: '75001', weightKg: 2 },
  { label: 'IT Paket 5kg',     toCountry: 'IT', toPostal: '00100', weightKg: 5 },
  { label: 'GR Paket 3kg',     toCountry: 'GR', toPostal: '10431', weightKg: 3 },
  { label: 'AT Klein 0,5kg',   toCountry: 'AT', toPostal: '1010',  weightKg: 0.5 },
];

(async () => {
  const auth = await getSendCloudAuthHeader();
  const fromAddress = await engine._getV3FromAddress();
  for (const lane of LANES) {
    try {
      const options = await engine._listV3ShippingOptions({ fromAddress, toCountry: lane.toCountry, toPostal: lane.toPostal, weightKg: lane.weightKg, auth });
      console.log(`\n=== ${lane.label} (${options.length}) ===`);
      for (const o of options) {
        const min = o?.weight?.min?.value, max = o?.weight?.max?.value;
        console.log(`  ${o.code}  [${min ?? '?'}-${max ?? '?'}]`);
      }
    } catch (e) {
      console.log(`\n=== ${lane.label} FEHLER: ${e.message} ===`);
    }
  }
  process.exit(0);
})();
```

- [ ] **Step 2: Ensure required internals are exported**

In `backend/services/shipping-engine.js`, confirm `module.exports` includes `_listV3ShippingOptions` and `_getV3FromAddress`. If missing, add them to the exports object (additiv). Run:
`cd backend && node -e "const e=require('./services/shipping-engine'); console.log(typeof e._listV3ShippingOptions, typeof e._getV3FromAddress);"`
Expected: `function function`.

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/probe-shipping-options.js backend/services/shipping-engine.js
git commit -m "feat(versand): read-only Probe-Script für echte v3-Shipping-Codes"
```

---

## Task 3: Label mit exaktem `shippingOptionCode` (Fuzzy-Resolver umgehen)

**Files:**
- Modify: `backend/services/shipping-engine.js` (`createParcel`, `shipOrder`)
- Test: `backend/__tests__/ship-with-option-code.test.js`

**Interfaces:**
- Consumes: bestehende `_createV3Shipment`, `_normalizeV3Shipment`.
- Produces: `createParcel({ order, shippingMethodId?, shippingOptionCode?, weight, tenantId, labelFormat })` — wenn `shippingOptionCode` gesetzt, wird `_listV3ShippingOptions` + `_matchV3OptionCode` übersprungen und der Code direkt an `_createV3Shipment` gereicht. `shipOrder({ orderId, tenantId, shippingMethodId?, shippingOptionCode?, weight, labelFormat })` reicht `shippingOptionCode` durch und überspringt die Regel-Auswahl, wenn er gesetzt ist.

- [ ] **Step 1: Write the failing test**

Create `backend/__tests__/ship-with-option-code.test.js`. Pattern: require.cache-Patching der SendCloud-Aufrufe (siehe bestehende `shipping-v3-*.test.js` für den Stil). Test prüft, dass bei gesetztem `shippingOptionCode` KEIN `_listV3ShippingOptions` aufgerufen und der exakte Code angekündigt wird:

```js
'use strict';
const path = require('path');
const enginePath = require.resolve('../services/shipping-engine');

describe('createParcel mit shippingOptionCode', () => {
  let engine, announced;
  beforeEach(() => {
    delete require.cache[enginePath];
    announced = null;
    engine = require('../services/shipping-engine');
    // Interne SendCloud-Calls patchen (kein echter Netzwerkverkehr).
    engine.__setTestHooks({
      getSendCloudAuth: async () => 'Basic x',
      getV3FromAddress: async () => ({ country_code: 'DE', postal_code: '10115', address_line_1: 'A', city: 'B' }),
      listV3ShippingOptions: async () => { throw new Error('should NOT list options when code is given'); },
      createV3Shipment: async (args) => { announced = args; return { parcels: [{ id: 1, tracking_number: 'X', documents: [{ type: 'label', link: 'http://l' }] }] }; },
    });
  });

  it('kündigt den exakten Code an, ohne Optionen zu listen', async () => {
    const order = { id: 'o1', customer: { name: 'N', street: 'Str 1', city: 'B', zip: '10115', country: 'DE' } };
    const res = await engine.createParcel({ order, shippingOptionCode: 'dhl_de:dhl_paket', weight: 2, tenantId: 'default' });
    expect(announced.shippingOptionCode).toBe('dhl_de:dhl_paket');
    expect(res.trackingNumber).toBe('X');
  });
});
```

> **Note for implementer:** `__setTestHooks` ist ein additiver Test-Seam. Implementiere ihn in `shipping-engine.js` als optionale Overrides der internen Helfer (`getSendCloudAuth`, `_getV3FromAddress`, `_listV3ShippingOptions`, `_createV3Shipment`) — NUR für Tests, kein Prod-Verhalten geändert. Wenn ein solcher Seam schon existiert (prüfe die Datei), nutze den vorhandenen und passe den Test an.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run __tests__/ship-with-option-code.test.js`
Expected: FAIL (`__setTestHooks` undefined oder Options werden gelistet).

- [ ] **Step 3: Implement `shippingOptionCode` in `createParcel`**

In `backend/services/shipping-engine.js`, in `createParcel({ order, shippingMethodId, weight, requestLabel, tenantId, labelFormat })` die Signatur um `shippingOptionCode` erweitern und den Options-/Matching-Block überspringen, wenn gesetzt. Ersetze den Block ab `const options = await _listV3ShippingOptions(...)` bis zur `if (!shippingOptionCode) throw ...`-Zeile durch:

```js
  let shippingOptionCode = opts.shippingOptionCode || null;
  if (!shippingOptionCode) {
    const options = await _listV3ShippingOptions({ fromAddress, toCountry: countryRaw, toPostal: zipStr, weightKg, auth });
    const isDomestic = String(fromAddress?.country_code || 'DE').toUpperCase() === String(countryRaw || 'DE').toUpperCase();
    shippingOptionCode = _matchV3OptionCode(options, methodMeta, weightKg, { domestic: isDomestic });
    if (!shippingOptionCode) {
      const fit = options
        .filter((o) => {
          if (_needsServicePoint(o?.code)) return false;
          const min = Number(o?.weight?.min?.value ?? 0) || 0;
          const max = Number(o?.weight?.max?.value ?? 0) || Infinity;
          return weightKg >= min && weightKg <= max;
        })
        .sort((a, b) => (Number(a?.quotes?.[0]?.price?.total?.value ?? Infinity)) - (Number(b?.quotes?.[0]?.price?.total?.value ?? Infinity)));
      shippingOptionCode = fit[0]?.code || options.find((o) => !_needsServicePoint(o?.code))?.code || null;
      if (shippingOptionCode) console.warn(`[createParcel] v3: kein exakter Methoden-Match für ${shippingMethodId} — Fallback "${shippingOptionCode}"`);
    }
    if (!shippingOptionCode) {
      throw new Error(`SendCloud v3: keine passende Versandoption für ${countryRaw}/${weightKg}kg gefunden (Methode ${shippingMethodId || 'default'}, ${options.length} Optionen).`);
    }
  } else {
    console.log(`[createParcel] v3: exakter shippingOptionCode übergeben — Resolver übersprungen: "${shippingOptionCode}"`);
  }
```

Change the function signature to take a single `opts` object (or add `shippingOptionCode` to the destructure). Keep `methodMeta`/`_getCachedMethodMeta` only inside the `if (!shippingOptionCode)` branch (skip the cache lookup when a code is passed).

- [ ] **Step 4: Thread `shippingOptionCode` through `shipOrder`**

In `shipOrder`, add `shippingOptionCode` to the destructured opts. If `shippingOptionCode` is set, skip the `matchCarrierRule` block entirely (do not require `shippingMethodId`). Pass `shippingOptionCode` into the `createParcel({ ... })` call. Weight-Guard (`if (!orderWeight) throw`) bleibt.

- [ ] **Step 5: Add the test seam (`__setTestHooks`) if not present**

Add near the top of `shipping-engine.js` (module scope), only if no equivalent exists:

```js
// Test-Seam (additiv, nur für Tests): erlaubt Overrides interner SendCloud-Helfer.
let _testHooks = {};
function __setTestHooks(h) { _testHooks = h || {}; }
```

Then make `getSendCloudAuth`, `_getV3FromAddress`, `_listV3ShippingOptions`, `_createV3Shipment` consult `_testHooks.<name>` first when set. Export `__setTestHooks` and `createParcel` (if not already exported). **If a mocking pattern already exists in the repo (check `__tests__/shipping-v3-option-match.test.js`), follow that instead and rewrite the Task-3 test to match — do not introduce a second pattern.**

- [ ] **Step 6: Run test to verify it passes**

Run: `cd backend && npx vitest run __tests__/ship-with-option-code.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full v3 regression to prove no break**

Run: `cd backend && npx vitest run __tests__/shipping-v3-option-match.test.js __tests__/shipping-v3-carrier-family.test.js __tests__/shipping-v3-premium-and-name-match.test.js`
Expected: PASS (Alt-Pfad unverändert).

- [ ] **Step 8: Commit**

```bash
git add backend/services/shipping-engine.js backend/__tests__/ship-with-option-code.test.js
git commit -m "feat(versand): createParcel/shipOrder akzeptieren exakten shippingOptionCode"
```

---

## Task 4: Endpoint `GET /orders/:id/shipping-options` + `listCuratedShippingOptions`

**Files:**
- Modify: `backend/services/shipping-engine.js` (neue `listCuratedShippingOptions`)
- Modify: `backend/routes/orders.js` (neuer GET-Endpoint; `ship`-Handler liest `shippingOptionCode`)
- Test: `backend/__tests__/shipping-options-endpoint.test.js`

**Interfaces:**
- Produces: `listCuratedShippingOptions({ order, weightKg }) => { scope, country, warn, products }` (nutzt `_listV3ShippingOptions` + `resolveCuratedOptions`, `flags.allowBuchersendung` aus `ALLOW_BUCHERSENDUNG`).
- Endpoint-Response `GET /orders/:id/shipping-options`:
  - Flag aus: `{ ok:true, data:{ enabled:false } }`
  - ohne `?weight`: `{ ok:true, data:{ enabled:true, needsWeight:true, weightEstimate:number|null, hasAddress:boolean } }`
  - mit `?weight=X`: `{ ok:true, data:{ enabled:true, needsWeight:false, weight:X, hasAddress, scope, country, warn, products:[…] } }`
- `POST /orders/:id/ship` Body akzeptiert zusätzlich `shippingOptionCode?:string`.

- [ ] **Step 1: Write the failing test**

Create `backend/__tests__/shipping-options-endpoint.test.js` — testet `listCuratedShippingOptions` gegen den bestehenden Test-Seam (patcht `_listV3ShippingOptions`), NICHT den HTTP-Layer (der braucht Firestore):

```js
'use strict';
const enginePath = require.resolve('../services/shipping-engine');

describe('listCuratedShippingOptions', () => {
  let engine;
  beforeEach(() => {
    delete require.cache[enginePath];
    engine = require('../services/shipping-engine');
    engine.__setTestHooks({
      getSendCloudAuth: async () => 'Basic x',
      getV3FromAddress: async () => ({ country_code: 'DE', postal_code: '10115' }),
      listV3ShippingOptions: async ({ toCountry }) => {
        if (toCountry === 'FR') return [
          { code: 'dhl_de:warenpostinternational', weight: { min: { value: 0 }, max: { value: 1 } } },
          { code: 'dpd:classic', weight: { min: { value: 0 }, max: { value: 5 } } },
          { code: 'dhl_de:weltpaket', weight: { min: { value: 0 }, max: { value: 31.5 } } },
        ];
        return [
          { code: 'dhl_de:dhl_paket', weight: { min: { value: 0 }, max: { value: 31.5 } } },
          { code: 'dpd:classic', weight: { min: { value: 0 }, max: { value: 5 } } },
        ];
      },
    });
  });

  it('DE liefert nationale Produkte', async () => {
    const order = { id: 'o', customer: { country: 'DE', zip: '10115', city: 'B', street: 'S 1', name: 'N' } };
    const r = await engine.listCuratedShippingOptions({ order, weightKg: 2 });
    expect(r.scope).toBe('national');
    expect(r.products.map((p) => p.key)).toEqual(['dpd_classic', 'dhl_paket']);
  });

  it('FR liefert internationale Produkte inkl. DPD Europa', async () => {
    const order = { id: 'o', customer: { country: 'FR', zip: '75001', city: 'Paris', street: 'R 1', name: 'N' } };
    const r = await engine.listCuratedShippingOptions({ order, weightKg: 0.8 });
    expect(r.scope).toBe('international');
    expect(r.products.map((p) => p.key)).toContain('dpd_classic_europa');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run __tests__/shipping-options-endpoint.test.js`
Expected: FAIL — `listCuratedShippingOptions is not a function`.

- [ ] **Step 3: Implement `listCuratedShippingOptions`**

In `backend/services/shipping-engine.js` (nutzt die vorhandene Zip-Sanitisierung analog `createParcel`):

```js
async function listCuratedShippingOptions({ order, weightKg }) {
  const { resolveCuratedOptions } = require('../lib/shipping-catalog-resolver');
  const auth = await getSendCloudAuth();
  const fromAddress = await _getV3FromAddress();
  const customer = order.customer || {};
  const country = String(customer.country || customer.countryCode || 'DE').trim().toUpperCase().slice(0, 2);
  const rawZip = customer.zip ?? customer.postal_code ?? customer.postcode ?? customer.plz ?? '';
  let zip = String(rawZip).trim().replace(/\s+/g, '').replace(/[^a-zA-Z0-9-]/g, '');
  if (country === 'DE' && /^\d{1,4}$/.test(zip)) zip = zip.padStart(5, '0');
  else if (country === 'AT' && /^\d{1,3}$/.test(zip)) zip = zip.padStart(4, '0');
  const options = await _listV3ShippingOptions({ fromAddress, toCountry: country, toPostal: zip, weightKg, auth });
  const flags = { allowBuchersendung: String(process.env.ALLOW_BUCHERSENDUNG || 'false') === 'true' };
  return resolveCuratedOptions(options, { country, weightKg, flags });
}
```

Export `listCuratedShippingOptions` in `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run __tests__/shipping-options-endpoint.test.js`
Expected: PASS.

- [ ] **Step 5: Add the HTTP endpoint**

In `backend/routes/orders.js`, direkt nach dem `shipping-preview`-Handler:

```js
/**
 * GET /api/orders/:orderId/shipping-options — kuratierte Versand-Produktliste
 * (Gewicht+Zielland). Hinter Flag PACK_CURATED_SHIPPING. Ohne ?weight liefert
 * es die Gewichts-Schätzung zum Vorbefüllen; mit ?weight die Produktliste.
 */
router.get('/orders/:orderId/shipping-options', requirePermission('orders', 'read'), async (req, res) => {
  try {
    if (String(process.env.PACK_CURATED_SHIPPING || 'false') !== 'true') {
      return res.json({ ok: true, data: { enabled: false } });
    }
    const { orderId } = req.params;
    const orderSnap = await firestore.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Auftrag nicht gefunden.' } });
    }
    const order = { id: orderSnap.id, ...orderSnap.data() };
    const { calculateOrderWeight, listCuratedShippingOptions } = require('../services/shipping-engine');
    const customer = order.customer || {};
    const hasAddress = Boolean(String(customer.street || '').trim() && String(customer.city || '').trim() && String(customer.zip || '').trim());
    const wParam = req.query.weight != null ? Number(req.query.weight) : null;

    if (!(wParam > 0)) {
      const est = (parseFloat(order.weight || '0') || 0) || calculateOrderWeight(order) || null;
      return res.json({ ok: true, data: { enabled: true, needsWeight: true, weightEstimate: est, hasAddress } });
    }
    const result = await listCuratedShippingOptions({ order, weightKg: wParam });
    return res.json({ ok: true, data: { enabled: true, needsWeight: false, weight: wParam, hasAddress, ...result } });
  } catch (err) {
    console.error(`[GET /api/orders/:orderId/shipping-options] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});
```

- [ ] **Step 6: Let `ship` accept `shippingOptionCode`**

In `backend/routes/orders.js`, im `POST /orders/:orderId/ship`-Handler die Zeile
`const { shippingMethodId, weight, labelFormat } = req.body;`
ersetzen durch
`const { shippingMethodId, shippingOptionCode, weight, labelFormat } = req.body;`
und den `shipOrder(...)`-Call um `shippingOptionCode` erweitern:
`const result = await shipOrder({ orderId, tenantId, shippingMethodId, shippingOptionCode, weight, labelFormat: resolvedFormat });`

- [ ] **Step 7: Build check**

Run: `cd backend && npm run build` (bzw. `node -e "require('./routes/orders.js')"` wenn kein build-Schritt) — kein Syntaxfehler.

- [ ] **Step 8: Commit**

```bash
git add backend/services/shipping-engine.js backend/routes/orders.js backend/__tests__/shipping-options-endpoint.test.js
git commit -m "feat(versand): shipping-options-Endpoint + listCuratedShippingOptions + ship akzeptiert Code"
```

---

## Task 5: Frontend API-Client

**Files:**
- Modify: `api/client.ts`

**Interfaces:**
- Produces:
  - `interface CuratedShippingProduct { key:string; displayName:string; carrier:string; tracking:boolean; shippingOptionCode:string; rank:number }`
  - `interface ShippingOptionsResponse { enabled:boolean; needsWeight?:boolean; weight?:number; weightEstimate?:number|null; hasAddress?:boolean; scope?:string; country?:string; warn?:boolean; products?:CuratedShippingProduct[] }`
  - `fetchShippingOptions(orderId:string, weight?:number) => Promise<ShippingOptionsResponse>`
  - `shipOrder` opts erweitert um `shippingOptionCode?:string`.

- [ ] **Step 1: Add types + fetch function**

In `api/client.ts` bei den anderen Shipping-Funktionen:

```ts
export interface CuratedShippingProduct {
  key: string;
  displayName: string;
  carrier: string;
  tracking: boolean;
  shippingOptionCode: string;
  rank: number;
}

export interface ShippingOptionsResponse {
  enabled: boolean;
  needsWeight?: boolean;
  weight?: number;
  weightEstimate?: number | null;
  hasAddress?: boolean;
  scope?: "national" | "international";
  country?: string;
  warn?: boolean;
  products?: CuratedShippingProduct[];
}

export async function fetchShippingOptions(orderId: string, weight?: number): Promise<ShippingOptionsResponse> {
  const url = new URL(`${BACKEND_URL}/api/orders/${encodeURIComponent(orderId)}/shipping-options`);
  if (weight != null) url.searchParams.set("weight", String(weight));
  const res = await fetchApi(url.toString());
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || "Versandoptionen konnten nicht geladen werden");
  return data?.data as ShippingOptionsResponse;
}
```

- [ ] **Step 2: Extend `shipOrder` opts**

Ändere die `shipOrder`-Signatur:
`export async function shipOrder(orderId: string, opts?: { shippingMethodId?: number; shippingOptionCode?: string; weight?: number; labelFormat?: string }): Promise<any>`
(Body bleibt `JSON.stringify(opts || {})` — trägt den neuen Key automatisch.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit` (Repo-Root). Expected: keine neuen Fehler.

- [ ] **Step 4: Commit**

```bash
git add api/client.ts
git commit -m "feat(versand): FE-Client fetchShippingOptions + shipOrder mit shippingOptionCode"
```

---

## Task 6: Frontend Pack-Flow (immer Gewicht → kuratierte Liste)

**Files:**
- Modify: `components/orders/ShippingDecisionDialog.tsx` (neuer `ShippingOptionModal`)
- Modify: `components/OrderDetail.tsx` (Desktop-Flow)
- Modify: `components/MobileOperationsView.tsx` (Mobile-Flow)

**Interfaces:**
- Consumes: `fetchShippingOptions`, `updateOrderWeight`, `shipOrder`/`packAndShip` (mit `shippingOptionCode`), `CuratedShippingProduct`.
- Produces: `ShippingOptionModal` (exportiert aus `ShippingDecisionDialog.tsx`) mit Props `{ weightKg:number; products:CuratedShippingProduct[]; warn?:boolean; country?:string; contextLabel?:string|null; busy?:boolean; errorMessage?:string|null; onConfirm:(p:CuratedShippingProduct)=>void; onCancel:()=>void }`.

- [ ] **Step 1: Add `ShippingOptionModal`**

In `components/orders/ShippingDecisionDialog.tsx` einen neuen exportierten Modal ergänzen (nutzt `ModalShell` + `carrierBadgeClass`, beide bereits in der Datei). Kern:

```tsx
import type { CuratedShippingProduct } from "../../api/client";

interface ShippingOptionModalProps {
  weightKg: number;
  products: CuratedShippingProduct[];
  warn?: boolean;
  country?: string;
  contextLabel?: string | null;
  busy?: boolean;
  errorMessage?: string | null;
  onConfirm: (product: CuratedShippingProduct) => void;
  onCancel: () => void;
}

export const ShippingOptionModal: React.FC<ShippingOptionModalProps> = ({
  weightKg, products, warn, country, contextLabel, busy = false, errorMessage, onConfirm, onCancel,
}) => {
  const [selectedKey, setSelectedKey] = useState<string | null>(products[0]?.key ?? null);
  const selected = products.find((p) => p.key === selectedKey) || null;
  return (
    <ModalShell
      title="Versand wählen"
      subtitle={`${contextLabel ? contextLabel + " — " : ""}${weightKg.toLocaleString("de-DE", { maximumFractionDigits: 3 })} kg${country ? " · " + country : ""}`}
      onClose={onCancel}
      busy={busy}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy}
            className="rounded-lg bg-app-elevated text-txt-secondary px-4 py-2.5 text-sm font-semibold hover:text-txt-primary transition disabled:opacity-50">Abbrechen</button>
          <button type="button" onClick={() => selected && onConfirm(selected)} disabled={busy || !selected}
            className="inline-flex items-center gap-2 rounded-lg bg-accent text-white px-4 py-2.5 text-sm font-semibold hover:bg-accent/90 transition disabled:opacity-50">
            {busy && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            Label erstellen
          </button>
        </div>
      }
    >
      {warn ? (
        <div className="mb-3 bg-warning-dim border border-warning/30 rounded-lg px-3 py-2 text-xs text-warning">
          Außerhalb der Standard-Zonen — bitte Teamlead fragen, bevor du versendest.
        </div>
      ) : null}
      <div className="space-y-2">
        {products.length === 0 ? (
          <p className="text-sm text-txt-muted">Keine passende Versandoption für dieses Gewicht/Zielland.</p>
        ) : products.map((p) => {
          const active = p.key === selectedKey;
          return (
            <button key={p.key} type="button" onClick={() => setSelectedKey(p.key)} disabled={busy}
              className={`w-full text-left rounded-xl border px-4 py-3 transition flex items-center gap-3 ${active ? "border-accent bg-accent-dim ring-1 ring-accent/40" : "border-app-border bg-app-bg/40 hover:border-txt-muted"} disabled:opacity-50`}>
              <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full border ${active ? "border-accent bg-accent" : "border-app-border bg-app-elevated"}`}>
                {active && <span className="w-2 h-2 rounded-full bg-white" />}
              </span>
              <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-txt-primary truncate">{p.displayName}</span>
                <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider border ${carrierBadgeClass(p.carrier)}`}>{p.carrier}</span>
                <span className={`text-[10px] font-semibold ${p.tracking ? "text-success" : "text-txt-muted"}`}>{p.tracking ? "✓ Tracking" : "✗ kein Tracking"}</span>
              </div>
            </button>
          );
        })}
      </div>
      {errorMessage ? (
        <div className="mt-3 bg-danger-dim border border-danger/20 rounded-lg px-3 py-2 text-xs text-danger">{errorMessage}</div>
      ) : null}
    </ShellFooterlessBody>
  );
};
```

> **Implementer note:** Der Platzhalter `</ShellFooterlessBody>` ist ein Fehler — schließe stattdessen mit `</ModalShell>` (Copy-Paste-Kontrolle). Verifiziere `warning-dim`/`text-warning`-Tokens in `styles/main.css`; falls anders benannt, das vorhandene Warn-Token nutzen.

- [ ] **Step 2: Desktop – `OrderDetail.tsx` neuen Flow einbauen**

`startShippingDecision` so erweitern: zuerst `fetchShippingOptions(orderId)`. Wenn `resp.enabled === false` → **bestehenden** Alt-Flow (`fetchShippingPreview`) unverändert nutzen (Fallback). Wenn `enabled`:
1. Immer `WeightPromptModal` zeigen, vorbefüllt mit `resp.weightEstimate`.
2. Nach Bestätigung: `updateOrderWeight(orderId, kg)` → `fetchShippingOptions(orderId, kg)` → `ShippingOptionModal` mit `resp.products`/`warn`.
3. Auswahl → `executeShip` mit `{ weight: kg, shippingOptionCode: product.shippingOptionCode }` statt `shippingMethodId`.

`executeShip` erweitern, sodass es `shippingOptionCode` an `shipOrder(orderId, { weight, shippingOptionCode, labelFormat })` durchreicht (bestehende `shippingMethodId`-Variante bleibt für den Fallback).

State: neue `ShipDecisionStep`-Variante `"options"` + State `curatedProducts`, `curatedWarn`. Render `ShippingOptionModal` bei `step === "options"`.

- [ ] **Step 3: Mobile – `MobileOperationsView.tsx` neuen Flow einbauen**

Analog in `driveShipping`/`submitPack`: `fetchShippingOptions` feature-detektieren; bei `enabled` immer Gewicht abfragen (vorbefüllt), dann `ShippingOptionModal`, dann `packAndShip(orderId, { weight, shippingOptionCode, labelFormat })`. `packAndShip`-Aufruf um `shippingOptionCode` erweitern (Client-Opts akzeptieren ihn bereits über `shipOrder`). Bei `enabled === false` bleibt der bestehende Flow.

- [ ] **Step 4: `packAndShip` (client) `shippingOptionCode` durchreichen**

In `api/client.ts` die `packAndShip`-Signatur um `shippingOptionCode?: string` erweitern und in den internen `shipOrder`-Call übernehmen (eine Zeile).

- [ ] **Step 5: Typecheck + Build**

Run: `npx tsc --noEmit` und `npm run build` (Repo-Root). Expected: grün.

- [ ] **Step 6: Commit**

```bash
git add components/orders/ShippingDecisionDialog.tsx components/OrderDetail.tsx components/MobileOperationsView.tsx api/client.ts
git commit -m "feat(versand): Pack-Flow immer Gewicht + kuratierte Optionsliste (hinter Flag)"
```

---

## Task 7: Voller Testlauf + Flag-Dokumentation

**Files:**
- Modify: `CLAUDE.md` (Feature-Flag-Sektion — nur additive Doku)

- [ ] **Step 1: Full backend suite**

Run: `cd backend && npm test`
Expected: grün (inkl. neue Tests; keine Regression). Falls `shipping-rule-matching.test.js` noch existiert, bleibt es grün (Regeln in Phase 1 unangetastet).

- [ ] **Step 2: Frontend build**

Run: `npm run build` (Repo-Root). Expected: grün.

- [ ] **Step 3: Flags dokumentieren**

In `CLAUDE.md` unter Feature-Flags additiv ergänzen:
- `PACK_CURATED_SHIPPING=false` (default) — aktiviert den kuratierten Pack-Flow (Gewicht-immer + kurze Produktliste + exakter v3-Code). Aus = bisheriger Regel-Flow (Fallback).
- `ALLOW_BUCHERSENDUNG=false` (default) — erlaubt `dp:buchersendung` als Produkt „Büchersendung". Nur einschalten, wenn DP-Vertrag Büchersendung für den Warenkorb erlaubt (rechtlich: nur Bücher/Medien).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(versand): Feature-Flags PACK_CURATED_SHIPPING + ALLOW_BUCHERSENDUNG"
```

---

## Manuelle Abnahme (vor Prod-Flip, Owner)

1. Branch deployen (behind Flag off = kein Verhaltenswechsel).
2. Optional: `probe-shipping-options.js` in Prod/mit Creds laufen lassen → echte v3-Codes gegen den Katalog prüfen (v. a. Großbrief/Warensendung/DHL-Paket-Int). Katalog-Matcher ggf. nachziehen.
3. `PACK_CURATED_SHIPPING=true` auf Web **und** Worker setzen. Testbestellung DE (leicht/schwer), FR, IT, GR verpacken: Gewicht wird immer gefragt; Liste kurz + korrekt; Nicht-DE zeigt keine nationalen Produkte; GR zeigt Warnung; Label druckt; Marktplatz erhält Sendungsnummer.
4. Bei Fehlern: Flag zurück auf `false` (sofortiger Fallback), fix-forward.

## Phase 2 (separater Plan, NACH Abnahme)

Nicht Teil dieses Plans — erst nach erfolgreicher Flag-Nutzung: Versandregeln-Code entfernen (`matchCarrierRule`, `matchAllCarrierRules`, `DEFAULT_CARRIER_RULES`, `shipping-rule-matching.test.js`), `OrderSettingsView`-Regel-Sektion entfernen, Sammel-Versand auf Katalog umstellen, Alt-Flow (`shipping-preview`/`CarrierPickModal`) entfernen, Flag ausbauen.

---

## Self-Review (durchgeführt)

- **Spec-Abdeckung:** Gewicht-immer (T6), kuratierte Liste/Nomenklatur (T1), Gewicht+Land-Filter (T1/T4), Nicht-DE→nur intl (T1), exakter v3-Code (T3), Fremdland-Warnung statt Block (T1/T6), Ohne-Tracking (kein Sonderfall — dokumentiert), Zonen/DPD-7 (T1), Flag/Rollout (T4/T7), Versandregeln-Entfernung → bewusst Phase 2. ✓
- **Platzhalter:** Zwei bewusst markierte Implementer-Notes (Test-Seam-Pattern prüfen; `</ModalShell>` statt Platzhalter) — keine offenen TBDs. ⚠️-Codes sind über die selbst-korrigierende Resolver-Logik + Probe abgedeckt, kein Blocker.
- **Typ-Konsistenz:** `shippingOptionCode` (Backend createParcel/shipOrder/ship-Body ↔ FE shipOrder/packAndShip), `CuratedShippingProduct`/`ShippingOptionsResponse` (Client ↔ Modal ↔ Views), `listCuratedShippingOptions`/`resolveCuratedOptions`-Rückgaben konsistent. ✓
