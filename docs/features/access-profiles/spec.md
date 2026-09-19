# Rollen und Rechte — Stand 19.09.2026

Status: implementiert und lokal geprüft auf `codex/roles-permissions-20260919`, Basis `4aa3b0ca` (PR #8). **Commit und kontrollierte Produktivauslieferung durch „ok los“ am 19.09.2026 freigegeben; Rollout wartet auf Mahmouds Zielprofil.** Die Auth-/RBAC-Änderungen wurden durch die ausdrückliche Nutzeranforderung vom 19.09.2026 autorisiert.

## Auftrag und tatsächliche Ursache

Oguz ist der einzige Administrator. Efe und Yasemin sind Manager; Hüseyin und Semih Mitarbeiter; Fatih und Selahattin Partner. Die Mitarbeiter müssen mit persönlichen Konten arbeiten, damit Aktionen und Leistung zurechenbar sind. Scanner Support soll nicht mehr genutzt werden. Ops Dev ist ein künftiges Entwicklerkonto mit breitem Lesezugriff, ohne sensible Unternehmensbereiche.

Produktiver Lesebefund: neun Konten, keine Gruppen, zehn historische Rollen. Mehrere Konten besaßen bis zu neun additive Rollen einschließlich `admin`. Die gespeicherten Rollen waren gegenüber den Code-Defaults verändert: Lager & Versand enthielt u. a. Rechnungs- und Erstattungsrechte. Änderungen an Defaults hätten vorhandene Rollen ohnehin nicht korrigiert, weil der Seeder nur fehlende Dokumente anlegt.

Konkreter Arbeitsfehler: Gewicht speichern, Versandlabel und Druckauftrag verlangten `orders.write`. Die Mitarbeiterprofile hatten nur `pick`, `pack`, `ship`, `edit`. Sie konnten damit trotz vermeintlicher Versandberechtigung nicht vollständig arbeiten.

## Verbindliche Zuordnung

| Konto | Neues Profil | Umfang |
|---|---|---|
| admin@ / Oguz | Administrator | Alle Bereiche und Änderungen; einziges Inhaberkonto |
| Efe, Yasemin | Manager | Vollständige operative Arbeit, Auftragskorrekturen, operative Regeln, Lager-/Versandkonfiguration, Produktlöschung |
| Hüseyin, Semih | Mitarbeiter | Erfassen, Produktpflege, Lagerbuchungen, Pick, Pack, Gewicht, Versand und Etikettendruck |
| Fatih, Selahattin | Gesellschafter / Partner | Operative Daten und Finanzberichte/Rechnungen lesen; keine Änderungen |
| operation@ / Ops Dev | Entwickler · Lesen | Operative Daten, operative Konfiguration und technische Diagnose lesen; keine Änderungen |
| support@ / Scanner Support | Deaktiviert | Kein Zugang; persönliche Konten nutzen |
| Neue reine Lesekonten | Nur Lesen | Operative Daten; keine Finanzen oder Änderungen |

Partner behalten den schon bestehenden Finanz-Leseumfang der bisherigen Betrachterrolle. Manager, Mitarbeiter und Entwickler erhalten keine Finanzberichte, Rechnungsänderungen, Erstattungsfreigaben, Unternehmens-/Zugangskonfiguration oder Rechteverwaltung. Verkaufspreise, Auftragsbeträge und Versandtarife sind operative Daten. Einkaufskosten, interne Bewertungen und Marktplatz-Abrechnungsfelder werden für diese Profile aus JSON-Antworten und dem Produktstream entfernt. Finanzexporte erfordern Finanzleserechte. Kostenänderungen werden einschließlich Bulk-/Import-Mappings abgewehrt.

Retourenannahme/Notizen bleiben operativ. Die bisherige gemeinsame Funktion „Prüfen und Erstattung entscheiden“ enthält bereits eine Finanzentscheidung; diese Funktion und Erstattungs-Statusänderungen sind dem Admin vorbehalten. Der unabhängige physische Wareneingang bleibt über Lagerbuchungen möglich. Keine Änderung an Stock-, OMS- oder Refund-Engine.

## Autorisierung und Oberfläche

- `backend/lib/access-profiles.js` ist die einzige Berechtigungs-Policy. Sechs klar benannte Profile; genau eines pro Konto. Die Rechte sind als geprüfte Profile festgelegt und werden nicht mehr über beliebige Checkboxkombinationen verbogen.
- Neues additives Feld `users.accessRole`, dazu `accessPolicyVersion` und `tenantId`. Alte Rollenarrays, Overrides, Gruppen und Rollendokumente sind keine Autorisierungsquelle mehr. Sie bleiben ausschließlich für eine kontrollierte Rückkehr des Codes gespeichert; die Nutzeroberfläche zeigt sie nicht.
- Nur die verifizierte Bootstrap-Inhaberidentität (`AUTH_BOOTSTRAP_ADMIN_EMAIL`, derzeit admin@) erhält Admin. Ein gespeichertes `admin`-Profil, eine Gruppe oder eine alte Wildcard kann keinen zweiten Admin schaffen. Der Inhaber kann nicht herabgestuft/gelöscht werden.
- Gesperrte Profile werden bereits bei Authentifizierung geprüft, einschließlich Endpunkten ohne zusätzliches RBAC-Gate. Der Auth-Lesevorgang wird im nachfolgenden RBAC-Check wiederverwendet. Rechtefehler liefern einen sichtbaren, wiederholbaren Fehler statt einer vermeintlich erfolgreichen leeren Rolle.
- Gewicht allein nutzt `orders.pack`; gemischte Änderungen (z. B. Adresse) benötigen `orders.edit`. Labels und Druck verwenden `orders.ship`. `orders.write` bleibt operative Konfiguration; Lagerstruktur erhält `warehouse.configure`.
- Finanz-Dashboard, Kostenmodell, Rechnungsaktionen und die Refund-Sammelaktion sind explizit abgesichert. Allgemeine Dashboard-Zählwerte werden ohne Finanzfelder ausgeliefert.
- `utils/viewPermissions.ts` steuert Sidebar, Header, mobile Navigation und direkte Seitenaufrufe gemeinsam. Entwickler dürfen Diagnose sehen, ohne Personal-/Finanz-/Zugangskonfiguration zu erhalten.
- Mitarbeiteransicht: Einzelwahl, verständliche Beschreibungen, eindeutiger Deaktiviert-Status. Rollenübersicht: echte serverseitige Rechtematrix. Gruppen und veraltete Rollenangaben entfallen.

## Prüfungen

- Backend unter Node 20.19.5: **5.214 Tests / 448 Dateien grün**.
- Frontend: **461 Tests grün**; `tsc --noEmit` und `npm run build` grün.
- Neuer HTTP-Integrationstest verwendet echte Express-Routen und die echte RBAC-Auflösung; nur Firebase/Firestore und externe Versanddienste sind Test-Doubles. Mitarbeiter: Packen → Gewicht schreiben → Label → Druckauftrag. Mitarbeiter-ID wird an Pack-/OMS-Übergänge weitergereicht.
- Gegenprüfungen: eingeschmuggelte Adressänderung, ungültiges Gewicht, fremder Tenant, deaktiviertes Konto, Alt-Adminrolle/Override, Verwaltungs-APIs, Finanz-APIs und Refund-Nebenpfade.
- Browserprüfung mit isolierten lokalen Testidentitäten/-daten: Rollenmatrix, Einzelwahl, direkte Aufrufsperren für Mitarbeiter/Partner/Entwickler, mobile Packansicht. Kein Zugriff auf echte Versanddienste, kein reales Label und kein physischer Druck bei diesen Tests.
- Produktionsmigration ausschließlich im **Trockenlauf** gegen `avycloud` geprüft; alle neun Identitäten eindeutig. Keine Produktionsschreibzugriffe.

## Sichere Auslieferung — Reihenfolge verbindlich

1. Geprüften Branch reviewen; explizite Commit-/Merge-Anweisung liegt durch „ok los“ vom 19.09.2026 vor (AGENTS.md). Bei weiteren Änderungen betroffene Tests wiederholen. Keine ungeprüften anderen Worktrees mitnehmen.
2. Vor dem Push/Merge, der automatisch deployed: aktuellen Benutzerstand erneut prüfen und Migrations-Trockenlauf durchführen:
   `node backend/scripts/migrate-access-profiles.js --project avycloud`
3. Erst im freigegebenen Rollout die Zuordnung vorbereiten:
   `node backend/scripts/migrate-access-profiles.js --project avycloud --apply --confirm ACCESS_PROFILES_V1`
   Der Lauf prüft UID, E-Mail und Tenant, schreibt Backup und alle Zuordnungen in einer Transaktion. Backup: `access_profile_migrations/default_access_profiles_v1`. Neue/unerwartete Konten führen zum Abbruch. Wiederholung überschreibt spätere manuelle Änderungen nicht.
4. **Danach** neue Backend-/Frontend-Version ausliefern. Die alten Server ignorieren `accessRole`, deshalb kann die Zuordnung vorab ohne Rechteausfall vorbereitet werden. Ausnahme: Scanner Support wird bereits mit der Migration gesperrt — Mitarbeiter vorher auf persönliche Konten ummelden. Keine Auslieferung ohne vorbereitete Profile: unzugeordnete Konten erhalten absichtlich keine Arbeitsrechte.
5. Web- und Worker-Revision, Hostingversion und Inhaberlogin prüfen. Mit einem persönlichen Mitarbeiterkonto den tatsächlichen Scanner-/Waage-/Label-/Druckweg prüfen. Druck-/Foto-Dienstkonten separat kontrollieren: falls ein Agent support@ oder operation@ verwendet, braucht dessen Betrieb vor Umstellung eine ausdrücklich passende Dienstidentität; keine gemeinsame Mitarbeiteridentität als Ersatz verwenden.
6. Fatih/Selahattin: Finanzlesen möglich, Speichern/Refund/Rollenverwaltung gesperrt. Entwickler: Diagnose/operativer Lesezugriff möglich, Finanz-/Zugangsdaten gesperrt. Leistungsanzeige auf persönliche IDs prüfen.

Rollback: zuerst betroffene Backend- und Hostingrevision nach dem bestehenden Rollback-Runbook zurücksetzen. Ursprüngliche Rollenarrays und Rollendokumente wurden nicht gelöscht/verändert. Das neue additive Profilfeld stört den alten Code nicht. Die Sperre des Sammelkontos bleibt standardmäßig bestehen. Das Backup enthält frühere Profile für eine gezielte Wiederherstellung; kein ungeprüftes Vollüberschreiben. Ein Rollback auf alte RBAC-Logik bringt deren alte, zu weitreichende Rechte zurück — deshalb nur kontrollierter Notfallpfad.

## Grenzen

Kein Live-Rollout, keine echte Waage/Scanner-Hardware und kein physischer Druck in dieser Änderung geprüft. Multi-Tenant-Generalüberholung, vollständige Feldklassifikation beliebiger Freitexte und separates Dienstkontenmodell sind keine Bestandteile dieser Änderung. Für den dokumentierten Tenant `default` sind die vorhandenen neun Identitäten geprüft. Neue Mitarbeiter bekommen bei Einladung sofort ein kanonisches Profil.

## Rollout-Fund am 19.09.2026

PR #9 (`9690fefd`) hat Backend, Frontend/TypeScript und KB-Prüfung erfolgreich bestanden. Noch vor jeder Produktionsänderung wurde ein zehntes, heute angelegtes Konto gefunden: Mahmoud Ali. Das bestehende Profil besitzt mehrere Altrollen einschließlich Admin, aber noch keinen tenantId. Seine Zielrolle ist beim Betreiber angefragt. Die Migration prüft deshalb zusätzlich sämtliche Firebase-Anmeldeidentitäten per Dokument-ID und stoppt auch bei unbekannten Alt-Profilen ohne tenantId. Keine Produktivumstellung, bevor alle aktiven Mitarbeiter eindeutig zugeordnet sind.
