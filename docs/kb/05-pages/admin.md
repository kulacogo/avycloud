---
title: Admin (Produkte-Tabelle & Admin-Panel)
for: [user, dev, admin]
lastReviewed: 2026-09-21
---

## Zweck

Zwei verwandte aber separate Admin-Bereiche:

1. **AdminTable** (`view: 'admin'`) — Master-Produkt-Tabelle für Bulk-Bearbeitung: alle Produkte mit konfigurierbaren Spalten-Presets, Inline-Edit (`useGridEdit`), Bulk-Updates (`useBulkUpdate`), eBay-/Kaufland-Publish, Stock-Sync-Force, K-Type-Upload (KFZ-Fahrzeug-Daten).
2. **AdminPanel** (intern via Tabs in `view: 'admin'` Sub-Route — siehe Routing in App.tsx) — Tenant-Administrations-UI mit Tabs: **Users / Roles / LLM / Bulk / Integrations / eBay-Taxonomy / Identify-Runs** (Alt-Gruppenverwaltung aus der Oberfläche entfernt).

## Komponente(n)

- [components/AdminTable.tsx](../../../components/AdminTable.tsx) — Master-Produkt-Tabelle (Desktop-Centric, mit Mobile-Fallback über `addMediaQueryListener`).
- [components/admin-table/](../../../components/admin-table/) — Sub-Komponenten:
  - `AdminTableHeader.tsx`, `AdminTableRow.tsx`, `AdminTableFilters.tsx`, `BulkActions.tsx`, `BulkDiffPreview.tsx`, `BulkUpdateModal.tsx`, `EditableCell.tsx`.
- [components/admin/AdminPanel.tsx](../../../components/admin/AdminPanel.tsx) — Tab-Container für Admin-Sub-Bereiche.
- [components/admin/AdminUserManagement.tsx](../../../components/admin/AdminUserManagement.tsx) — User-Liste, Invite, Role-Assign.
- `AdminGroupManagement.tsx` ist historischer Code, kein aktiver Team-Tab.
- [components/admin/AdminRoleManagement.tsx](../../../components/admin/AdminRoleManagement.tsx).
- [components/admin/AdminLlmManagement.tsx](../../../components/admin/AdminLlmManagement.tsx) — LLM-Model-Selection / Feature-Flag-UI.
- [components/admin/AdminBulkActions.tsx](../../../components/admin/AdminBulkActions.tsx) — `/api/admin/bulk/run` UI mit DryRun-first.
- [components/admin/AdminIntegrations.tsx](../../../components/admin/AdminIntegrations.tsx).
- [components/admin/AdminEbayTaxonomy.tsx](../../../components/admin/AdminEbayTaxonomy.tsx) — eBay-Kategorie-Cache-Browser.
- [components/admin/AdminIdentifyRunsDashboard.tsx](../../../components/admin/AdminIdentifyRunsDashboard.tsx) — Identify-Run-Aggregate.
- [components/admin/AdminProductCoverageDashboard.tsx](../../../components/admin/AdminProductCoverageDashboard.tsx).
- [components/admin/AdminRulebookManagement.tsx](../../../components/admin/AdminRulebookManagement.tsx).
- [components/admin/AdminJobsManagement.tsx](../../../components/admin/AdminJobsManagement.tsx).

## API-Calls

AdminTable:
- `fetchProducts()` — Vollabzug.
- `runProductBulkAction(action, payload)` / `getProductBulkJob(jobId)` — `/api/products/bulk/run` und Job-Poll (`/api/products/bulk/jobs/{jobId}`).
- `deleteProductsBulk(productIds)`.
- `openProductLabelBatchWindow(productIds)`.
- `assignInventoryToProducts(productIds, inventoryId)`.
- `uploadKTypeCsv(file)` — KFZ-K-Type-Mappings hochladen.
- `bulkVerifyEbayPublish(productIds)`, `bulkPublishToEbay(productIds, overrides)`.
- `fetchEbaySkuIndex()`, `lightSyncEbayLiveListings(payload)`, `bulkUpdateEbayListings(updates)`.
- `fetchKauflandSkuIndex()`, `syncKauflandListings()`.

AdminPanel:
- `adminListUsers()`, `adminInviteUser(payload)`, `adminSetUserRoles(uid, roles)` (AdminUserManagement).
- `adminRunBulkAction(payload)`, `adminGetBulkJob(jobId)` (AdminBulkActions).
- Weitere Admin-Endpunkte pro Sub-Tab (Groups, Roles, LLM, eBay-Taxonomy) — siehe jeweilige Komponente.

Pro-Endpunkt-Doku: `docs/kb/09-api/admin.md`, `docs/kb/09-api/products.md` (TBD).

## Datenquellen

