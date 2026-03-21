# P2 Bugs — Batch 2: Error Handling (B030, B031, B035)

> Fehlende Error-Catches und Typ-Mismatches in OMS-Komponenten.

## Prompt für Claude Code:

```
Lies CLAUDE.md und TASKS.md. Dann fixe diese 3 Error-Handling-Bugs in Branch `fix/p2-error-handling`:

## B-030: ShippingView 60s Polling ohne Error-Catch
Datei: components/orders/ShippingView.tsx
Problem: useEffect mit setInterval (60s) für Auto-Sync hat kein Error-Handling. Bei API 500 → Fehlermeldungen alle 60s. Kein Backoff, kein Stop.
Fix:
1. Wrape den Sync-Call in try/catch
2. Zähle consecutive Fehler: `errorCountRef.current++`
3. Nach 3 Fehlern: clearInterval, zeige Toast "Auto-Sync pausiert. Manuell aktualisieren."
4. Bei erfolgreichem Sync: errorCountRef.current = 0
5. Cleanup: clearInterval im useEffect return

## B-031: OrderDetail nextStatuses Typ-Mismatch
Datei: OrderDetail.tsx (oder wo OrderDetail definiert ist)
Problem: Backend liefert nextStatuses: string[], Frontend erwartet {status, label}[]. Dropdown zeigt leere Einträge.
Fix:
1. Finde wo nextStatuses verarbeitet wird
2. Wenn es ein string[] ist: mappe auf { status: s, label: OMS_STATUS_LABELS[s] || s }
3. Nutze die bereits existierenden OMS_STATUS_LABELS aus OrdersView.tsx
4. Falls OMS_STATUS_LABELS nicht exportiert ist → exportiere sie als shared constant

## B-035: ProcessReturn Dialog ohne Error-Handling
Datei: ReturnsView.tsx
Problem: processReturn() API-Call hat kein try/catch. Bei Backend-Fehler bleibt der Dialog im Loading-State.
Fix:
1. Wrape den processReturn-Call in try/catch
2. Im catch: addToast("error", `Fehler: ${err.message || "Retoure konnte nicht verarbeitet werden."}`)
3. Im finally: setze Loading-State auf false, schließe Dialog NICHT bei Fehler
4. WICHTIG: addToast Signatur ist (variant: string, message: string) — KEIN Objekt!

Danach: npm run build. Commit: `fix: P2 error handling — polling backoff, type mismatch, return dialog`
```
