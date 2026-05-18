---
title: Code-Stil
for: [dev, agent]
lastReviewed: 2026-05-18
---

# Code-Stil

> Quelle der Wahrheit: [CLAUDE.md](../../../CLAUDE.md) §Code-Stil. Diese Seite ergänzt mit konkreten Beispielen.

## Backend

| Aspekt | Regel | Anker |
|--------|-------|-------|
| Modul-System | CommonJS (`require` / `module.exports`) — kein `import` | [backend/index.js](../../../backend/index.js) |
| Indentation | 2 Spaces, keine Tabs | — |
| Strings | Single Quotes (`'foo'`) — Template-Literals erlaubt | — |
| Async | `async/await`, kein `.then()`-Chain bei Mutationen | — |
| Error-Handling | `try/catch` mit strukturiertem Error (`{ statusCode, message }`); zentrale `errorHandler`-Middleware in [backend/lib/error-handler.js](../../../backend/lib/error-handler.js) (siehe Mount in [backend/index.js](../../../backend/index.js) Z. 258) | — |
| Top-of-File | `'use strict';` setzen (wie z. B. [backend/services/sync-event-bus.js](../../../backend/services/sync-event-bus.js)) | — |
| Logger | `console.log/warn/error` mit `[scope]`-Präfix (Bsp. `[order-sync]`, `[stock-failure-drain]`) | siehe gesamte Cron-Section in [backend/index.js](../../../backend/index.js) |
| Tenant | Jede neue Funktion mit DB-Zugriff nimmt explizit `{ tenantId }` als Argument — kein impliziter `'default'`-Fallback in neuem Code | [11-rules-and-invariants/tenant-propagation.md](../11-rules-and-invariants/tenant-propagation.md) |
| Stock-Writes | Nur via [backend/lib/warehouse.js](../../../backend/lib/warehouse.js) / [backend/lib/product-store.js](../../../backend/lib/product-store.js); kein `tx.update(productRef, { 'inventory.quantity': X })` an anderen Stellen | [CLAUDE.md](../../../CLAUDE.md) Punkt 13 |
| OMS-Writes | Nur via `transitionOrder()` in [backend/services/order-state-machine.js](../../../backend/services/order-state-machine.js) | [CLAUDE.md](../../../CLAUDE.md) Punkt 11 |

## Frontend

| Aspekt | Regel | Anker |
|--------|-------|-------|
| Sprache | TypeScript (ESM) | [tsconfig.json](../../../tsconfig.json) |
| Indentation | 2 Spaces | — |
| Strings | Double Quotes (`"foo"`) | — |
| Komponenten | Functional Components + Hooks | siehe `components/` |
| State | React-Query für Server-State; lokales `useState/useReducer` für UI-State; React Context für Auth/Theme/Tenant | siehe `hooks/` |
| Forms | `react-hook-form` für komplexere Forms | [package.json](../../../package.json) |
| Strikte TS-Settings | `strict: true`, `forceConsistentCasingInFileNames: true`, `isolatedModules: true` | [tsconfig.json](../../../tsconfig.json) |
| HTML-Sanitization | `dompurify` für jegliches KI-generiertes HTML im Datenblatt | [package.json](../../../package.json) |

## UI-Farben — Design-Tokens-only

Aus [CLAUDE.md](../../../CLAUDE.md):

> Nur Design-Tokens (`bg-accent`, nicht `bg-blue-500`). Siehe `styles/main.css`.

**Erlaubt**: `bg-accent`, `text-muted`, `border-subtle`, `bg-surface-0`, …

**Verboten** in neuem Code: rohe Tailwind-Farben wie `bg-blue-500`, `text-red-600`, `bg-gray-100`. Diese sind Theme-broken im Dark-Mode.

Die Token-Datei `styles/main.css` *(Annahme — Pfad aus [CLAUDE.md](../../../CLAUDE.md); muss verifiziert werden)* enthält die CSS-Variablen, die Tailwind via `tailwind.config` aufnimmt. Bei Unsicherheit über verfügbare Tokens: `grep -r 'bg-accent\|text-muted' components/` zeigt die heute genutzten.

## Tests

| Punkt | Regel |
|-------|-------|
| Pflicht | Jede neue Funktion braucht mindestens 1 Test (`vitest`). |
| Lage | `backend/__tests__/<name>.test.js` oder `backend/lib/<name>.test.js` neben dem Modul. |
| Naming | Datei `*.test.js` oder `*.test.mjs` (laut [backend/vitest.config.js](../../../backend/vitest.config.js)). |
| Sprache | Tests in JS (CommonJS) gegen das CommonJS-Backend. |
| Mocks | `vi.mock()` oder lokale Stubs; Firestore-Mock im Test-Setup. |

Detail: [testing.md](testing.md).

## Git

| Regel | Detail |
|-------|--------|
| Commit-Format | Conventional Commits: `feat: …`, `fix: …`, `refactor: …`, `chore: …`, `docs: …`, `test: …`. |
| Branch-Naming | `feat/<kurz>`, `fix/<kurz>`, `refactor/<kurz>`. |
| Force-Push auf `main` | **Verboten**. |
| `git rebase -i` | Vermeiden — schwer review-bar; lieber neuer Branch mit cherry-picks. |
| Merge auf `main` | Nur User/Operator. Coding-Agents committen + öffnen PRs, mergen NIE eigenständig. |

Detail: [commit-workflow.md](commit-workflow.md).

## Kommentare

- Erklären **warum**, nicht **was**. Code muss selbsterklärend sein.
- Keine narrativen Kommentare wie `// Import the module` oder `// Increment counter`.
- Trade-offs, Constraints, Bezug zu Incidents/Tickets dokumentieren — z. B. siehe [CLAUDE.md](../../../CLAUDE.md) Punkt 13 mit Verweis auf `SKU-0000108900`.
