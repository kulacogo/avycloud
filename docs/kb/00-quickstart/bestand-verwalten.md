---
title: Wie verwalte ich Bestand und Lager?
for: [user]
lastReviewed: 2026-05-18
section: 00-quickstart
topic: lager
icon: 🏷️
order: 12
---

# Wie verwalte ich Bestand und Lager?

Ein gutes Lager ist die Basis für stressfreies Verkaufen. AvyCloud zeigt dir jederzeit, **was du hast, wo es liegt und ob es reicht**. Hier siehst du, wie du Bestand einbuchst, BINs verwaltest und Inventur-Korrekturen machst.

> **💡 Tipp:** AvyCloud macht den Bestand automatisch live: jeder Verkauf, jede Retoure, jeder Wareneingang wirkt sofort. Du musst dich nur ums Reinholen und Inventur kümmern.

## Was ist ein BIN?

Ein **BIN** ist dein Lagerplatz-Code. Statt "Regal 3, Reihe 2, Fach C" schreibst du in AvyCloud einfach **XGA0201C**. Das hat Vorteile:

- **Eindeutig** — jeder BIN hat einen einzigen Code.
- **Druckbar** — du kannst BIN-Etiketten mit Barcode ausdrucken und an die Regale kleben.
- **Scannbar** — mit einem Barcode-Scanner gehst du durchs Lager und arbeitest deutlich schneller.

Ein BIN-Code besteht typischerweise aus:

- **X** = Lager-Standort (z. B. Halle X, Halle Y)
- **GA** = Gang (z. B. GA = Gang A, GB = Gang B)
- **02** = Regalnummer
- **01** = Reihe (Etage von unten gezählt)
- **C** = Fach (von links gezählt: A, B, C, ...)

Du kannst aber auch eigene Codes nutzen — z. B. **WERKSTATT-01** oder **REGAL-Bohrer**. AvyCloud ist flexibel.

> **💡 Tipp:** Halt es **konsistent**. Wenn du einmal das System "Standort-Gang-Regal-Reihe-Fach" anfängst, mach so weiter. Dann ist jedes Picken intuitiv.

## Schritt 1 — Lager-Tab öffnen

Geh in der Navigation auf **Verwaltung → Lager** (manchmal auch unter **Inventar** zu finden).

Du siehst:

- Eine Liste aller **BINs** mit Belegung.
- Eine Such-/Filterleiste.
- Knopf **Neuer BIN** zum Anlegen.

## Schritt 2 — Einen neuen BIN anlegen

1. Klick auf **Neuer BIN**.
2. Gib einen **Code** ein (z. B. **XGA0201C**).
3. Optional: **Beschreibung** (z. B. "Werkstatt, Regal links, oben").
4. **Speichern** klicken.

Optional kannst du das **BIN-Etikett** sofort drucken (mit Barcode), aufkleben — fertig.

> **💡 Tipp:** Beim Aufbau lohnt es sich, eine Excel-Liste mit allen geplanten BINs zu schreiben und sie in einem Rutsch in AvyCloud anzulegen. Über **Bulk-Import** geht das in 30 Sekunden.

## Schritt 3 — Wareneingang einbuchen (Stock-in)

Eine Palette ist gerade angekommen. So buchst du sie ins Lager:

### Option A — Über das Datenblatt

1. Öffne das Produkt (z. B. über **Inventar**).
2. Im Datenblatt auf der linken Seite findest du **Bestand**.
3. Klick auf **Bestand zubuchen**.
4. Wähle den **BIN** aus.
5. Trag die **Menge** ein.
6. Optional: **Lieferschein-Nummer** oder Notiz.
7. **Bestätigen**.

### Option B — Über den Wareneingang-Tab

Wenn du eine ganze Lieferung mit vielen verschiedenen Produkten reinholst:

1. Geh zu **Verwaltung → Wareneingang** (oder **Inventar → Wareneingang**).
2. **Neue Lieferung anlegen**.
3. Lieferanten und Bezugsdatum eingeben.
4. Pro Artikel: SKU/Barcode scannen oder eintippen → Menge → BIN.
5. **Lieferung abschließen** klicken — alle Bestände werden in einem Rutsch eingebucht.

> **💡 Tipp:** Wenn du einen Barcode-Scanner hast, läuft das doppelt so schnell. AvyCloud erkennt Produkte automatisch über EAN/GTIN.

## Schritt 4 — Bestand im Datenblatt prüfen

Geh ins Datenblatt eines Produkts. Auf der linken Seite siehst du:

- **Gesamtbestand** (Summe über alle BINs)
- **Lagerorte** — Liste mit BIN-Code und Menge je BIN
- **Reserviert** — Stücke, die für gerade laufende Bestellungen reserviert sind
- **Verkaufbar** — Gesamtbestand minus Reserviert (was du noch verkaufen kannst)

> **💡 Tipp:** Wenn der Gesamtbestand ungleich der Summe der BINs ist (kommt selten vor), zeigt AvyCloud eine **Warnung** an. Das ist ein Hinweis, dass du eine Inventur-Korrektur machen solltest.

## Schritt 5 — Pick-Workflow beim Versand