- AdminTable: lokaler `useState`-Produktcache + `InventoryContext`; **kein** React-Query für die Hauptliste.
- `useGridEdit` ([hooks/useGridEdit.ts](../../../hooks/useGridEdit.ts)) — Inline-Edit-Logic mit Dirty-Tracking.
- `useBulkUpdate` ([hooks/useBulkUpdate.ts](../../../hooks/useBulkUpdate.ts)) — Bulk-Diff-Preview + Apply.
- `useAuth` für RBAC-Sichtbarkeit Admin-Tabs.
- `useInventoryContext` für Inventory-Mapping.

## Wichtige Edge-Cases

- **Empty-State**: keine Produkte → Empty-State im Table-Body.
- **Loading**: lokaler Spinner während Initial-Fetch und Bulk-Action.
- **Error**: `Notice` + `ConfirmDialog` für destruktive Aktionen.
- **Bulk-Jobs (async)**: nach `runProductBulkAction` wird `jobId` zurückgegeben und über `getProductBulkJob` gepollt. UI zeigt Progress.
- **K-Type-Upload**: CSV-Validation client-seitig (Größe, Encoding); Backend macht Re-Validation und Diff-Report.
- **Mobile-Fallback**: `addMediaQueryListener` schaltet auf gestapeltes Layout um.
- **Admin-Bulk-Aktionen (z. B. `recategorize_v2`)**: DryRun-first (`apply: false`), Pre-/Post-Count-Guard (Toleranz 10), `MIN_APPLY_CONFIDENCE = 0.8` — siehe CLAUDE.md Admin Bulk-Actions.
- **Manuelle Kategorie-Source-Protection**: `details.categorySource === 'manual'` wird in Bulk-Aktionen geskippt.
- **UI-Source-Protection**: `ops.last_saved_source === 'ui'` wird in Bulk-Aktionen geskippt (außer `includeUi: true`).

## Bekannte Issues

