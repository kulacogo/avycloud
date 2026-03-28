# eBay Listing Excellence — Masterplan für Claude Code

> **Quelle:** Strategischer eBay Leitfaden.md + vollständige Codebase-Analyse (März 2026)
> **Ziel:** AvyCloud transformiert von "gute Listings generieren" zu "Cassini-dominante Listings automatisch publizieren"
> **Scope:** Backend (Node.js/Express/CommonJS), Frontend (React/TS), Gemini 3 Pro

---

## Gesamtübersicht: 7 Epics, 28 Features, 4 Phasen

| Phase | Zeitraum | Epics | Kernziel |
|-------|----------|-------|----------|
| **Phase 1** | Sofort | LISTING-001 bis LISTING-005 | Gemini entfesseln — bessere Listings ohne neue Infrastruktur |
| **Phase 2** | Danach | MARKET-001 bis MARKET-004 | Competitive Intelligence — Marktdaten als Gemini-Input |
| **Phase 3** | Danach | AUTO-001 bis AUTO-005 | Automation — 30-Tage-Relisting, Sell-Through, Ladenhüter |
| **Phase 4** | Danach | PERF-002 bis PERF-004 | Performance Loops — Cassini-Feedback → Listing-Optimierung |

---

## ⚠️ Goldene Regeln (aus CLAUDE.md — NICHT VERHANDELBAR)

1. Keine bestehende Route ändern ohne explizite Anweisung
2. Keine Firestore-Felder umbenennen/löschen (additive only)
3. Keine Dependencies entfernen
4. Alle Produkt-Schreibpfade über `saveProductV2()` (lib/product-store.js)
5. Alle neuen Queries/Collections mit `tenantId`
6. BaseLinker ist TABU
7. Production darf NIEMALS negativ beeinflusst werden

---

# PHASE 1: Gemini entfesseln

> Die größten Gewinne mit dem geringsten Risiko. Keine neuen Services,
> keine neuen Collections — nur bessere Prompts, erweiterte Policies,
> und ein Multi-Step statt One-Shot Listing-Flow.

---

## LISTING-001: Multi-Step Listing Pipeline (One-Shot → Multi-Agent)

| Field | Value |
|-------|-------|
| **Feature ID** | LISTING-001 |
| **Priority** | P0 |
| **Status** | Ready |
| **Change Level** | L1 (Service-Refactor, keine Schema-Änderung) |
| **Effort** | L |
| **Dependencies** | Keine |
| **Protected Zones** | services/listing-pipeline.js (Yellow Zone) |

### Problem Statement

Der aktuelle Listing-Flow in `services/listing-pipeline.js` ist ein **Single Gemini Call**:
Produktdaten → Prompt → `{ ebay: {title, description}, kaufland: {title, description} }`.

Der Leitfaden beschreibt aber einen **5-stufigen Prozess**:
1. Keyword-Recherche (Synonyme, Long-Tail, Kategorie-spezifisch)
2. Titel-Architektur (80 Zeichen, Mobile-First, Kategorie-Template)
3. Content-Transformation (200 Wörter, 5-7% Keyword-Dichte, Benefits > Features)
4. Mobile-Optimierung (800-Zeichen itemprop Snippet)
5. Compliance-Validierung (keine verbotenen Praktiken)

Ein einzelner Gemini-Call kann all das nicht leisten. Die Qualität leidet.

### User Story

Als AvyCloud-Nutzer will ich, dass die Listing-Pipeline automatisch marktoptimierte eBay-Listings generiert, die Cassini-Ranking-Faktoren bedienen, damit ich ohne manuelle Nacharbeit auf Seite 1 ranke.

### Architektur

**Refactor `services/listing-pipeline.js`** in 5 sequenzielle Steps:

```
Step 1: keywordResearch(product, categoryId)
  → Gemini Call mit Scope: "listing.keywords" (NEU)
  → Input: Produkt-Daten + Kategorie + eBay Browse API Competitor-Titel
  → Output: { primaryKeywords: string[], synonyms: string[], longTail: string[], categoryTerms: string[] }
  → Gemini darf Weltwissen nutzen (KEIN Evidence-First für Synonyme!)

Step 2: titleArchitect(product, keywords, categoryTemplate)
  → Gemini Call mit Scope: "listing.title" (NEU)
  → Input: Keywords + Kategorie-Template (aus erweiterten 9+ Templates)
  → Output: { ebayTitle: string, kauflandTitle: string, mobileFirstSegment: string }
  → Title-Policy greift NACH Gemini (Coercion wie bisher)

Step 3: contentTransform(product, keywords, existingDescription)
  → Gemini Call mit Scope: "listing.content" (NEU)
  → Input: Produktdaten + Keywords + Beschreibungs-KPIs
  → Output: {
      ebayDescription: string (HTML, ~200 Wörter, 5-7% Keyword-Dichte),
      kauflandDescription: string (plain text),
      mobileSnippet: string (max 800 Zeichen, Schema.org-ready)
    }
  → Gemini darf verkaufspsychologisch formulieren (Benefits > Features)
  → Evidence-First nur für FAKTEN (Maße, Material, Specs)

Step 4: complianceCheck(listing)
  → Deterministische Prüfung (KEIN Gemini-Call)
  → Prüft: Active Content, Keyword-Stuffing, Duplicate Listings, fehlende GTINs
  → Output: { compliant: boolean, issues: Issue[] }

Step 5: assemble(steps1to4)
  → Zusammenbau des finalen Listing-Objekts
  → Fallbacks wenn einzelne Steps feilen
  → Output: Bisheriges Format (abwärtskompatibel)
```

### Technische Implementation

#### Schritt 1: Neue LLM-Scopes registrieren

**Datei:** `lib/llm-config.js`

Erweitere `DEFAULT_SCOPES` um 3 neue Scopes:

```javascript
{
  scopeId: 'listing.keywords',
  name: 'Listing Keyword Research',
  purpose: 'Recherchiere Synonyme, Long-Tail-Keywords und kategorie-spezifische Suchbegriffe',
  defaultModelEnvKey: 'GEMINI_LISTING_MODEL',
},
{
  scopeId: 'listing.title',
  name: 'Listing Title Architect',
  purpose: 'Baue eBay-optimierte Titel nach Kategorie-Template mit Mobile-First-Priorisierung',
  defaultModelEnvKey: 'GEMINI_LISTING_MODEL',
},
{
  scopeId: 'listing.content',
  name: 'Listing Content Transform',
  purpose: 'Transformiere Produktdaten in verkaufspsychologisch optimierte Beschreibungen',
  defaultModelEnvKey: 'GEMINI_LISTING_MODEL',
}
```

#### Schritt 2: Refactor `services/listing-pipeline.js`

Behalte die bestehende Funktion `generateChannelListings()` als public API.
Intern ersetze den Single-Call durch die 5-Step-Pipeline:

