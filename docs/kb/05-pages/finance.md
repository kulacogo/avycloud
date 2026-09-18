---
title: Finanzdashboard
for: [user, dev, admin]
lastReviewed: 2026-09-18
---

## Zweck

Finanzzahlen auf einen Blick: Umsatz, vorläufiges Ergebnis, Marge, Bestellwert, Verkaufsverlauf, Geldeingang, Kosten und Marktplätze. Zeitraum-Presets oder explizit angewendeter eigener Datumsbereich. Chart zwischen Umsatz und Bestellanzahl umschaltbar; alternativ Tabelle, auswählbare Tage und aufklappbare Marktplatzdetails. Gebühreneditor und Datengrundlage bleiben aufklappbar.

## Komponente(n)

`components/admin/AdminFinancials.tsx`; Darstellung/Basisprüfung in `utils/financeDashboard.ts`, Regressionen in `utils/financeDashboard.test.ts`. Bestehender View `finance`; keine neue Route.

## API-Calls

Bestehende `fetchFinancialReport` und `saveFinancialCostModel`. Backend-Berechnung und Persistenz unverändert. Späte Antworten eines vorherigen Zeitraums dürfen den aktuellen Zeitraum nicht überschreiben.

## Datenquellen

Finanzreport aus Orders, Produkten, Losen und `warehouseEvents`, Tenant-Kostenmodell, Marktplatz-Snapshots und optionalen Abrechnungs-/Bankdaten.

## Wichtige Edge-Cases

- P&L-Werte übernehmen die vom Backend ausgewiesene Netto-/Bruttobasis. Die Zeitreihe und Marktplatz-Umsätze sind Brutto und entsprechend beschriftet.
- Unbekannte Werte sind `—`/`Offen`, keine erfundene Null. Fehlender Wareneinsatz unterdrückt Ergebnis und Marge. Fehlende Versandkosten, geschätzte Gebühren oder teilweise Einkaufszuordnung kennzeichnen das Ergebnis als vorläufig.
- Negative Ergebnisse bleiben sichtbar. Tatsächliche Auszahlungen werden nicht mit errechneten Kosten vermischt.
- Lagerkennzahlen sind aktueller Bestand, keine historische Bestandsbewertung zum ausgewählten Datum.
- Fehlende Bank-/Auszahlungsdaten werden sichtbar gekennzeichnet.

## Bekannte Issues

Keine neue Backend-Finanzberechnung in diesem UI-Paket. Fachliche Datenlücken werden aus dem Report angezeigt.

## Gestaltungsgrundlagen

[Microsoft: Dashboard design tips](https://learn.microsoft.com/en-us/power-bi/create-reports/service-dashboards-design-tips): Kennzahlen priorisieren, Ablenkung reduzieren, Vergleiche nachvollziehbar machen. Die Umsetzung nutzt bestehende AvyCloud-Tokens für hell/dunkel und eine tabellarische Alternative zu Diagrammen.