- [TASKS.md](../../../TASKS.md) — **BUG-082** ~1084 Ghost-Produkte in `products_v2` (P0, offen) — sichtbar in AdminTable als nicht-gepublishte Produkte ohne Bestand.
- **BUG-084**/**BUG-085** Dual-Write-Probleme (✅/Code-Fix) — Auswirkungen sichtbar bei AdminTable-Edits.
- **CLAUDE.md Admin Bulk-Actions** — bei jeder neuen Bulk-Action: DryRun, Pre-/Post-Count-Guard, MIN_APPLY_CONFIDENCE, manual-skip, UI-skip dokumentieren.

## Mitarbeiter & Rollen — Zugriffsprofile (19.09.2026)

`#/settings/team` enthält Mitarbeiter, Leistung und Rollen & Rechte. Ein Konto erhält genau ein Profil. Die Rollenübersicht zeigt sechs Profile; seit 21.09. ist die serverseitige Matrix pro Rolle bearbeitbar. Keine Gruppenregisterkarte, keine addierten Altrollen oder Einzel-Ausnahmen. Das Inhaberprofil ist für andere Konten nicht auswählbar. Deaktivierte Konten sind sichtbar gekennzeichnet.

Der Bereich ist ausschließlich für den Inhaber zugänglich, einschließlich direkter Hash-Aufrufe. Die Profile wurden am 20.09.2026 mit PR #9 produktiv ausgeliefert. Fachliche Regeln: [Zugriffsprofile](../../features/access-profiles/spec.md).


## Interaktive Teamverwaltung (20.09.2026)

- **Mitarbeiter:** Profilkarten mit tatsächlichem Zugangsstatus, Namens-/E-Mail-Suche (auch ohne türkische Sonderzeichen), Filter für operative Konten, Lesezugriff, deaktivierte Konten und einzelne Profile. Einladen und Bearbeiten in fokussierten Dialogen; Profilwechsel zeigt vorher/nachher. Löschen bleibt bestätigt und ist für Inhaber/eigenes Konto nicht angeboten. Der Status ist keine Online-Anzeige.
- **Leistung:** Gesamtbeitrag je Konto in Punkten und Teamanteil; Rohzahlen erst nach Auswahl in den Kontodetails. Teamweite Kennzahlen bleiben informative Summen. Suche, Sortierung nach Beitrag/Name und Tätigkeitsfilter. Heute, letzte 7/30 Tage oder eigener Zeitraum; Datumsgrenzen in UTC, eigener Zeitraum erst nach vollständiger Eingabe und „Anwenden“. Vom Mitarbeiterprofil direkt zu dessen Details. Betriebliche Aufwandsstufen: Produktpflege ×4, Erfassen mit Fotos ×3, Verpacken/Wiegen ×2, Kommissionieren und einfache Einlagerungsbuchung ×1. Keine Arbeitszeit-, Qualitäts- oder Zielerfüllungsnote.
- **Rollen & Rechte:** Seit 21.09. kompakte Rollenauswahl mit einzelnen Berechtigungsschaltern und Suche. Speichern/Verwerfen bei Änderungen; Voraussetzungen werden gemeinsam geschaltet. „Konten ansehen“ öffnet den passenden Mitarbeiterfilter.
- Filter/Zeitraum bleiben beim Registerwechsel erhalten. Native Dialoge, Tastaturnavigation der Register und responsive Detailposition. Design-Tokens für Hell/Dunkel.
- Datenabfragen über bestehende APIs; gemeinsam zwischengespeichertes Kontoverzeichnis, keine zusätzliche Datenquelle. Leistungs-/Rollenabfragen nur bei geöffnetem Register, kein periodisches Polling. Ladefehler zeigen Wiederholungsaktionen und keine erfundenen Nullwerte oder Rechte.

**Datengrenzen:** Erfasst/Produktpflege zählen eindeutige Produkte je Konto; Einlagerung zählt Buchungen, Pick/Pack zählen Vorgänge. Historische gemeinsame Konten werden nicht rückwirkend Personen zugerechnet. Erfassen und spätere Produktpflege werden eigenständig bewertet; der frühere Überschneidungsabzug ist fachlich verworfen. Datenaufbereitung zählt einmal je Produkt/Konto bei belegter inhaltlicher Vorher/Nachher-Änderung oder einem Statuswechsel zu Bereit. Inhaltsänderungen und Freigaben erscheinen als getrennte Nachweise; geändert heißt nicht vollständig kontrolliert. Automatische Erfassungsdefaults/Registry-Ergänzungen, Übernahme-/Preis-Saves und reine Foto-/Barcode-/Gewichtsänderungen zählen nicht. Bloßes Öffnen des Bearbeitungsmodus/unverändertes Speichern zählt nicht. Original-Speicherzahlen und neu protokollierte Bereit-Abschlüsse stehen in den Details. Frühere reine Prüfungen ohne Änderung sind nicht nachträglich belegbar. Historische/deaktivierte Konten erhalten keine persönliche Bewertung und gehören nicht zum Nenner des Teamanteils. Dieser bleibt bei Suche/Filter unverändert. Backend-Protokollabfragen sind begrenzt; additive `dataQuality` weist Fehler und nicht sicher abgedeckte Zeiträume aus. Ohne bestätigte Abdeckung aller Quellen, Beitragsschema 3 und geladenes Kontoverzeichnis keine Gesamtpunkte/Rangfolge. Fehlende Quellen zeigen Striche statt Null. Ein Wert von 0 beweist keine Untätigkeit. Autorisierung unverändert.

Implementierung: [MitarbeiterRollen](../../../components/admin/MitarbeiterRollen.tsx), [Darstellungslogik und Tests](../../../components/admin/teamWorkspaceModel.test.ts). Übergabe/Prüfung: [Teamoberfläche](../../features/team-workspace/spec.md).

## Support im Leistungsbereich

Seit dem Support-Nachtrag zeigt Leistung zusätzlich die Quellenabdeckung von Kaufland-Tickets/eBay-Nachrichten und ordnet Händlerantworten der bestätigten Alleinzuständigkeit zu. Einzelzahlen erst nach Auswahl; fehlende Quellen führen zu Teilbeitrag ohne Rangfolge. Admin kann eBay-Nachrichten freigeben und anschließend Support aktualisieren. Bewertungsregel, Grenzen und Einrichtung: [Team-Spezifikation](../../features/team-workspace/spec.md#kundensupport--nachtrag-20092026).

### Kompakte Leistung (20.09.2026)

Die Leistungsansicht zeigt Kennzahlen und eine Tätigkeitstabelle statt permanenter Erklärungstexte. Supportquellen stehen als kleine Statusanzeigen neben dem Zeitraum; Einzelwerte nur bei der ausgewählten Person. „Datenaufbereitung · Details“ und „Berechnung“ öffnen Nachweise/Methodik bei Bedarf. Fehler/Teilabdeckung bleiben direkt erkennbar. Rechenregeln und Quellen unverändert.

## Rollen & Rechte seit 21.09.2026

Kompakte Rollenauswahl, Suche und einzelne Berechtigungsschalter. Änderungen bleiben bis „Rechte speichern“ Entwurf; „Verwerfen“ verwirft sie. Die neue Matrix gilt für alle Konten dieser Rolle. Nötige Workflowrechte werden gemeinsam ein-/ausgeschaltet. Administrator bleibt fest beim Inhaber; Konten- und Rechteverwaltung sind nicht delegierbar. Manager dürfen standardmäßig Rechnungen erstellen und korrigieren.