```javascript
async function generateChannelListings(productId, opts = {}) {
  const product = await getProductV2(productId);
  const tenantId = product.tenantId;

  // Step 1: Keyword Research (Gemini darf Weltwissen nutzen)
  const keywords = await stepKeywordResearch(product);

  // Step 2: Title Architecture (Gemini + Title-Policy Coercion)
  const titles = await stepTitleArchitect(product, keywords);

  // Step 3: Content Transformation (Gemini kreativ, Fakten evidence-based)
  const content = await stepContentTransform(product, keywords);

  // Step 4: Compliance Check (deterministisch, kein Gemini)
  const compliance = stepComplianceCheck({ ...titles, ...content });

  // Step 5: Assemble (abwärtskompatibles Format)
  return stepAssemble(product, titles, content, compliance);
}
```

#### Schritt 3: Keyword Research Prompt

```
Du bist ein eBay SEO-Spezialist für den DACH-Markt.

PRODUKT:
${JSON.stringify(productContext)}

KATEGORIE: ${categoryBreadcrumb}

WETTBEWERBER-TITEL (aus eBay Browse API):
${competitorTitles.join('\n')}

AUFGABE:
1. Identifiziere 2-3 primäre Keywords (höchstes Suchvolumen)
2. Finde 3-5 Synonyme und Variationen (z.B. "Schreibtisch" → "Arbeitstisch", "Bürotisch")
3. Generiere 3-5 Long-Tail-Phrasen (z.B. "höhenverstellbar elektrisch")
4. Extrahiere kategorie-spezifische Begriffe (z.B. bei Fashion: "Oversized", "Y2K", Material)

DU DARFST dein Weltwissen über eBay-Suchverhalten nutzen.
DU DARFST NICHT Produktfakten erfinden.

Antworte als JSON.
```

#### Schritt 4: Content Transform Prompt

```
Du bist ein Senior Marketplace Content-Optimierer für eBay.de.

PRODUKT:
${JSON.stringify(productContext)}

KEYWORDS (aus Recherche):
Primär: ${keywords.primary.join(', ')}
Synonyme: ${keywords.synonyms.join(', ')}
Long-Tail: ${keywords.longTail.join(', ')}

REGELN:
1. eBay-Beschreibung: ~200 Wörter, HTML (<p>, <ul>, <li>, <strong>)
2. Keyword-Dichte: 5-7% (= 10-14 Nennungen der wichtigsten Phrasen)
3. Struktur: Kurze Absätze, Bullet Points für KUNDENNUTZEN (Benefits > Features)
4. Sprache: Professionell, verkaufspsychologisch, DACH-Markt
5. KEINE erfundenen Spezifikationen — nur aus Produktdaten ableiten
6. Mobile Snippet: Erstelle zusätzlich eine Kurzversion (max 800 Zeichen) für Schema.org itemprop="description"

BEISPIEL für Benefits > Features:
SCHLECHT: "512GB SSD Speicher"
GUT: "512GB SSD — genug Platz für Ihre gesamte Mediathek und schnelle Ladezeiten"

Antworte als JSON: { ebayDescription, kauflandDescription, mobileSnippet }
```

### Testing

```
cd backend && npm test -- --grep "listing-pipeline"
```

Neue Tests:
- `test/listing-pipeline-multi-step.test.js`
  - Test: Keywords-Step gibt valide Struktur zurück
  - Test: Title-Step respektiert 80-Zeichen-Limit nach Coercion
  - Test: Content-Step erreicht ~200 Wörter und enthält Keywords
  - Test: Compliance-Step erkennt Keyword-Stuffing
  - Test: Gesamtpipeline ist abwärtskompatibel zum bisherigen Output-Format
  - Test: Fallback wenn ein Step fehlschlägt (graceful degradation)

### Risiken & Mitigationen

| Risiko | Mitigation |
|--------|-----------|
| Langsamere Pipeline (5 Calls statt 1) | Gemini 3 Flash für Steps 1+2 (schnell), Pro für Step 3 (Qualität) |
| Abwärtskompatibilität | Output-Format bleibt identisch, nur interne Logik ändert sich |
| Step-Fehler kaskadieren | Jeder Step hat try/catch + Fallback auf bisheriges Verhalten |

---

## LISTING-002: Evidence-First Differenzierung (Drei-Zonen-Modell)

| Field | Value |
|-------|-------|
| **Feature ID** | LISTING-002 |
| **Priority** | P0 |
| **Status** | Ready |
| **Change Level** | L1 (Policy-Refactor) |
| **Effort** | M |
| **Dependencies** | Keine (kann parallel zu LISTING-001) |
| **Protected Zones** | lib/llm-policy-pack.js |

### Problem Statement

Die aktuelle `llm-policy-pack.js` erzwingt Evidence-First für ALLE LLM-Outputs.
Das ist korrekt für Fakten (Maße, Material, GTIN), aber kontraproduktiv für:
- Synonym-Recherche (Gemini weiß, dass "Arbeitstisch" = "Schreibtisch")
- Verkaufspsychologische Formulierungen
- Kategorie-spezifische Suchbegriffe
- Long-Tail-Keyword-Expansion

### Architektur: Drei-Zonen-Modell

**Datei:** `lib/llm-policy-pack.js` — Erweitere `buildCommonPolicyText()`

```javascript
function buildCommonPolicyText(opts = {}) {
  const zone = opts.policyZone || 'strict'; // 'strict' | 'creative' | 'hybrid'

  const ZONE_STRICT = `
    FAKTEN-POLICY (NICHT VERHANDELBAR):
    - Maße, Gewicht, Material: NUR aus bereitgestellten Produktdaten
    - GTIN/EAN/MPN: NUR wenn checkdigit-validiert
    - Preis: NUR aus expliziten Quellen
    - Marke/Modell: NUR wenn in Produktdaten vorhanden
    - Erfinde NIEMALS technische Spezifikationen
  `;

  const ZONE_CREATIVE = `
    KREATIV-POLICY:
    - Du DARFST Synonyme und semantische Variationen aus deinem Weltwissen nutzen
    - Du DARFST verkaufspsychologische Formulierungen verwenden (Benefits > Features)
    - Du DARFST kategorie-spezifische Suchbegriffe vorschlagen
    - Du DARFST Long-Tail-Keywords generieren die zum Produkt passen
    - Du DARFST NICHT Produktfakten erfinden oder Specs halluzinieren
  `;

  if (zone === 'strict') return ZONE_STRICT + buildTitleSchemaGuideText() + ...;
  if (zone === 'creative') return ZONE_CREATIVE + ZONE_STRICT; // Kreativ + Fakten-Guardrail
  if (zone === 'hybrid') return ZONE_STRICT; // Default bisheriges Verhalten

  return ZONE_STRICT; // Fallback = sicher
}
```

**Scope-Zuordnung:**

