# Erfassungsqualität — 09.10.2026

## Anlass und Produktionsmessung

Die bisherige Auslieferung hat das Gesamtproblem nicht behoben. Lesender Audit am 09.10.2026, 00:19 MESZ: 155 neue Produkte seit PR31 (06.10., 12:50:00.775172 UTC), davon **24 mit initialem Verkaufspreis**, 131 ohne; nur 9 bestanden die bisherige Inhaltsprüfung. 37 verwendeten Stage-3-Ersatzinhalt. Grundlage sind native Erstellungszeit und initiale `identify_v3`-Snapshots, nicht später nachbearbeitete Preise oder der manuell gewählte Status „Bereit“. Ein vollständiger historischer Textvergleich ist anhand der gespeicherten Zählwerte nicht möglich.

## Bestätigte Ursachen und Änderung

- Das äußere 60-Sekunden-Limit brach die agentische 90-Sekunden-Textrecherche ab. Spätere Fallbacks konnten trotzdem weiterlaufen. Die Recherche, Korrekturen, Single-Shot- und JSON-Formatter-Rückfälle respektieren jetzt ein gemeinsames Restbudget und SDK-Abbruch.
- Der erste Schreibaufruf wurde ungeprüft akzeptiert. Er wird jetzt mit den kanonischen Text-/Highlight-/Merkmal-/GPSR-Regeln geprüft und im selben Recherchechat höchstens zweimal korrigiert. Konkrete Titel-Pflichttokens ergänzen die Rückmeldung. Ein früher Entwurf lässt Zeit für diese Korrektur.
- Fehlende Enum-Merkmale wurden willkürlich aus dem ersten zulässigen Wert befüllt; Platzhalter zählten zur Vollständigkeit. Beides ist korrigiert. Unbelegte Fakten bleiben offen.
- Titel-Normalisierung verwendete eine falsche Funktionssignatur. Attributwerte wurden nach 60 Zeichen abgeschnitten; normale Werte und Dokument-URLs bleiben jetzt vollständig im kanonischen Datenblatt.
- Reale Hersteller-Registry-Dokumente lieferten `gpsr`, die Generierung erwartete `found/data`. Stage 2 normalisiert diese Form. Unterschiedliche Hersteller/EU-Firmen werden beim Merge je Rolle als ganze Datensätze behandelt, statt Namen, Land und Adresse zu vermischen.
- Bereits recherchierte Produktseiten gingen für die Preisrecherche verloren. Sie werden jetzt vor erneuten kostenpflichtigen Suchen gelesen. Direkter Webseitenabruf funktioniert auch bei deaktiviertem Unlocker.
- Shopify-Seiten enthalten Varianten teils nach 1,5 MB HTML und jenseits des Default-JSON-LD. Exakte GTIN, EUR, verfügbare Einzelkauf-Variante und Lieferumfang sind Voraussetzung. Konkrete Collection-Produktlinks sowie die dokumentierte lesende Shopify-Suche führen zu erneut geprüften Produktseiten. Keine Preisübernahme allein aus Navigation/API-Suchtreffern.
- Kaufland-Bereitschaft wurde nur aus zwei Textfeldern abgeleitet. Sie verlangt jetzt ebenfalls vollständige Inhalte, Pflichtmerkmale, GPSR und Preis.

Keine Bestands-, OMS-, Auth- oder Listingmutation; keine Infrastrukturdateien geändert. V3/V4- und Modellpolitik bleiben bestehen. Keine nachträgliche Massenänderung vorhandener Produkte und keine automatische Statusänderung zu „Bereit“.

## Abnahme mit Originalfotos

Alle Foto-Proben verwenden echte Originalbilder, OCR und Recherche-APIs; Barcode und Produkthinweis werden nicht vorgegeben. Firestore-Schreibmethoden und Storage-Schreibzugriffe sind vor dem App-Import gesperrt. Kein Testprodukt wurde produktiv angelegt. Die gemeldete Bereitschaft ist die automatische Inhaltsprüfung, keine unabhängige Garantie für jeden recherchierten Fakt.

