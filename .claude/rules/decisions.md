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

## Warum zentrale Stock-Sync statt direkter API-Calls?
Nach der BaseLinker-Entfernung März 2026 fehlte der zentrale Multichannel-Broadcast. Im April 2026 führte das zum Oversell-Incident (SKU-9871561937, TrendOcean): Kaufland verkauft, eBay blieb aktiv mit positivem Bestand. Root-Cause war eine unterbrochene Retry-Schleife — `stock_operation_failures` wurde geschrieben, aber nie wieder gelesen.

Seitdem gilt als Architektur-Prinzip:
- Single Source of Truth ist `products_v2.inventory.quantity`
- Jede Stock-Mutation läuft über `saveProductV2()` UND emittiert `stock:changed`
- Marketplace-Syncs in `stock-sync-dispatcher.js` sind idempotent
- Fehlgeschlagene Syncs werden in `stock_operation_failures` persistiert UND von `stock-failure-drain.js` alle 2 Minuten automatisch retried (max 5 Versuche, dann `abandoned` + Alert)
- Periodische Reconciliation (`stock-reconciliation.js`) gleicht alle 30 min (Cold) bzw. 5 min (Hot-SKUs der letzten 24 h) mit den Marktplätzen ab
- Distributed Lock via Firestore (`stock_locks` Collection) verhindert konkurrierende Mutationen über Cloud-Run-Instanzen hinweg

## Warum kein omsStatus-Direct-Write im Marketplace-Intake?
Früher schrieben `order-intake-kaufland.js` / `order-intake-ebay.js` `order.omsStatus` direkt via `orderRef.update()`. Problem: Der Event-Bus hörte aber nur auf `order:status_changed`, und genau das wurde nicht emittiert → `_onOrderShipped` lief nicht → kein Decrement, kein Marketplace-Broadcast. Seitdem: Jeder Status-Übergang läuft durch `transitionOrder({ force: true, source: '...-intake' })` (`services/order-state-machine.js`). `force: true` umgeht die Transition-Whitelist für Legacy/Out-of-Order-Events.
