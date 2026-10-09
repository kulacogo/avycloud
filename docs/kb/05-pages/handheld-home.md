---
title: Handheld-Startseite
for: [dev, agent, admin]
lastReviewed: 2026-10-07
---

# Handheld-Startseite

`components/HandheldHome.tsx`, eingebunden in `App.tsx` für mobile Nutzer mit Pick- oder Packberechtigung. Sonstige Rollen behalten `AnalyticsDashboardMobile`; Desktop unverändert.

Inhalt: heute versendete Aufträge, eigener fortsetzbarer Pickauftrag, Picken und Packen mit berechtigungsgesteuerten Schaltflächen. Daten aus `fetchOperationalMetrics({preset:'today'})` und `fetchPickWork()`, Aktualisierung alle 30 Sekunden. Unbekannte Zahlen erscheinen als „—“ und Abruffehler werden sichtbar; es werden keine Nullwerte erfunden. `confirmed` zählt wartende Picks, `picked` die zum Packen bereitstehenden Aufträge.

Kein Finanzbericht und keine Marktplatztabelle in dieser Arbeitsansicht. Die Operationsauswahl führt zusätzlich zu Identifizieren und Einlagern. Details: [Handheld Pick/Pack](../06-features/handheld-pick-pack.md).