| LLM Scope | Policy Zone | Begründung |
|-----------|-------------|-----------|
| `identify.v2` | `strict` | Produkterkennung = nur Evidenz |
| `improve.product` | `hybrid` | Verbesserung = Evidenz + leichte Kreativität |
| `chat.product` | `hybrid` | Chat = flexibel aber faktenbasiert |
| `quality.gate` | `strict` | Validierung = nur Regeln |
| `image.generation` | `strict` | Bildgenerierung = exakte Reproduktion |
| `listing.keywords` (NEU) | `creative` | Keywords = Weltwissen erlaubt |
| `listing.title` (NEU) | `hybrid` | Titel = Template + kreative Füllung |
| `listing.content` (NEU) | `creative` | Beschreibung = verkaufspsychologisch |

### Implementation

#### Schritt 1: `policyZone` Parameter zu allen Policy-Funktionen hinzufügen

```javascript
// lib/llm-policy-pack.js
function buildCommonPolicyText(opts = {}) {
  const zone = opts.policyZone || 'strict';
  // ... wie oben
}
```

#### Schritt 2: Scope-Config um Zone erweitern

```javascript
// lib/llm-config.js — DEFAULT_SCOPES erweitern
{
  scopeId: 'identify.v2',
  // ... bestehend ...
  policyZone: 'strict',
},
{
  scopeId: 'listing.keywords',
  // ... neu ...
  policyZone: 'creative',
},
```

#### Schritt 3: Alle Gemini-Aufrufe lesen policyZone aus Scope-Config

```javascript
// In jedem Service der buildCommonPolicyText() aufruft:
const config = await getActiveLlmConfig(scopeId);
const policyText = buildCommonPolicyText({ policyZone: config.policyZone || 'strict' });
```

### Testing

- Test: `policyZone='strict'` enthält NICHT "Du DARFST Synonyme"
- Test: `policyZone='creative'` enthält "Du DARFST Synonyme" UND "Erfinde NIEMALS"
- Test: Default (kein Zone-Parameter) = 'strict' (abwärtskompatibel)
- Test: Bestehende Scopes (identify, improve, chat, quality, image) behalten bisheriges Verhalten

---

## LISTING-003: Erweiterte Kategorie-Templates (9+ Hauptkategorien)

| Field | Value |
|-------|-------|
| **Feature ID** | LISTING-003 |
| **Priority** | P1 |
| **Status** | Ready |
| **Change Level** | L0 (additiv, Daten-Erweiterung) |
| **Effort** | M |
| **Dependencies** | Keine |
| **Protected Zones** | lib/title-policy.js, lib/llm-policy-pack.js |

### Problem Statement

`llm-policy-pack.js` hat 20 generische Kategorie-Templates.
`title-policy.js` erzwingt eine fixe Reihenfolge: `[BRAND] [PRODUCT_TYPE] [MODEL] [CORE_SPEC] [VARIANT] [CONDITION]`.

Der Leitfaden zeigt: **Jede Hauptkategorie hat fundamental andere Prioritäten.**

| Kategorie | Leitfaden-Priorität | AvyCloud heute |
|-----------|---------------------|----------------|
| Fashion | Stil, Material, Passform | ✅ Teilweise (Schuhe gut, Rest generisch) |
| Elektronik | MPN, Prozessor, RAM, Storage | ✅ Gut |
| Haus & Garten | Maße, Material, Stil | ⚠️ Maße werden kompaktiert, Stil fehlt |
| Auto-Teile | OEM-Nr, KEIN Fahrzeugmodell im Titel | ✅ K-Typ vorhanden |
| Sammeln | Epoche, Grading, Herkunft | ❌ Fehlt komplett |
| Spielzeug | Thema, Set-Nr, Vollständigkeit | ❌ Fehlt |
| Bücher/Medien | Format, Edition, Zustand | ❌ Fehlt |
| Business/Industrie | Leistungsdaten, Referenz-Nr | ❌ Fehlt |
| Sport/Freizeit | Aktivität, Rahmengröße, Gewicht | ❌ Fehlt |

### Architektur

#### Neue Datei: `lib/category-title-templates.js`

```javascript
const CATEGORY_TITLE_TEMPLATES = {
  fashion: {
    pattern: '[Marke] [Modell/Linie] [Produkttyp] [Zielgruppe] [Größe] [Farbe] [Material]',
    priorityA: ['brand', 'model', 'productType'],
    priorityB: ['targetGroup', 'size', 'color', 'material'],
    bonusKeywords: ['Vintage', 'Y2K', 'Oversized', 'Slim Fit'],
    examples: ['Levi\'s 501 Jeans Damen W28 L32 Blau Denim Straight Leg Vintage Look'],
  },
  electronics: {
    pattern: '[Marke] [Modellname] [Modellnummer/MPN] [Hauptmerkmal] [Farbe]',
    priorityA: ['brand', 'model', 'mpn'],
    priorityB: ['coreSpec', 'color'],
    bonusKeywords: ['OVP', 'Sealed'],
    examples: ['Apple MacBook Pro 14 M3 Chip 16GB RAM 512GB SSD Space Grau 2023 OVP'],
  },
  home_garden: {
    pattern: '[Marke] [Produktbezeichnung] [Material] [Maße] [Farbe] [Stil]',
    priorityA: ['brand', 'productType', 'material'],
    priorityB: ['dimensions', 'color', 'style'],
    bonusKeywords: ['Skandinavisch', 'Boho', 'Industrial', 'Massivholz'],
    examples: ['Esstisch Eiche Massivholz 200x100 cm Handgefertigt Skandinavisch Natur'],
  },
  auto_parts: {
    pattern: '[Hersteller] [Teilename] [Einbauposition] [OEM-Referenznummer]',
    priorityA: ['brand', 'partName', 'position'],
    priorityB: ['oem', 'mpn'],
    bonusKeywords: [],
    rules: ['KEINE Fahrzeugmodelle im Titel — nutze Fahrzeugverwendungsliste (K-Types)'],
    examples: ['Bosch Bremsscheiben Vorne Set 0986479215 passend für VW Golf VII 7'],
  },
  collectibles: {
    pattern: '[Jahr/Epoche] [Objektbezeichnung] [Edition/Besonderheit] [Zustand/Grading]',
    priorityA: ['era', 'objectName', 'edition'],
    priorityB: ['grading', 'origin'],
    bonusKeywords: ['Jugendstil', 'Biedermeier', 'Meissen', 'Murano', 'PSA', 'Mint'],
    examples: ['1999 Pokemon Glurak Holo 1. Edition German Base Set PSA 9 Mint'],
  },
  toys: {
    pattern: '[Marke] [Thema/Charakter] [Set-Nummer] [Produktart] [Zustand]',
    priorityA: ['brand', 'theme', 'setNumber'],
    priorityB: ['productType', 'condition'],
    bonusKeywords: ['OVP', 'Komplett', 'Vintage', 'Sealed'],
    examples: ['LEGO Star Wars 75192 Millennium Falcon UCS Neu OVP Sealed'],
  },
  media: {
    pattern: '[Titel] [Autor/Künstler/Plattform] [Format/Medium] [Edition] [Zustand]',
    priorityA: ['title', 'creator', 'format'],
    priorityB: ['edition', 'condition'],
    bonusKeywords: ['Complete', 'Sealed', 'Erstausgabe', 'Limited'],
    examples: ['The Witcher 3 Wild Hunt Nintendo Switch Complete Edition Neu Sealed'],
  },
  business_industrial: {
    pattern: '[Marke] [Modell/Gerätetyp] [Spezifikation/Leistung] [MPN]',
    priorityA: ['brand', 'model', 'spec'],
    priorityB: ['mpn', 'voltage', 'capacity'],
    bonusKeywords: [],
    rules: ['Keine werblichen Adjektive. B2B-Käufer suchen exakte Leistungsdaten.'],
    examples: ['Bosch GSR 18V-60 C Akku-Bohrschrauber 18V 5.0Ah 06019G1100'],
  },
  sports_hobby: {
    pattern: '[Marke] [Modell] [Sportart/Aktivität] [Spezifikation/Größe] [Farbe]',
    priorityA: ['brand', 'model', 'activity'],
    priorityB: ['spec', 'size', 'color'],
    bonusKeywords: ['Trekking', 'Rennrad', 'Trail'],
    examples: ['Shimano Deore XT M8100 Schaltwerk 12-fach SGS Shadow RD+ Schwarz'],
  },
};

// Mapping: eBay Category ID ranges → Template Key
const CATEGORY_TEMPLATE_MAP = {
  // Fashion: 11450, 15724, 95672, ...
  // Electronics: 293, 175672, 171485, ...
  // etc.
};

function getTemplateForCategory(categoryId, categoryBreadcrumb) {
  // 1. Exact match via CATEGORY_TEMPLATE_MAP
  // 2. Fuzzy match via breadcrumb keywords
  // 3. Fallback: bestehender generischer Template
}

module.exports = { CATEGORY_TITLE_TEMPLATES, getTemplateForCategory };
```