| Vollständige Stage-1→4-Probe | Initialer Verkaufspreis | Inhaltsprüfung | Dauer |
|---|---:|---|---:|
| Hobbii Mega Ball, EAN 5714421128544 | 19,00 € | eBay/Kaufland grün nach einer Korrektur | 94 s |
| KEUCO Ersatzbürste 00864004000 | 6,99 € | eBay/Kaufland grün nach einer Korrektur | 98 s |
| Blumtal Musselin-Bettwäsche, EAN 4251897570350 | 45,99 € | eBay/Kaufland grün nach einer Korrektur | 117 s |
| MeXo HB21.9400-1 / 2er-Set | fehlt | nicht bereit; Titel/Preis offen | 168 s |

Die ersten drei Preise kommen aus echten Händlerangeboten; die Variantenprüfung bleibt aktiv. Dies ist eine gezielte Regressionstichprobe, **keine repräsentative Erfolgsquote**. Bei einer separaten Preisprobe für HAFIX 7×4 m blieb der Preis offen; Preise anderer runder Planen wurden nicht übernommen. Mehrteilige MeXo-Gartengruppen sind kein Preisbeleg für zwei einzelne Stühle.

## Weiterhin offen

MeXo produziert außerdem fragwürdige Herstellerdaten (`epiqoo GmbH`), obwohl die modellbezogene [Lidl-Anleitung](https://www.lidl.de/assets/gcpde870b835d594ce4857592914a8afe0a.pdf) Ningbo Kaixing und E-Moewe als getrennte Rollen nennt. Die neue Konsistenzprüfung erkennt vollständig erfundene oder falsch zugeordnete Datensätze nicht sicher. Eine belastbare Quellenprüfung und anschließende gezielte GPSR-Korrektur bleiben erforderlich. Der Fall ist bereits wegen Preis/Titel nicht als bereit markiert. Nicht als gelöst abnehmen.

Die existierende Titelpolitik verlangt teils technische Kennungen und unnatürliche Formulierungen; der Agent erfüllt diese Vorgaben jetzt gezielt. Eine inhaltliche Neuordnung dieser allgemeinen Policy ist damit nicht erfolgt. eBay Catalog liefert weiterhin 403; Zugangsdaten wurden nicht geändert. Scope `identify.v2-agentic` fehlt; dessen dokumentierter Rückfall auf `identify.v2`/Code-Defaults bleibt erhalten.

## Versionierung und Auslieferung

Unveränderliche Scope-Version `identify.v2/capture-v3-20261009`, Elternversion `capture-v2-20260927`, [Manifest](../releases/capture-quality-v3-prompt-manifest.json). Gespeicherter Prompt-/Rules-Text und Modellkonfiguration bleiben unverändert; das Manifest versioniert die geänderten kompilierten Prompts, Schemas und Qualitätsregeln. Aktivierung erst mit geprüftem passendem Produktionsimage, Elternversion für Rollback erhalten.

Der Betreiberauftrag „nach Tests auf Produktion“ ist erteilt. Dieser Bericht wird vor der Auslieferung erstellt; Commit/Revisionen/Health und endgültige Testergebnisse werden im `CODEX_MEMORY.md` nachgewiesen. Private Rohprotokolle: `/Users/oguz/Dev/avycloud-local-backups/capture-quality/20261009/`.

Lokale Abschlussprüfung: **6.002 Backendtests / 519 Dateien grün**, TypeScript und Frontend-Build grün. Testbelege privat in `/tmp/avy-capture-6002.log`, `/tmp/avy-capture-typecheck.log`, `/tmp/avy-capture-build-final.log`.

Nach Integration von Main e786a580: **6.022 Tests / 521 Dateien grün**. Zwei CI-abhängige Testannahmen korrigiert: Navigation nutzt eine kontrollierte Uhr statt Laufzeit des kalten Modulladers; Timerprüfung überprüft das Löschen des eigenen Deadlines statt sämtliche fremden SDK-Timer. Produktionscode unverändert.
