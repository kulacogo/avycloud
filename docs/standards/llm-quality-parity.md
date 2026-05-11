# LLM Quality-Parity-Charta

> **Single-Source-of-Truth für alle LLM-Calls in AvyCloud.**
> Diese Charta ist verbindlich. Jeder neue oder migrierte LLM-Call MUSS die hier
> beschriebenen Standards einhalten. Reviews lehnen Pull-Requests ab, die ohne
> Begründung davon abweichen.

Letzte Revision: 2026-05-10 (Phase F.5).
Owner: AvyCloud Backend-Team.

---

## 1. Charta (1-Page-TL;DR)

Jeder neue LLM-Call MUSS verwenden:

- **Scope** aus [`backend/lib/llm-config.js`](../../backend/lib/llm-config.js) — Firestore-versioniert
  via Admin-UI [`components/admin/AdminLlmManagement.tsx`](../../components/admin/AdminLlmManagement.tsx).
  Aktuelle Scopes: `chat.product`, `identify.v2`, `improve.product`,
  `quality.gate`, `image.generation` (+ 7 weitere ab Phase F.2).
- **Config-Bridge** `resolveScopeConfig(scopeName, tenantId, callerOverrides)`
  aus [`backend/lib/llm-config.js`](../../backend/lib/llm-config.js). Merge-Order
  (last-wins): `gemini-config`-Defaults < Scope-`generationConfig` <
  `tenantOverrides[tenantId]` < `callerOverrides`.
- **Schema-Validation** aus `backend/lib/llm-schemas/` (zod-Schemas, kommt in
  Phase F.3). Stufe 1 `safeParse + warn`, Stufe 2 `parse + throw`.
- **Telemetrie** via `backend/lib/llm-telemetry.js logLlmCall({ ... })` (kommt
  in Phase F.4). Sample-Rate ENV `LLM_TELEMETRY_SAMPLE` (Default 0.1).

**Verbot:** Keine hardcoded `temperature`, `topP`, `topK`, `maxOutputTokens`,
`thinkingConfig`, `model`-Strings in neuen Callern. Wo bestehende Caller noch
hardcoden, ist die Migration in Phase F.1b nachzuziehen (Drift-Score 1–3 in
[`docs/standards/llm-callers-inventory.md`](./llm-callers-inventory.md)).

### Quality-Baseline

Die fachliche Quality-Baseline ist der
[Strategische eBay Leitfaden](../../Strategischer%20eBay%20Leitfaden.md).
Dort definierte Regeln (80-Zeichen-Titel, ~200-Wort-Beschreibung mit 5–7 %
Keyword-Dichte, weißer Hauptbild-Hintergrund, GTIN/EAN/MPN-Pflicht, kein Active
Content, kein Keyword-Spamming) sind die Mess-Latte für jede LLM-Output-Bewertung.

### Cassini-Score-Pillars

Quality-Outputs werden von [`backend/lib/cassini-scorer.js`](../../backend/lib/cassini-scorer.js)
gegen 5 gewichtete Sub-Scores bewertet (Weights aus `WEIGHTS`):

| Pillar       | Weight | Was wird bewertet                                              |
|--------------|--------|----------------------------------------------------------------|
| `title`      | 0.25   | 80-Zeichen-Limit, Marke + Produkttyp in ersten 3–5 Wörtern, keine `&`/`!`/`_`/`--`. |
| `description`| 0.20   | ~200 Wörter, HTML-strukturiert (`<p>/<ul>/<li>/<strong>`), 5–7 % Keyword-Density, kein Active Content. |
| `image`      | 0.20   | Weißer Hauptbild-Hintergrund, mehrere Perspektiven, keine Wasserzeichen/Overlays. |
| `specifics`  | 0.25   | Required-Aspects vollständig, GTIN/EAN/MPN gesetzt wenn belegbar. |
| `compliance` | 0.10   | GPSR-Herstellerdaten, kein Mobile-Snippet-Tag, keine Active-Content-Tags. |

`overall = Σ pillar.score * pillar.weight` ∈ `[0, 1]`.

---

## 2. Boilerplate — Adding a new LLM call

```js
const { resolveScopeConfig } = require('../lib/llm-config');
const { logLlmCall } = require('../lib/llm-telemetry');
const { callGemini3 } = require('../lib/gemini3-client');

async function myLlmFeature(productData, tenantId) {
  const scopeConfig = await resolveScopeConfig('my.scope.name', tenantId, {
    generationConfig: { temperature: 0.5 }, // optional caller-override
  });

  const startTs = Date.now();
  const result = await callGemini3({
    model: scopeConfig.model,
    systemPrompt: scopeConfig.system_prompt,
    rulesText: scopeConfig.rules_text,
    generationConfig: scopeConfig.generationConfig,
    userInput: productData,
  });

  await logLlmCall({
    pipeline: 'identify-v4',
    scope: 'my.scope.name',
    model: scopeConfig.model,
    temperature: scopeConfig.generationConfig.temperature,
    latencyMs: Date.now() - startTs,
    tenantId,
    productId: productData.id,
    outputQualityScore: result.qualityScore || null,
  });

  return result;
}
```

