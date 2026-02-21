### Ziel

Alle in AvyCloud eingesetzten LLMs (Identify / Improve / Chat) **müssen** ein **identisches, zwingendes Regelwerk** anwenden – unabhängig vom Workflow oder Marktplatz.

- **Keine doppelten Attribute** (weder strukturell noch semantisch)
- **Kanonische Normalisierung** aller Attribute & Titelbestandteile
- **Gleiche Strenge überall** (Enrichment, Titel, Mapping, Sync)
- **Kein Best-Effort**: Abweichungen gelten als Fehler und dürfen **nicht gespeichert** und **nicht synchronisiert** werden.

### Quellen (abgelegt)

- `docs/rulebook/Titel_Regeln.csv`
- `docs/rulebook/Highlights_Regeln.csv`

### Umsetzung im Code (Single Source of Truth)

#### Titel

- Implementierung: `backend/lib/title-policy.js`
- Enforcement:
  - `backend/services/enrichment.js` (Datasheet Review)
  - `backend/services/product-chat.js` (Chat changes → coerced title)
  - `backend/lib/firestore.js` (system saves: title-policy)

Hard Facts:
- Mobile-first: **Priority A** muss **innerhalb der ersten ~60 Zeichen** vorkommen.
- Länge: **70–80 (bevorzugt)**, **Hard-Max 80**.
- Keine Emojis, keine Marketingfloskeln, keine Dubletten.

#### Highlights (Bullets)

- Implementierung: `backend/lib/highlights-policy.js`
- Regeln: aus `Highlights_Regeln.csv` (Kategorie-basiert)
  - Bullet count: **3–6** (je Kategorie)
  - Bullet-Länge: **70–120 Zeichen** (je Kategorie)
  - Template: **"[Nutzen] – [konkrete Eigenschaft/Spec]"** (Dash/En-Dash mit Spaces)
  - Keine Duplikate
  - Kein Preis/Placeholder/Marketing

#### Attribute

- Implementierung: `backend/lib/attribute-policy.js`
- Regeln:
  - Hard-block: marketplace/meta keys (`ebay*`, `kaufland*`, `*_id`, `category_*`, `gpsr *`, …)
  - Canonical key mapping (konservativ, erweiterbar)
  - **Konflikt-Dubletten** (Synonyme → gleicher Canonical-Key, aber unterschiedliche Werte) = **Fehler**

### Zentrale, zwingende Validierung (LLM-Output Gate)

- `backend/lib/llm-rulebook.js`:
  - `normalizeProductStrict(product)` führt **Title + Highlights + Attributes** strikt zusammen.
  - Bei Verstoß: `ok=false` mit `issues[]` → Output wird verworfen.

### BaseLinker Sync: “Delta Sync” statt Full Sync

Requirement: Nach Regeländerungen soll **nur die Aktualisierung** synchronisiert werden, nicht das komplette Produktdatenblatt.

Umsetzung:
- BaseLinker erlaubt Updates via `addInventoryProduct` mit `product_id` (siehe offizielle API-Doku).
- Delta-Sync nutzt ausschließlich `text_fields` (Name/Beschreibung/Highlights/Features/GPSR/K-Typ extra field).
- Implementierung:
  - `backend/lib/baselinker.js`: `syncProductTextOnlyToBaseLinker()` (mode `text_only`)
  - `backend/services/baselinker-sync-runner.js`: liest `payload.mode` (`full` vs `text_only`)

### Pflicht-Runbook nach jeder Regeländerung

1) Initial Run über alle betroffenen Produkte  
2) BaseLinker Delta Sync der Änderungen

Script:
- `backend/scripts/policy-initial-run-delta-sync.js`

Beispiel:

```bash
GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/policy-initial-run-delta-sync.js --dry-run
GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/policy-initial-run-delta-sync.js --apply --expected-count 631
```

