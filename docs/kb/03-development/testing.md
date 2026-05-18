---
title: Testing
for: [dev, agent]
lastReviewed: 2026-05-18
---

# Testing

> Geprüfte Quelle: [backend/vitest.config.js](../../../backend/vitest.config.js), [backend/package.json](../../../backend/package.json).

## Framework

Vitest (Backend) — `vitest ^4.0.18` aus [backend/package.json](../../../backend/package.json). `supertest ^7.2.2` für HTTP-Tests gegen Express-Router.

Frontend hat heute **keine** aktive Unit-Test-Suite im geprüften Code-Pfad. `playwright` ist als devDependency installiert *(Annahme: Smoke-Skripte oder geplante E2E; muss verifiziert werden)*.

## Konfiguration

[backend/vitest.config.js](../../../backend/vitest.config.js):

```js
{
  test: {
    globals: true,
    environment: 'node',
    pool: 'threads',
    include: ['**/*.test.js', '**/*.test.mjs', '**/__tests__/**/*.js', '**/__tests__/**/*.mjs'],
    exclude: [
      'node_modules',
      'scripts',
      'lib/ebay-trading-api.test.js',
      'services/pick-hints.test.js',
      '**/__tests__/**/_*.js',
      '**/__tests__/**/_*.mjs',
    ],
    testTimeout: 10000,
    server: { deps: { inline: ['p-queue'] } },
  },
}
```

| Eigenschaft | Wert |
|-------------|------|
| Global Test APIs | `true` (kein expliziter `import { describe } from 'vitest'` nötig) |
| Environment | `node` |
| Pool | `threads` |
| Test-Timeout | 10 000 ms |
| `p-queue` | Inline-Resolved (CJS-Compat) |
| Excludes | `lib/ebay-trading-api.test.js`, `services/pick-hints.test.js`, alle `_*`-prefixed Test-Files (skip-Pattern), gesamtes `scripts/`-Verzeichnis, `node_modules`. |

## Test-Verzeichnisse

| Pfad-Pattern | Inhalt |
|--------------|--------|
| `backend/__tests__/*.test.js` | Integration- und High-Level-Tests (Stock-Invarianten, OMS-State-Machine, Drain-Worker, eBay-Auto-Fix, etc.). |
| `backend/lib/*.test.js` (selten — wenige) | Unit-Tests neben dem Modul. |
| `backend/services/*.test.js` (selten) | Unit-Tests neben dem Service. |

Beispiel-Tests die Invarianten schützen (Auszug aus [docs/architecture/stock-single-source-of-truth.md](../../architecture/stock-single-source-of-truth.md) §Tests):

- `backend/__tests__/stock-pick-then-ship-no-double-decrement.test.js`
- `backend/__tests__/stock-shipped-idempotency.test.js`
- `backend/__tests__/stock-failure-drain.test.js`
- `backend/__tests__/stock-change-events.test.js`
- `backend/__tests__/oversell-invariant.test.js`

## Skripte

```bash
cd backend

# Single-Pass
npm test

# Watch-Mode
npm run test:watch

# Verbose
npm test -- --reporter=verbose

# Single File
npm test -- backend/__tests__/stock-pick-then-ship-no-double-decrement.test.js

# Single Test (mit -t)
npm test -- -t 'pick-then-ship'
```

## Mocking-Pattern

Aus den Test-Files (beobachtbar im Repo):

| Mock-Ziel | Pattern |
|-----------|---------|
| Firestore | Test-Helper liefert in-memory Mock; `vi.mock('../lib/firestore', () => …)` |
| Gemini-Calls | `vi.mock('../lib/gemini3-client', () => ({ callGemini3: vi.fn().mockResolvedValue(...) }))` |
| Marketplace-APIs | dedizierte Test-Doubles unter `backend/__tests__/_doubles/*` *(Annahme — muss verifiziert werden)* |
| Time | `vi.useFakeTimers()` für Debounce-/Cron-Tests |

Konkrete Beispiele:

- Stock-Lock-Test: `backend/__tests__/stock-shipped-idempotency.test.js` (mit Firestore-Tx-Mock).
- Webhook-Test: `backend/__tests__/sendcloud-webhook.test.js` *(Annahme — Datei-Existenz muss verifiziert werden)*.

## Neue Tests aufbauen

Empfohlene Vorlage:

```js
'use strict';

const { describe, it, expect, beforeEach, vi } = require('vitest');

vi.mock('../lib/firestore', () => ({ /* mock object */ }));

describe('myFeature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes to the correct collection', async () => {
    const { myFeature } = require('../services/my-feature');
    const result = await myFeature({ tenantId: 'test-tenant' });
    expect(result).toMatchObject({ ok: true });
  });
});
```

Checkliste:

- [ ] Datei-Naming `*.test.js` (innerhalb erlaubter Pfade).
- [ ] Tenant in jeden DB-Aufruf explizit.
- [ ] Mock-Reset in `beforeEach`.
- [ ] Sad-Path testen (Fehler-Branch).
- [ ] Bei Stock-Mutation: assertion auf `notifyStockChange()` + `inventory_ledger`-Eintrag.

## CI-Status

Aktuell läuft `npm test` **nicht** im CI-Pipeline ([.github/workflows/firebase-hosting.yml](../../../.github/workflows/firebase-hosting.yml) macht nur `npm run build` für Frontend; [backend/cloudbuild.yaml](../../../backend/cloudbuild.yaml) macht nur Syntax-Smoke `node --check`). Das ist ein bekannter Gap — siehe [04-deployment/cicd-pipeline.md](../04-deployment/cicd-pipeline.md) §Gaps.

> **Konsequenz für Coding-Agents**: `cd backend && npm test` MUSS lokal grün laufen, bevor du committest. Niemand fängt es im CI.

## Verweise

- Pre-Flight + Post-Flight: [AGENTS.md](../../../AGENTS.md).
- Commit-Workflow: [commit-workflow.md](commit-workflow.md).
- CI-Pipeline: [04-deployment/cicd-pipeline.md](../04-deployment/cicd-pipeline.md).