**Wichtig:**

- `tenantId` IMMER mitgeben — sonst greifen keine `tenantOverrides`, und die
  Telemetrie kann nicht pro-Tenant aggregiert werden.
- `callerOverrides` nur für genuin call-spezifische Werte (z. B. niedrigere
  Temperatur für einen einmaligen strukturierten Output). Globale Defaults
  gehören in den Scope.
- Bei Fehler in `resolveScopeConfig` (Scope unbekannt, keine aktive Version)
  wirft die Funktion einen Error mit `statusCode 404`. Caller MÜSSEN das
  abfangen und einen sinnvollen Fallback wählen (i. d. R. `gemini-config`-Defaults
  + Plain-Prompt).

---

## 3. Versioning-Policy

### Wann wird eine neue Scope-Version angelegt?

| Trigger                                                        | Neue Version Pflicht? |
|----------------------------------------------------------------|-----------------------|
| Prompt-Text-Änderung (auch nur einzelne Wörter)                | Ja                    |
| Rules-Text-Änderung                                            | Ja                    |
| `modelOverride`-Wechsel (z. B. von `gemini-3.1-pro` zu Flash)  | Ja                    |
| `generationConfig`-Änderung (`temperature`, `thinkingConfig`)  | Ja                    |
| Output-Schema-Hint-Erweiterung                                 | Ja                    |
| `tenantOverrides`-Hinzufügen                                   | Nein (modifiziert Scope-Doc, nicht Version) |
| Bugfix in Caller-Code ohne Prompt-Änderung                     | Nein                  |

Versionen sind unveränderlich (`createScopeVersion()` schreibt nur, niemals
update). Activation läuft separat via `activateScopeVersion()` → setzt
`scope.activeVersionId`. Alte Versionen bleiben in der `versions`-Subcollection
und können jederzeit rück-aktiviert werden.

### A/B-Testing-Pattern

1. Neue Version anlegen via Admin-UI (`AdminLlmManagement.tsx`) — sie bleibt
   inaktiv (`createdAt` gesetzt, aber nicht `activeVersionId`).
2. Per-Tenant-A/B via `tenantOverrides[tenantId].version = "<newVersionId>"`
   im Scope-Doc setzen. Tenant A nutzt neue Version, Tenant B die globale
   `activeVersionId`.
3. Quality-Parity-Score (Telemetrie) über ≥ 24 h vergleichen.
4. Bei Win: `activateScopeVersion()` global aktivieren, `tenantOverrides`
   entfernen. Bei Loss: Version inaktiv lassen, `tenantOverrides` entfernen
   — alter Zustand greift automatisch.

**Per-Tenant-Beispiel (TrendOcean vs. AvyCloud):**

```js
// Firestore: llmScopes/chat.product
{
  scopeId: 'chat.product',
  activeVersionId: 'v-prod-2026-05-01',
  tenantOverrides: {
    'trendocean': {
      version: 'v-experiment-2026-05-09',
      generationConfig: { temperature: 0.8 },
    },
  },
}
```

TrendOcean-Calls laden `v-experiment-2026-05-09` mit `temperature: 0.8`,
AvyCloud-Calls laden `v-prod-2026-05-01` mit Scope-Default.

---

## 4. Cost-Discipline

| Hebel                                  | Default      | Wo gesetzt                            |
|----------------------------------------|--------------|---------------------------------------|
| Telemetrie-Sample-Rate                 | `0.1`        | ENV `LLM_TELEMETRY_SAMPLE`            |
| Auto-Downgrade-Window                  | `24 h`       | ENV `LLM_TELEMETRY_SAMPLE_MAX_DURATION_H` |
| Telemetrie-TTL pro Doc                 | `90 d`       | Firestore TTL-Policy auf `llmTelemetry`-Collection |
| Cloud-Billing-Alert                    | `$30 / Monat`| GCP Billing-Alert, Runbook [A5](../runbooks/alerts.md) |

**Auto-Downgrade-Regel:**
Wenn Sample-Rate manuell > 0.5 gesetzt wird (z. B. zum Debugging), läuft sie
nach 24 h automatisch zurück auf `0.1`. State im Firestore-Doc
`system/llm-telemetry-state` (`{ sampleRate, sampleRateChangedAt }`).
Cron-Worker (`backend/cron/llm-telemetry-sample-watchdog.js`) prüft stündlich
und schreibt zurück.