Wenn du eine Bestellung kommissionierst (siehe [Bestellung bearbeiten](bestellung-bearbeiten.md)), zeigt AvyCloud dir:

- **BIN-Code** wo die Ware liegt
- **Menge** die zu picken ist
- **Bild** des Produkts (gegen Verwechslung)

Geh zum BIN, scanne den BIN-Barcode (oder klick **Pick bestätigen**), zähle die Menge ab, weiter.

> **💡 Tipp:** Bei einer **Sammel-Pickliste** (mehrere Bestellungen gleichzeitig) sortiert AvyCloud die BIN-Reihenfolge so, dass du dein Lager **einmal** durchläufst und nicht vor- und zurücklaufen musst.

> **⚠️ Achtung:** Wenn du beim Picken **weniger** Stücke findest, als das System sagt: **stopp**. Schau in den BIN. Wenn definitiv weniger da ist, brich den Pick ab (**Pick zurücksetzen** im Bestelldetail) und mach erst eine Inventur-Korrektur (siehe nächster Schritt).

## Schritt 6 — Inventur-Korrektur

Manchmal stimmt der digitale Bestand nicht mit dem realen überein. Gründe können sein:

- **Diebstahl** oder Schaden.
- **Versehentlich** falsch eingebucht.
- **Pick-Fehler** in der Vergangenheit.

So korrigierst du:

1. Im Datenblatt des Produkts auf **Bestand korrigieren** klicken.
2. **Grund** auswählen (Inventur, Schaden, Verlust, Korrektur).
3. **Neuer Bestand** eintragen (z. B. 7 statt 10).
4. Optional: **Notiz** mit Erklärung.
5. **Bestätigen**.

AvyCloud erstellt einen **Bestandseintrag** im Lager-Journal, damit jede Korrektur nachvollziehbar bleibt.

> **⚠️ Achtung:** Inventur-Korrekturen sollten **die Ausnahme** sein. Wenn du sie regelmäßig brauchst, ist irgendwo ein Prozess kaputt (Pick-Disziplin, Wareneingang nicht erfasst, etc.). Schau dir das Lager-Journal an, um Muster zu erkennen.

## Schritt 7 — Volle Inventur durchführen

Einmal im Jahr (oder häufiger, wenn du willst) lohnt sich eine **Komplette Inventur**:

1. Geh zu **Verwaltung → Lager → Inventur**.
2. Klick auf **Neue Inventur starten**.
3. AvyCloud erstellt eine Pickliste aller BINs, sortiert nach Lager-Reihenfolge.
4. Geh BIN für BIN durch, scanne und zähle.
5. Bei Abweichungen: korrigiere die Zahl direkt in der Inventur-Maske.
6. Wenn du fertig bist: **Inventur abschließen**.

AvyCloud erstellt ein **Inventur-Protokoll** für deine Buchhaltung.

> **💡 Tipp:** Inventur am besten an einem ruhigen Wochenende, ohne neue Bestellungen. Wenn das nicht geht: in der Inventur-Maske sind alle "während Inventur reingekommenen" Bestellungen markiert, du kannst sie nachträglich bereinigen.

## Schritt 8 — BIN-Etiketten drucken

Wenn du physische Schilder fürs Regal brauchst:

1. Geh zu **Verwaltung → Lager**.
2. Wähle die BINs (oder alle).
3. Klick **Etiketten drucken**.
4. Wähle Format (z. B. Avery L7160 oder Thermoetikett 50×30 mm).
5. PDF wird generiert, drucken.

Jedes Etikett enthält den BIN-Code als Text **und** als Barcode — letzteres ist Gold wert für die Scanner-Bedienung.

## Häufige Fragen

- **Was, wenn ich denselben Artikel auf zwei BINs verteilt habe?**  
  Ist okay, AvyCloud kennt **mehrere Lagerorte pro Artikel**. Beim Pick zeigt es dir den nächstgelegenen BIN. Du kannst beim Bestand-Zubuchen auch die Menge auf mehrere BINs splitten.

- **Kann ich Lagerumzug machen (von BIN A zu BIN B)?**  
  Ja. Im Datenblatt unter **Bestand** auf **Umlagern** klicken, neuen BIN wählen, Menge. Sofort gebucht.

- **Wann passiert das automatische Bestand-Update an eBay/Kaufland?**  
  Nach **jedem** Bestand-Event (Verkauf, Wareneingang, Korrektur) innerhalb von **5-30 Sekunden**. So sehen die Marktplätze immer den aktuellen Bestand.

- **Was, wenn die Bestände auf eBay/Kaufland nicht mit AvyCloud übereinstimmen?**  
  Im Datenblatt unter **Marktplatz-Status** stehen die "letzten gesyncten Werte". Wenn da Abweichungen sind: oben rechts auf **Sync neu starten** klicken. Wenn das Problem bleibt: Team-Lead fragen.

- **Mein BIN ist voll, was tun?**  
  Leg einen zusätzlichen BIN an (z. B. **XGA0201C-2** als Überlauf) und buch dort den Rest. Oder verlager auf einen anderen freien BIN über die Umlagern-Funktion.
