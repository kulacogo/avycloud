---
paths:
  - "backend/**/*.js"
---

# Backend Rules

- CommonJS: `require()` / `module.exports`
- 2 Spaces, Single Quotes
- async/await, keine Callbacks
- Jeder Endpoint braucht try/catch:
  ```js
  try { /* logic */ } catch (err) {
    console.error(`[POST /api/example] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
  ```
- Produkt-Writes NUR über `saveProductV2()` aus `lib/product-store.js`
- Alle Firestore-Queries mit `tenantId` Filter
- Tests: Vitest mit require.cache-Patching (kein vi.mock für CJS). Siehe `__tests__/api/_patchGcp.js`, `_patchLocalModules.js`, `_setupMocks.js`
- BaseLinker: TABU — keine Imports, keine Referenzen