#### Integration in Title-Policy

`title-policy.js` — Erweitere `coerceTitle()` um Template-Awareness:

```javascript
const { getTemplateForCategory } = require('./category-title-templates');

function coerceTitle(raw, opts = {}) {
  const template = getTemplateForCategory(opts.categoryId, opts.categoryBreadcrumb);

  if (template) {
    // Nutze Template-spezifische Reihenfolge statt generischer
    return coerceTitleWithTemplate(raw, template, opts);
  }

  // Fallback: bisheriges Verhalten
  return coerceTitleGeneric(raw, opts);
}
```

### Testing

- Test: Fashion-Produkt bekommt Fashion-Template (Material vor Farbe)
- Test: Auto-Teil bekommt Auto-Template (OEM-Nr statt Modell)
- Test: Unbekannte Kategorie → Fallback auf generisches Template
- Test: Jedes Template-Beispiel passt in 80 Zeichen

---

## LISTING-004: Mobile Description Field (Schema.org itemprop)

| Field | Value |
|-------|-------|
| **Feature ID** | LISTING-004 |
| **Priority** | P1 |
| **Status** | Ready |
| **Change Level** | L0 (additives Feld) |
| **Effort** | S |
| **Dependencies** | LISTING-001 (Content-Step generiert mobileSnippet) |
| **Protected Zones** | Keine |

### Problem Statement

Über 50% des eBay-Traffics ist mobil. Ohne `itemprop="description"` wählt Cassini die ersten 250 Zeichen der Beschreibung — oft unpassend.
AvyCloud generiert aktuell kein mobiles Snippet.

### Architektur

#### Neues Feld in Listing-Output

```javascript
// services/listing-pipeline.js — Output erweitern
{
  ebay: {
    title: '...',
    description: '...', // bestehend
    mobileSnippet: '...', // NEU: max 800 Zeichen, optimiert für mobile Anzeige
  }
}
```

#### Schema.org Markup in Description einbetten

```javascript
// services/listing-pipeline.js — stepAssemble()
function wrapWithSchemaOrg(description, mobileSnippet) {
  const schemaDiv = `<div vocab="https://schema.org/" typeof="Product"><span property="description">${mobileSnippet}</span></div>`;
  return schemaDiv + '\n' + description;
}
```

#### Firestore: Additives Feld

```javascript
// Unter product.marketplace_listings.ebay
{
  title: '...',
  description: '...',
  mobileSnippet: '...', // NEU
  categoryId: '...',
}
```

### Testing

- Test: mobileSnippet ≤ 800 Zeichen
- Test: Schema.org div wird korrekt in HTML eingebettet
- Test: mobileSnippet enthält primäre Keywords
- Test: Bestehende Description bleibt unverändert (additiv)

---

## LISTING-005: Keyword-Dichte & Benefits-Enforcement

| Field | Value |
|-------|-------|
| **Feature ID** | LISTING-005 |
| **Priority** | P1 |
| **Status** | Ready |
| **Change Level** | L0 (Policy-Erweiterung) |
| **Effort** | S |
| **Dependencies** | LISTING-001 |
| **Protected Zones** | lib/llm-policy-pack.js, lib/llm-rulebook.js |

### Problem Statement

Aktuelle Keyword-Governance: "2-3 primäre Keywords + max 1-2 Synonyme."
Leitfaden: "5-7% Keyword-Dichte bei 200 Wörtern = 10-14 Nennungen."

Aktuelle Highlights-Policy validiert Länge/Anzahl — nicht ob Benefits oder Features.

### Implementation

#### Keyword-Dichte Validierung

**Datei:** `lib/llm-rulebook.js` — Neue Funktion:

```javascript
function validateKeywordDensity(description, keywords) {
  const visibleText = stripHtml(description);
  const wordCount = visibleText.split(/\s+/).length;
  const keywordCount = keywords.reduce((sum, kw) => {
    const regex = new RegExp(escapeRegex(kw), 'gi');
    return sum + (visibleText.match(regex) || []).length;
  }, 0);

  const density = keywordCount / wordCount;

  if (density < 0.03) return { ok: false, issue: 'keyword_density_low', density };
  if (density > 0.10) return { ok: false, issue: 'keyword_stuffing', density };
  return { ok: true, density };
}
```

#### Benefits-Check für Highlights

**Datei:** `lib/highlights-policy.js` — Erweitere Validierung:

```javascript
// Heuristik: Ein Benefit enthält typischerweise "—", "für", "damit", "dank", "sorgt für"
function isBenefitFormat(highlight) {
  const benefitIndicators = ['—', '–', ' für ', ' damit ', ' dank ', ' sorgt ', ' ermöglicht ', ' bietet '];
  return benefitIndicators.some(ind => highlight.toLowerCase().includes(ind));
}

function validateHighlights(highlights) {
  // ... bestehende Längen/Anzahl-Checks ...

  const benefitCount = highlights.filter(isBenefitFormat).length;
  if (benefitCount < Math.ceil(highlights.length * 0.5)) {
    issues.push({
      level: 'warn',
      message: `Nur ${benefitCount}/${highlights.length} Highlights im Benefits-Format. Empfohlen: ≥50%`,
    });
  }

  return { ok: issues.filter(i => i.level === 'error').length === 0, issues };
}
```

#### Listing-Content Prompt erweitern

Im Prompt für `listing.content` Scope (LISTING-001, Step 3):

```
KEYWORD-DICHTE:
Du MUSST die primären Keywords und Synonyme so einweben, dass die Gesamt-Keyword-Dichte
zwischen 5% und 7% liegt (bei ~200 Wörtern = 10-14 Nennungen).
Verteile die Keywords natürlich über alle Absätze.
Keyword-Stuffing (>10%) wird von Cassini bestraft.

HIGHLIGHTS:
Formuliere mindestens 50% der Bullet Points im Benefits-Format:
"[Kundennutzen] — [technische Spec]"
SCHLECHT: "512GB SSD"
GUT: "512GB SSD — genug Speicher für Ihre gesamte Mediathek"
```

### Testing

- Test: `validateKeywordDensity()` erkennt <3% als zu niedrig
- Test: `validateKeywordDensity()` erkennt >10% als Stuffing
- Test: `isBenefitFormat()` erkennt "—" Separator
- Test: Highlights mit 0 Benefits → Warning
- Test: Bestehende Rulebook-Validierung bleibt intakt

---

# PHASE 2: Competitive Intelligence

> Marktdaten als Input für Gemini. Ohne Wettbewerbsdaten
> generiert Gemini Listings im Vakuum.

---

## MARKET-001: Competitive Intelligence Service

| Field | Value |
|-------|-------|
| **Feature ID** | MARKET-001 |
| **Priority** | P1 |
| **Status** | Ready |
| **Change Level** | L2 (neuer Service + Collection) |
| **Effort** | XL |
| **Dependencies** | Keine |
| **Protected Zones** | Keine (alles neu) |

### Problem Statement

Der Leitfaden lebt von ZIK Analytics und Terapeak:
- Sell-through-Rate >500%
- Wettbewerbsdichte <6 Wettbewerber
- Preis-Delta 0,30€ unter Top-Wettbewerber
- Verkaufsfrequenz mind. 2 Sales/7 Tage

AvyCloud hat `ebay-browse-title-insights.js` (Titel-Tokens) und `competitor-prices.js` (Preis-Samples) — aber **kein integriertes Marktbild**.

### Architektur

#### Neuer Service: `services/competitive-intelligence.js`

```javascript
/**
 * Competitive Intelligence Service
 * Aggregiert Marktdaten für ein Produkt aus mehreren eBay-Quellen
 */

async function buildCompetitiveReport(product, opts = {}) {
  const tenantId = product.tenantId;

  // 1. eBay Browse API: Aktive Angebote + Preise
  const browseResults = await queryEbayBrowse(product);

  // 2. eBay Browse API: Verkaufte Artikel (letzte 30 Tage)
  const soldResults = await queryEbaySold(product);

  // 3. Title Insights (bestehend, aus ebay-browse-title-insights.js)
  const titleInsights = await fetchTitleInsights(product);

  // 4. Gemini-Analyse (Scope: competitive.analysis — NEU)
  const analysis = await analyzeWithGemini({
    activeListings: browseResults,
    soldItems: soldResults,
    titleInsights,
    product,
  });

  return {
    productId: product.id,
    timestamp: new Date().toISOString(),

    // Markt-KPIs (aus Leitfaden)
    marketKpis: {
      competitorCount: browseResults.total,
      medianPrice: calcMedian(browseResults.prices),
      sellThroughRate: calcSellThrough(soldResults, browseResults),
      salesFrequency7d: soldResults.last7Days,
      suggestedPriceDelta: analysis.priceDelta,
    },

    // Gemini-Empfehlungen
    recommendations: {
      pricing: analysis.pricingAdvice,      // "Preis 0,30€ unter Median senken"
      keywords: analysis.missingKeywords,    // Keywords die Wettbewerber nutzen
      attributes: analysis.missingAttributes, // Item Specifics die fehlen
      positioning: analysis.positioning,      // "Low-Ticket Momentum" vs "Premium Nische"
    },

    // Rohdaten
    raw: { browseResults, soldResults, titleInsights },
  };
}
```

#### Neue Firestore Collection: `competitiveReports`

```javascript
// competitiveReports/{reportId}
{
  productId: 'xxx',
  tenantId: 'xxx',
  marketKpis: { ... },
  recommendations: { ... },
  createdAt: Timestamp,
  expiresAt: Timestamp, // 24h Cache
}
```

#### Neuer LLM Scope: `competitive.analysis`

```javascript
{
  scopeId: 'competitive.analysis',
  name: 'Competitive Market Analysis',
  purpose: 'Analysiere Marktdaten und gib Preis-/Listing-Empfehlungen',
  defaultModelEnvKey: 'GEMINI_LISTING_MODEL',
  policyZone: 'creative', // Darf Markteinschätzungen geben
}
```

#### API Endpoint

```javascript
// routes/marketplace.js — NEU
router.get('/marketplace/competitive-report/:productId', async (req, res) => {
  // ...
});
router.post('/marketplace/competitive-report/:productId/refresh', async (req, res) => {
  // ...
});
```

#### Integration in Listing-Pipeline

```javascript
// services/listing-pipeline.js — Step 1 (Keyword Research) erweitern
async function stepKeywordResearch(product) {
  // Competitive Report laden (wenn vorhanden)
  const report = await getCachedCompetitiveReport(product.id);

  if (report) {
    // Gemini bekommt Wettbewerbsdaten als Input
    return keywordResearchWithMarketData(product, report);
  }

  return keywordResearchStandalone(product);
}
```

### Frontend

Neuer Tab im ProductSheet: **"Marktanalyse"**

- KPI-Tiles: Wettbewerber, Median-Preis, Sell-Through-Rate, Preis-Delta
- Empfehlungs-Cards (Gemini): Preis, Keywords, Attributes
- "Refresh" Button → POST competitive-report/refresh
- Daten-Alter-Anzeige (z.B. "Daten von vor 4 Stunden")

---

## MARKET-002: Item Specifics Vollständigkeitsprüfung (Required + Recommended)

| Field | Value |
|-------|-------|
| **Feature ID** | MARKET-002 |
| **Priority** | P1 |
| **Status** | Ready |
| **Change Level** | L0 (Erweiterung bestehender Logik) |
| **Effort** | M |
| **Dependencies** | Keine |
| **Protected Zones** | lib/ebay-taxonomy.js, services/quality-gate.js |