**Cost-Estimate (Phase F.4):** ~$10/Monat/Tenant bei Sample-Rate 0.1, ~$50 bei
1.0. Bei Überschreitung von $30/Monat triggert GCP Billing-Alert A5 (siehe
[`docs/runbooks/alerts.md`](../runbooks/alerts.md)).

**Hot-Spot-Schutz:** Doc-ID-Pattern `${random-prefix-8}-${ts}-${productId}` für
gleichmäßige Sharding-Verteilung. Batched-Writer (100 Events / 5 s) statt
Per-Call-Write.

---

## 5. Quality-Parity-Score-Interpretation

Der Cassini-Overall-Score (`cassini.overall ∈ [0, 1]`) ist das primäre
Quality-Signal. Interpretation:

| Range                | Bedeutung                                | Aktion                              |
|----------------------|------------------------------------------|-------------------------------------|
| `overall ≥ 0.8`      | Top-Quality                              | Autosave erlaubt, kein Review nötig |
| `0.6 ≤ overall < 0.8`| Akzeptabel, eBay-Ready                   | Autosave (Identify-V4 Schwelle `0.6`), Human-Review empfohlen |
| `0.5 ≤ overall < 0.6`| Grenzwertig                              | Review-Pflicht, Critic-Worker prüft erneut |
| `overall < 0.5`      | Quality-Issue                            | Critic triggert Refinement-Loop (max. 5 Iterationen, ENV `IDENTIFY_V4_MAX_ITERATIONS=5`) |

**Pillar-Threshold (für Refinement-Targeting):**

| Pillar        | Refinement-Trigger |
|---------------|--------------------|
| `title`       | `< 0.7` |
| `description` | `< 0.6` |
| `image`       | `< 0.6` |
| `specifics`   | `< 0.75` |
| `compliance`  | `< 0.8` (GPSR-Pflicht ist nicht verhandelbar) |

**Drift-Alert:** Sinkt `overall.p50` über ein 1 h-Window um > 5 pp (Percentage-
Points) gegenüber dem 24 h-Baseline, feuert Alert A7 (siehe
[`docs/runbooks/alerts.md`](../runbooks/alerts.md)). Mögliche Ursachen:
neue Scope-Version mit Regression, Model-API-Drift, Prompt-Cache-Miss-Spike.

---

## 6. LLM-Konsumenten-Inventar

- Aktive LLM-Caller siehe [`docs/standards/llm-callers-inventory.md`](./llm-callers-inventory.md)
  (40 Caller, Stand 2026-05-10, auto-generiert).
- Drift-Audit: `cd backend && node scripts/audit-llm-config.js` (READ-ONLY,
  Output `/tmp/llm-config-audit.json`).
- Drift-Score pro Caller:
  - `0` = nutzt zentrale Helper, keine Hardcodes.
  - `1` = Mixed (Helper + Hardcodes).
  - `2` = voll hardcoded.
  - `3` = inkonsistent (Hardcodes weichen von Defaults ab).
- Migration-Status pro Caller: Tracked in
  [`docs/standards/llm-callers-inventory.md` Sektion 2](./llm-callers-inventory.md#2-drift-score-summary).

**Migrationsweg (Phase F.1b):** Pro Caller eine PR mit:

1. Snapshot-Test VOR Migration (capture aktuelle Output-Shape mit gemockter
   LLM-Antwort).
2. Caller umstellen auf `resolveScopeConfig(scopeName, tenantId)`.
3. Snapshot-Test NACH Migration — Output muss byte-identisch sein.
4. Drift-Score in Inventar auf `0` aktualisieren.

---

## 7. Verweise

- **Plan:** `~/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md`
  (Phase F).
- **Inventory:** [`docs/standards/llm-callers-inventory.md`](./llm-callers-inventory.md).
- **Quality-Baseline:** [`Strategischer eBay Leitfaden.md`](../../Strategischer%20eBay%20Leitfaden.md).
- **Config-Bridge:** [`backend/lib/llm-config.js`](../../backend/lib/llm-config.js)
  (`resolveScopeConfig`, `loadScopeWithFallback`).
- **Defaults:** [`backend/lib/gemini-config.js`](../../backend/lib/gemini-config.js)
  (`DEFAULT_MODEL`, `DEFAULT_CHAT_TEMPERATURE`, `defaultThinkingConfig`,
  `buildGenerationConfig`).
- **Scorer:** [`backend/lib/cassini-scorer.js`](../../backend/lib/cassini-scorer.js).
- **Alerts-Runbook:** [`docs/runbooks/alerts.md`](../runbooks/alerts.md) (A5
  Cost, A7 Quality-Drift).
- **Admin-UI:** [`components/admin/AdminLlmManagement.tsx`](../../components/admin/AdminLlmManagement.tsx),
  [`components/admin/AdminRulebookManagement.tsx`](../../components/admin/AdminRulebookManagement.tsx).
