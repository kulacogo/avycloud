# OPS: BIN-Zuordnungen Gang 4, 5, 6 entfernen

> **Script ist fertig:** `backend/scripts/clear-bins-gang-4-5-6.js`
> **Ausführung:** Muss auf deinem Rechner oder in Cloud Shell laufen (braucht GCP Credentials).

## Sofort ausführen

```bash
cd backend
node scripts/clear-bins-gang-4-5-6.js
```

Das Script:
- Findet alle BINs in Gang 4, 5, 6 (Collection `warehouseBins`, `.where('gang', 'in', [4, 5, 6])`)
- Leert jede BIN (products → [], productCount → 0)
- Entfernt pro Produkt die BIN-Zuordnung (storage, storageBins) in der `products` Collection
- **Behält `inventory.quantity`** — Menge bleibt erhalten (Umzug, nicht Entnahme)
- Wählt neue primäre BIN falls Produkt in weiteren BINs ist
- Schreibt Warehouse-Events für Audit-Trail
- Zeigt Zusammenfassung am Ende

Danach: Artikel erscheinen automatisch in der Stow-Queue für Neueinlagerung.
