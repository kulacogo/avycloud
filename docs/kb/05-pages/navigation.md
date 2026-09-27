---
title: Linke Navigation
for: [user, dev, agent]
lastReviewed: 2026-09-27
---

# Linke Navigation

Die Desktop-Seitenleiste bündelt die bestehenden Ansichten nach Arbeitsbereich. Alle 26 bisherigen Linknamen und Ziel-Hashes bleiben erhalten; die sichtbaren Einträge richten sich weiterhin nach `canAccessView()` und den persönlichen Rollenrechten. Es wurden keine Funktionen oder Zugriffsrechte entfernt. Die mobile Navigation bleibt unverändert.

| Bereich | Direkte Links | Unter „Weitere Funktionen“ |
| --- | --- | --- |
| Dauerhaft oben | Dashboard, Finanzen | — |
| Aufträge | Bestellungen, Retouren, Versand & Labels, Rechnungen | Einstellungen |
| Produkte | Produktdaten, Erfassen, Preise | Duplikate, Regeln |
| Lager | Inventar, Verwaltung | Einstellungen |
| Marktplätze | eBay, Kaufland, Listing-Fehler, Shop-Gesundheit | — |
| Einstellungen | Persönliche Daten, Unternehmensdaten, Mitarbeiter & Rollen, Integrationen, API, Plan & Abrechnung, Aktivitätsprotokoll | — |

Die Zusammenfassung basiert auf fachlichen Arbeitsabläufen, nicht auf gemessener Nutzungshäufigkeit. Daher werden keine bisherigen Ziele ersatzlos versteckt. Kontextgebundene „Einstellungen“ bleiben in Aufträge bzw. Lager. Finanzen bleibt auch ohne Benutzerverwaltungsrechte für berechtigte Konten erreichbar. Jede Gruppe wird nach den Rechten ihrer einzelnen Links gefiltert: beispielsweise bleibt Inventar mit Produkt-Leserecht erreichbar, auch wenn Lagerverwaltung gesperrt ist. Leere Gruppen erscheinen nicht.

## Persönliche Anzeige

- Beim ersten Besuch ist nur der Bereich der aktuellen Ansicht geöffnet. Bei Dashboard/Finanzen ist Aufträge der Ausgangspunkt; fehlt dieses Recht, bleibt die Gruppe unsichtbar. Ein erstmaliger Direktlink auf Regeln öffnet auch dessen Untergruppe.
- Danach werden alle offenen/geschlossenen Gruppen, Untergruppen und die schmale/breite Seitenleiste für das Konto im jeweiligen Browser gespeichert. Auch die anfänglichen Standardzustände werden festgehalten. Seitenwechsel oder erneuter Start überschreiben die Wahl nicht; ausdrücklich geschlossene aktive Gruppen bleiben geschlossen und sind farblich markiert.
- Schlüssel: `avycloud:sidebar:v2:` plus JSON `[Firebase-tenantId oder "", Firebase-uid]`. Keine E-Mail, Tokens oder Geschäftsdaten werden gespeichert. Keine Cloud-/Gerätesynchronisierung. Löschen der Browserdaten setzt die Auswahl zurück.
- Alte browserweit gemeinsame Schlüssel `avycloud:sidebar:collapsed` und `avycloud:sidebar:sections` werden nicht übernommen: ihre Kontozuordnung ist unbekannt. Sie bleiben unangetastet.
- Beschädigter/gesperrter/voller Speicher verhindert die Navigation nicht; ohne Speicherzugriff gilt die Wahl für die laufende Sitzung.
- In der schmalen Leiste gibt es einen Button pro Arbeitsbereich. Anklicken klappt die Leiste und diesen Bereich auf; die übrigen persönlichen Zustände bleiben erhalten.
- Buttons unterstützen Tastaturbedienung, `aria-expanded`/`aria-controls` und Fokusmarkierungen. Links behalten echte `href`-Ziele und den bisherigen Cmd-/Ctrl-/Shift-Klick.

## Implementierung und Prüfung

- `components/Sidebar.tsx`: Darstellung und kontogebundene React-State-Grenze (`key`), damit ein Kontowechsel keinen Zustand übernimmt.
- `utils/sidebarNavigation.ts`: Struktur, Rechtefilter, Alias-Markierung, validierte Speicherwerte und initiale Zustände.
- `utils/sidebarNavigation.test.ts`: vollständiger Namensbestand, Gruppierung, Rechte, Standardzustände, Neustart, Isolation und Speicherfehler.
- `utils/viewPermissions.test.ts` / `utils/viewTitles.test.ts`: zentrale Rechteentscheidung und Seitentitel weiterhin abgesichert; Navigationseinträge kommen jetzt aus dem Strukturmodul.
- `tools/navigation/sidebar.browser-test.mjs`: echte Sidebar mit lokaler Auth-Fixture; Kontowechsel, Reload, Direktlinks, Tastatur, schmale Leiste, Rechte, defekter Speicher, Hell/Dunkel und Scrollbarkeit. Kein App-Backend, externe Requests gesperrt.

Lokale Prüfung: `npm test`, `npm run build`, `./node_modules/.bin/tsc --noEmit`, danach `node --test tools/navigation/sidebar.browser-test.mjs`. Für Backend-Baselines immer isolierte Testumgebung gemäß Projektregeln verwenden.
