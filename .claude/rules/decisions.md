---
paths: []
---

# Architektur-Entscheidungen

## Warum products_v2 statt products?
Normalisierung war nötig für LLM-Konsistenz. Legacy `products` Collection ist read-only.
Alle Schreibpfade laufen über `saveProductV2()` in `lib/product-store.js`.

## Warum kein BaseLinker?
AvyCloud hat eigene Multichannel-Integrationen (eBay, Kaufland, SendCloud, SevDesk).
BaseLinker wurde März 2026 komplett entfernt (48 Dateien gelöscht, 40+ bereinigt).
Tenant TrendOcean nutzt AvyCloud OHNE BaseLinker.

## Warum CommonJS im Backend?
Historisch gewachsen. Cloud Run + Express Setup funktioniert stabil.
Vitest-Tests nutzen require.cache-Patching statt vi.mock() (CJS-Kompatibilität).

## OMS: Eigene Status-Engine statt Marketplace-Status
12-State Engine (pending → confirmed → picking → ... → completed/cancelled/returned).
Eigene Auftragsnummern (AVY-2026-{0001}).
eBay/Kaufland Status werden gemapped, nicht 1:1 übernommen.

## Design: Token-basiert, Dark Mode First
Alle Farben als CSS Custom Properties in styles/main.css.
Tailwind extended mit eigenen Token-Klassen. Kein raw Tailwind.