### Problem Statement

`quality-gate.js` prüft nur **required** Aspects. Der Leitfaden sagt: auch **empfohlene** Felder erzeugen "binäre Unsichtbarkeit" in Filtern.
`ebay-taxonomy.js` hat `aspects-full.json` (98 MB) mit ALLEN Aspects inkl. recommended — wird aber nur für required genutzt.

### Implementation

#### Erweitere `buildRequiredAspectMeta()`

```javascript
// lib/ebay-taxonomy.js
function buildAspectMeta(categoryId, productAttributes) {
  const catalog = getCategoryAspectCatalog(categoryId);

  return {
    required: {
      total: catalog.required.length,
      filled: countFilled(catalog.required, productAttributes),
      missing: findMissing(catalog.required, productAttributes),
    },
    recommended: {  // NEU
      total: catalog.recommended.length,
      filled: countFilled(catalog.recommended, productAttributes),
      missing: findMissing(catalog.recommended, productAttributes),
    },
    completenessScore: calcCompleteness(catalog, productAttributes), // 0-100%
  };
}
```

#### Quality Gate erweitern

```javascript
// services/quality-gate.js — Neue Regel
{
  id: 'aspects_recommended_coverage',
  level: 'warn', // Nicht error, aber sichtbar
  check: (product) => {
    const meta = buildAspectMeta(product.ebay?.categoryId, product.attributes);
    if (meta.recommended.filled / meta.recommended.total < 0.7) {
      return {
        pass: false,
        message: `Nur ${meta.recommended.filled}/${meta.recommended.total} empfohlene Artikelmerkmale befüllt. Fehlend: ${meta.recommended.missing.join(', ')}`,
      };
    }
    return { pass: true };
  },
}
```

#### Gemini-Unterstützung: Fehlende Aspects aus Kontext ableiten

```javascript
// services/improve.js — Erweitere Improve-Pipeline
async function suggestMissingAspects(product) {
  const meta = buildAspectMeta(product.ebay?.categoryId, product.attributes);

  if (meta.recommended.missing.length === 0) return null;

  // Gemini kann aus Titel, Beschreibung und Bildern fehlende Aspects ableiten
  const suggestions = await geminiCall({
    scope: 'improve.product',
    prompt: `Produktdaten: ${JSON.stringify(product)}

    Fehlende empfohlene eBay-Artikelmerkmale: ${meta.recommended.missing.join(', ')}

    Leite aus den vorhandenen Produktdaten so viele fehlende Merkmale wie möglich ab.
    NUR wenn du dir SICHER bist. Antworte als JSON: { attributeName: value }`,
  });

  return suggestions;
}
```

### Testing

- Test: `buildAspectMeta()` gibt required + recommended zurück
- Test: 100% required + 0% recommended → kein Error, nur Warn
- Test: Fehlende required → Error (bisheriges Verhalten bleibt)
- Test: `suggestMissingAspects()` schlägt nur ableitbare Werte vor

---

## MARKET-003: eBay Browse API — Sold Items Integration

| Field | Value |
|-------|-------|
| **Feature ID** | MARKET-003 |
| **Priority** | P1 |
| **Status** | Ready |
| **Change Level** | L1 (neues API-Modul) |
| **Effort** | M |
| **Dependencies** | MARKET-001 |
| **Protected Zones** | Keine |

### Problem Statement

Die eBay Browse API kann `SOLD` Filter nutzen. AvyCloud nutzt sie nur für Active Listings + Preise.
Für Sell-Through-Rate und Sales-Velocity brauchen wir Verkaufsdaten.

### Implementation

#### Neue Funktion in `lib/ebay-api.js`

```javascript
async function searchSoldItems(query, opts = {}) {
  const { categoryId, limit = 50, daysBack = 30 } = opts;

  const filters = [
    `buyingOptions:{FIXED_PRICE}`,
    `conditions:{NEW}`,
    `deliveryCountry:DE`,
  ];

  if (categoryId) filters.push(`categoryIds:{${categoryId}}`);

  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&filter=${filters.join(',')}&sort=-price&limit=${limit}`;

  // Nutze App Token (kein User Token nötig für Browse API)
  return ebayGetJson(url, appToken);
}
```

#### Sell-Through-Rate Berechnung

```javascript
function calcSellThrough(soldItems, activeListings) {
  // Sell-through-Rate = (Verkaufte / (Verkaufte + Aktive)) * 100
  const sold = soldItems.total || 0;
  const active = activeListings.total || 0;
  if (sold + active === 0) return 0;
  return Math.round((sold / (sold + active)) * 100);
}
```

---

## MARKET-004: Pricing Intelligence (Median + Delta)

| Field | Value |
|-------|-------|
| **Feature ID** | MARKET-004 |
| **Priority** | P1 |
| **Status** | Ready |
| **Change Level** | L0 (Erweiterung von competitor-prices.js) |
| **Effort** | S |
| **Dependencies** | MARKET-001 |
| **Protected Zones** | Keine |

### Problem Statement

`competitor-prices.js` liefert Preis-Samples, aber keine strategische Empfehlung.
Der Leitfaden: "0,30€ unter Median-Preis des Top-Wettbewerbers."

### Implementation

```javascript
// lib/competitor-prices.js — Erweitere Output
function enrichPriceWithStrategy(prices) {
  const median = calcMedian(prices);
  const topCompetitorPrice = prices.sort((a, b) => b.salesRank - a.salesRank)[0]?.price;

  return {
    ...existingOutput,
    median,
    topCompetitorPrice,
    suggestedPrice: topCompetitorPrice ? topCompetitorPrice - 0.30 : median - 0.30,
    strategy: topCompetitorPrice
      ? `0,30€ unter Top-Wettbewerber (${topCompetitorPrice}€) = ${(topCompetitorPrice - 0.30).toFixed(2)}€`
      : `0,30€ unter Median (${median}€) = ${(median - 0.30).toFixed(2)}€`,
    outlierWarning: isOutlier(prices, product.price)
      ? 'Preis liegt außerhalb der Cassini-Toleranzgrenze'
      : null,
  };
}
```

---

# PHASE 3: Automation

> Cassini belohnt Konsistenz und Momentum.
> Diese Features automatisieren was der Leitfaden als "Daily Habits" beschreibt.

---

## AUTO-001: 30-Tage-Relisting-Automatismus

| Field | Value |
|-------|-------|
| **Feature ID** | AUTO-001 |
| **Priority** | P1 |
| **Status** | Ready |
| **Change Level** | L2 (neuer Scheduled Job + neue Collection) |
| **Effort** | L |
| **Dependencies** | Keine |
| **Protected Zones** | Keine (alles neu) |

### Problem Statement

Der Leitfaden: "Artikel die nach 30 Tagen nicht verkauft wurden → End and Relist. Dies triggert den New Listing Boost von Cassini."
AvyCloud hat keinen automatischen Relisting-Mechanismus.

### Architektur

#### Neuer Service: `services/relisting-engine.js`

```javascript
async function findRelistCandidates(tenantId) {
  // Query: eBay-gelistete Produkte deren Listing > 30 Tage alt ist + 0 Verkäufe
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const candidates = await db.collection('ebayListingsLive')
    .where('tenantId', '==', tenantId)
    .where('listedAt', '<', thirtyDaysAgo)
    .where('quantitySold', '==', 0)
    .get();

  return candidates.docs.map(doc => ({
    itemId: doc.id,
    sku: doc.data().sku,
    productId: doc.data().productId,
    listedAt: doc.data().listedAt,
    daysListed: daysDiff(doc.data().listedAt, new Date()),
  }));
}

async function executeRelist(tenantId, itemId, opts = {}) {
  const { dryRun = true, optimizeListing = true } = opts;

  // 1. End listing via Trading API
  if (!dryRun) {
    await endItem(itemId, 'NotAvailable');
  }

  // 2. Optional: Re-optimize listing via LISTING-001 Pipeline
  if (optimizeListing) {
    const product = await getProductByEbayItemId(itemId);
    await generateChannelListings(product.id, { channels: ['ebay'] });
  }

  // 3. Relist via Trading API (addFixedPriceItem)
  if (!dryRun) {
    await addFixedPriceItem(product, optimizedListing);
  }

  // 4. Log
  await logRelistAction(tenantId, itemId, { dryRun, optimizeListing });

  return { success: true, dryRun };
}
```

#### Scheduled Task

```javascript
// Täglich um 03:00 UTC
{
  name: 'relisting-30d',
  schedule: '0 3 * * *',
  handler: async (tenantId) => {
    const candidates = await findRelistCandidates(tenantId);

    // Respektiere tägliches Listing-Limit
    const dailyLimit = await getDailyListingBudget(tenantId);
    const batch = candidates.slice(0, dailyLimit);

    for (const item of batch) {
      await executeRelist(tenantId, item.itemId, { dryRun: false, optimizeListing: true });
    }
  },
}
```

#### Neue Collection: `relistingLog`

```javascript
{
  tenantId: 'xxx',
  itemId: 'xxx',
  productId: 'xxx',
  action: 'relist',
  oldItemId: 'xxx',
  newItemId: 'xxx',
  optimized: true,
  createdAt: Timestamp,
}
```

#### API Endpoints

```javascript
router.get('/marketplace/ebay/relist/candidates', ...);   // Liste Kandidaten
router.post('/marketplace/ebay/relist/preview', ...);      // Dry-Run
router.post('/marketplace/ebay/relist/execute', ...);      // Ausführen
router.get('/marketplace/ebay/relist/log', ...);           // History
```

---

## AUTO-002: Sell-Through-Rate Monitoring

| Field | Value |
|-------|-------|
| **Feature ID** | AUTO-002 |
| **Priority** | P2 |
| **Status** | Draft |
| **Change Level** | L1 |
| **Effort** | M |
| **Dependencies** | MARKET-001, AUTO-001 |

### Kurzfassung

Track Sell-Through-Rate pro Produkt und Shop-weit.
Shop-weite STR < 50% → Warning. Einzelprodukt 0 Sales in 14 Tagen → Optimierungs-Vorschlag.
Cassini bestraft Shops mit vielen "Ladenhütern".

### Kernfunktionen

- `calcShopSellThroughRate(tenantId)` → Aggregat über alle aktiven Listings
- `identifySlowMovers(tenantId, threshold)` → Produkte mit 0 Sales > X Tage
- `suggestOptimization(productId)` → Gemini-basierte Vorschläge (Preis? Titel? Delist?)
- Dashboard-Widget: STR-Trend (7/14/30 Tage)

---

## AUTO-003: Daily Listing Cadence Planner

| Field | Value |
|-------|-------|
| **Feature ID** | AUTO-003 |
| **Priority** | P2 |
| **Status** | Draft |
| **Change Level** | L1 |
| **Effort** | M |
| **Dependencies** | AUTO-001 |

### Kurzfassung

Der Leitfaden: "Monatliches Listing-Limit / 30 = Tägliches Ziel."
AvyCloud sollte das automatisch berechnen und als tägliche Queue vorschlagen.

### Kernfunktionen

- `getDailyListingBudget(tenantId)` → Basierend auf eBay Account Limit
- `getListingQueue(tenantId, date)` → Heute zu listende Produkte (Prio: neue Produkte > Relists)
- Dashboard-Widget: "Heute: 5/12 Listings erstellt" mit Progress Bar
- Push-Notification wenn Tagesziel nicht erreicht

---

## AUTO-004: Ladenhüter-Detection & Auto-Optimize

| Field | Value |
|-------|-------|
| **Feature ID** | AUTO-004 |
| **Priority** | P2 |
| **Status** | Draft |
| **Change Level** | L2 |
| **Effort** | L |
| **Dependencies** | AUTO-002, MARKET-001 |

### Kurzfassung

Automatische Erkennung von "Dead Stock" auf eBay mit Gemini-basierten Optimierungsvorschlägen.

### Entscheidungsbaum (Gemini)

```
Produkt hat 0 Verkäufe seit >21 Tagen
  ├── Preis > Median + 10%? → Preissenkung empfehlen
  ├── Titel-Score < 70%? → Titel re-optimieren (LISTING-001)
  ├── Item Specifics < 70%? → Fehlende Aspects ergänzen (MARKET-002)
  ├── Keine/schlechte Bilder? → Bildoptimierung empfehlen
  └── Alles OK aber kein Markt? → Delist empfehlen (Sell-Through schützen)
```

---

## AUTO-005: Listing Health Score

| Field | Value |
|-------|-------|
| **Feature ID** | AUTO-005 |
| **Priority** | P2 |
| **Status** | Draft |
| **Change Level** | L1 |
| **Effort** | M |
| **Dependencies** | LISTING-001, MARKET-002, VAL-001 |

### Kurzfassung

Ein aggregierter Score (0-100) pro Listing der ALLE Cassini-Faktoren abbildet:

| Faktor | Gewicht | Quelle |
|--------|---------|--------|
| Titel-Qualität | 20% | title-policy.js Score |
| Beschreibungs-Qualität | 15% | Keyword-Dichte + Wortanzahl + Benefits-Ratio |
| Item Specifics Vollständigkeit | 20% | MARKET-002 completenessScore |
| Bildqualität | 15% | quality-gate.js Image-Check |
| Preis-Wettbewerbsfähigkeit | 15% | MARKET-004 Median-Delta |
| Servicebedingungen | 10% | Versandzeit, Rücknahme-Policy |
| Verkäufer-History | 5% | eBay Seller Performance Metrics |

Dashboard: Sortierbare Listing-Liste nach Health Score. Rot (<60), Gelb (60-80), Grün (>80).

---

# PHASE 4: Performance Loops

> Cassini-Feedback → Listing-Optimierung → bessere Rankings → mehr Sales

---

## PERF-002: CTR/CVR Tracking aus eBay Seller Hub

| Field | Value |
|-------|-------|
| **Feature ID** | PERF-002 |
| **Priority** | P2 |
| **Status** | Draft |
| **Change Level** | L2 |
| **Effort** | XL |
| **Dependencies** | Alle Phase 1-3 Features |

### Kurzfassung

Der Leitfaden: "CTR signalisiert dass Titel und Hauptbild attraktiv sind. CVR bestätigt dass das Produkt das Versprechen hält."

eBay Traffic Reports API → Impressions, Clicks, Sales pro Listing.
Speichere als Zeitreihe → Gemini analysiert Trends → schlägt Optimierungen vor.

### Datenmodell

```javascript
// listingMetrics/{metricId}
{
  tenantId: 'xxx',
  itemId: 'xxx',
  productId: 'xxx',
  date: '2026-03-28',
  impressions: 150,
  clicks: 12,
  ctr: 0.08,
  sales: 2,
  cvr: 0.167,
  revenue: 49.98,
}
```

### Gemini Feedback Loop

```
Listing X: CTR sank von 8% auf 3% in 7 Tagen.
→ Gemini analysiert: "Titel enthält keine Mobile-First Keywords. Hauptbild hat keinen weißen Hintergrund."
→ Empfehlung: "Titel re-optimieren + Hauptbild austauschen"
→ One-Click: Listing-Pipeline neu durchlaufen
```

---

## PERF-003: A/B Testing für Titel

| Field | Value |
|-------|-------|
| **Feature ID** | PERF-003 |
| **Priority** | P3 |
| **Status** | Draft |
| **Change Level** | L2 |
| **Effort** | XL |
| **Dependencies** | PERF-002 |

### Kurzfassung

Generiere 2 Titel-Varianten via Gemini → Liste mit Variante A für 14 Tage → Wechsel zu Variante B → Vergleiche CTR → Behalte Gewinner.

eBay erlaubt kein natives A/B Testing, aber End+Relist mit neuem Titel ist equivalent.

---

## PERF-004: Gemini Self-Improvement Loop

| Field | Value |
|-------|-------|
| **Feature ID** | PERF-004 |
| **Priority** | P3 |
| **Status** | Draft |
| **Change Level** | L2 |
| **Effort** | XL |
| **Dependencies** | PERF-002, alle Phase 1-3 |

### Kurzfassung

Der ultimative Feedback-Loop:

```
1. Gemini generiert Listing (LISTING-001)
2. Listing wird publiziert
3. eBay meldet Performance-Daten (PERF-002)
4. Gemini analysiert: "Was funktioniert? Was nicht?"
5. Gemini passt eigene Prompts/Templates an (via llm-config.js Versioning)
6. Nächstes Listing profitiert von Learnings
```

Speichere "was hat funktioniert" als Scope-Version-Notes in Firestore.
Gemini kann neue Scope-Versionen vorschlagen (aber nicht selbst aktivieren — Human-in-the-Loop).

---

# APPENDIX A: Zusammenfassung der neuen LLM Scopes

| Scope ID | Policy Zone | Modell | Phase |
|----------|-------------|--------|-------|
| `listing.keywords` | creative | Gemini 3 Flash | Phase 1 |
| `listing.title` | hybrid | Gemini 3 Flash | Phase 1 |
| `listing.content` | creative | Gemini 3 Pro | Phase 1 |
| `competitive.analysis` | creative | Gemini 3 Pro | Phase 2 |

# APPENDIX B: Zusammenfassung der neuen Firestore Collections

| Collection | Phase | Zweck |
|------------|-------|-------|
| `competitiveReports` | Phase 2 | Marktanalysen (24h Cache) |
| `relistingLog` | Phase 3 | Relisting-Historie |
| `listingMetrics` | Phase 4 | CTR/CVR Zeitreihen |

# APPENDIX C: Zusammenfassung der neuen API Endpoints

| Method | Path | Phase |
|--------|------|-------|
| GET | `/marketplace/competitive-report/:productId` | Phase 2 |
| POST | `/marketplace/competitive-report/:productId/refresh` | Phase 2 |
| GET | `/marketplace/ebay/relist/candidates` | Phase 3 |
| POST | `/marketplace/ebay/relist/preview` | Phase 3 |
| POST | `/marketplace/ebay/relist/execute` | Phase 3 |
| GET | `/marketplace/ebay/relist/log` | Phase 3 |
| GET | `/marketplace/ebay/listing-metrics/:itemId` | Phase 4 |
| GET | `/marketplace/ebay/listing-metrics/trends` | Phase 4 |

# APPENDIX D: Priorisierte Build-Reihenfolge für Claude Code

```
── Phase 1 (Sofort, höchster ROI) ─────────────────────
│
├─ LISTING-002: Drei-Zonen-Modell (Policy-Refactor)     ← ZUERST (unblocked alles)
├─ LISTING-001: Multi-Step Pipeline                      ← Kern-Feature
├─ LISTING-003: Kategorie-Templates erweitern            ← Parallel möglich
├─ LISTING-004: Mobile Description Field                 ← Klein, schnell
├─ LISTING-005: Keyword-Dichte & Benefits                ← Klein, schnell
│
── Phase 2 (Marktdaten) ───────────────────────────────
│
├─ MARKET-003: Sold Items API                            ← Daten-Grundlage
├─ MARKET-004: Pricing Intelligence                      ← Erweiterung bestehend
├─ MARKET-002: Item Specifics Vollständigkeit             ← Erweiterung bestehend
├─ MARKET-001: Competitive Intelligence Service          ← Aggregation
│
── Phase 3 (Automation) ───────────────────────────────
│
├─ AUTO-001: 30-Tage-Relisting                           ← Größter Cassini-Hebel
├─ AUTO-005: Listing Health Score                        ← Sichtbarkeit
├─ AUTO-002: Sell-Through Monitoring                     ← Feedback
├─ AUTO-003: Daily Listing Cadence                       ← Planung
├─ AUTO-004: Ladenhüter Detection                        ← Optimierung
│
── Phase 4 (Performance Loops) ─────────────────────────
│
├─ PERF-002: CTR/CVR Tracking                            ← Daten-Grundlage
├─ PERF-003: A/B Testing                                 ← Experimentieren
├─ PERF-004: Gemini Self-Improvement                     ← Autonomie
```

---

**Dokument-Version:** 1.0
**Erstellt:** 2026-03-28
**Autor:** Claude (Analyse) + Oguzhan (Strategie)
**Nächster Schritt:** Oguzhan entscheidet welche Features in Phase 1 zuerst gebaut werden
