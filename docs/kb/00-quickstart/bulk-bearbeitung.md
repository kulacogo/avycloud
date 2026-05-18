---
title: Wie bearbeite ich viele Produkte auf einmal?
for: [user]
lastReviewed: 2026-05-18
section: 00-quickstart
topic: erweitert
icon: ⚡
order: 13
---

# Wie bearbeite ich viele Produkte auf einmal?

Du willst 50 Produkte um 10 % günstiger machen? Oder allen Werkzeugen das Tag "Frühlingsaktion" verpassen? Mit der **Bulk-Bearbeitung** geht das in einem Rutsch — mit Vorschau, damit du nichts kaputt machst.

> **💡 Tipp:** Die Bulk-Bearbeitung ist eines der mächtigsten Werkzeuge in AvyCloud. Aber genau deswegen: **immer erst die Vorschau prüfen, bevor du auf Anwenden klickst**. Ein Klick ändert viele Daten gleichzeitig.

## Schritt 1 — Produkte auswählen

Geh zu **Produktdaten** oder **Inventar**. Du siehst die Listenansicht aller Produkte.

Markiere die Produkte, die du bearbeiten willst. Drei Möglichkeiten:

- **Einzelne anklicken** — Häkchen pro Zeile.
- **Bereich auswählen** — Häkchen oben in der Zeile + Shift + Häkchen unten = alles dazwischen.
- **Alle filtern und auswählen** — erst über Suche/Filter eingrenzen (z. B. nur Kategorie "Akkuwerkzeug"), dann oben **Alle auswählen** klicken.

Du siehst oben eine kleine Leiste: **"23 Produkte ausgewählt"**.

> **💡 Tipp:** Filter sind dein bester Freund. Beispiele:
> - "Marke: Bosch" → alle Bosch-Produkte.
> - "Preis < 20 €" → alle günstigen Artikel.
> - "Bestand = 0" → ausverkaufte (für eine Aktion "wieder verfügbar").
> - "Aktualisiert vor > 90 Tagen" → veraltete Datenblätter.

## Schritt 2 — Bulk-Edit-Sheet öffnen

Wenn die Auswahl steht, klick oben in der Sammel-Leiste auf **Bulk bearbeiten** (manchmal als ⚡ Icon).

Es öffnet sich ein **Bulk-Edit-Sheet** mit den Feldern, die du in einem Rutsch ändern kannst:

- **Preis** (absolut oder prozentual)
- **Versandkosten**
- **Kategorie**
- **Marke**
- **Tags** (eigene Etiketten zum Organisieren)
- **Hersteller/GPSR-Daten**
- **Aspekte** (für eine bestimmte Kategorie)
- **Bestand** (Inventur-Korrektur in großem Stil — Vorsicht!)
- **Marktplatz-Listing** (alle gelisteten Produkte auf eBay aktualisieren)

Wähle das Feld, das du ändern willst.

> **⚠️ Achtung:** Du kannst pro Bulk-Edit **mehrere Felder gleichzeitig** ändern. Aber je mehr, desto mehr Risiko, dass etwas nicht stimmt. Bei wichtigen Feldern (Preis, Kategorie) lieber separat machen.

## Schritt 3 — Änderung definieren

Je nach Feld gibt's verschiedene Möglichkeiten:

### Preis

- **Auf festen Wert setzen** — alle Produkte bekommen denselben Preis. Sinnvoll z. B. wenn alle "T-Shirts" 14,99 € kosten sollen.
- **Um Prozent ändern** — z. B. **-10 %** für Aktion oder **+5 %** wenn Einkaufspreise gestiegen sind.
- **Um festen Betrag ändern** — z. B. **-2,00 €**.
- **Aufrunden** auf .99 oder .50 — schöne Endpreise.

### Tags

- **Hinzufügen** — "Frühling2026" zu allen ausgewählten Produkten dazu.
- **Entfernen** — "Sale" Tag bei allen weg.
- **Ersetzen** — alle Tags löschen und nur die neuen setzen.

### Kategorie

- **Neue Kategorie wählen** — alle ausgewählten Produkte in die neue Kategorie umziehen. AvyCloud warnt, wenn dadurch Pflichtfelder kaputt gehen.

### Aspekte

- **Wert für eine bestimmte Aspekt-Eigenschaft setzen** — z. B. alle "Akkuspannung: 18V" für eine Auswahl von Akkuschraubern.

> **💡 Tipp:** Wenn du dir unsicher bist, was eine Option macht, fahr mit der Maus über das Info-Symbol (ⓘ) — meistens steht da eine kurze Erklärung.

## Schritt 4 — Diff-Vorschau prüfen

Das ist **der wichtigste Schritt**. Bevor irgendwas geändert wird, klick auf **Vorschau**.

AvyCloud zeigt dir eine **Diff-Tabelle**:

| SKU | Feld | Vorher | Nachher |
|-----|------|--------|---------|
| BOSCH-GSR12 | Preis | 49,99 € | 44,99 € |
| BOSCH-PSR18 | Preis | 89,99 € | 80,99 € |
| MAKITA-12V | Preis | 39,99 € | 35,99 € |

Schau drüber:

- **Ergibt das Sinn?** Sind die Werte plausibel?
- **Gibt es Ausreißer?** Z. B. Produkte, die durch die prozentuale Reduzierung auf 0,01 € fallen würden?
- **Werden Produkte beeinflusst, die nicht sollten?** Wenn ja: Filter anpassen und neu auswählen.

> **⚠️ Achtung:** Wenn die Vorschau **gar nicht** auftaucht oder leer ist, lädt sie evtl. noch — 2 Sekunden warten. Sonst stimmt was mit der Auswahl nicht.

## Schritt 5 — Bestätigen

Wenn die Vorschau OK ist, klick auf **Anwenden**. Du bekommst eine letzte Sicherheitsabfrage: **"Wirklich 23 Produkte ändern?"** — klick **Ja, anwenden**.

AvyCloud arbeitet die Änderungen im Hintergrund ab. Du siehst einen Fortschrittsbalken:

- **5/23 aktualisiert...**
- **15/23 aktualisiert...**
- **23/23 fertig. ✅**

Bei Erfolg: alle Produkte sind aktualisiert. Bei Teilfehler (z. B. 2 Produkte konnten nicht geändert werden, weil sie gerade von jemand anderem bearbeitet werden): AvyCloud zeigt die einzelnen Fehler an, alle erfolgreich geänderten sind gespeichert.

> **💡 Tipp:** Wenn du nach dem Anwenden merkst, dass das ein Fehler war: **es gibt keinen "Alles Rückgängig"-Knopf** für Bulk-Aktionen. Du musst sie manuell mit einer neuen Bulk-Aktion rückgängig machen (z. B. wieder +10 % Preis erhöhen).

## Schritt 6 — Marktplatz-Update

Wenn du Preise oder Beschreibungen geändert hast und die Produkte sind auf eBay/Kaufland gelistet, fragt AvyCloud:

**"Sollen die Änderungen auch auf den Marktplätzen aktualisiert werden?"**

- **Ja** → alle Listings werden automatisch aktualisiert (kann 1-2 Minuten dauern bei vielen Produkten).
- **Nein** → die Daten ändern sich nur in AvyCloud, die Listings bleiben wie sie sind. Du kannst sie später manuell pushen.

> **💡 Tipp:** Bei einer großen Preisaktion (z. B. Black Friday): **ja** anklicken. Bei reinen internen Änderungen (z. B. Tags zur Organisation): **nein** reicht.

## Anwendungsfälle aus der Praxis

### "Frühlingsaktion: alle Werkzeuge 15 % günstiger"

1. Filter: Kategorie = "Werkzeug"
2. Alle auswählen.
3. Bulk-Edit: **Preis um -15 %**.
4. Vorschau prüfen. Anwenden.
5. Auf Marktplätzen aktualisieren: **ja**.

### "Alle Bosch-Produkte mit dem Tag 'Premium' versehen"

1. Filter: Marke = "Bosch"
2. Alle auswählen.
3. Bulk-Edit: **Tags hinzufügen → "Premium"**.
4. Vorschau. Anwenden.

### "Pflichtfeld 'Akkuspannung' für alle Akkuschrauber auf '18V' setzen"

1. Filter: Kategorie = "Akkuschrauber"
2. Alle auswählen.
3. Bulk-Edit: **Aspekt → Akkuspannung → 18V**.
4. Vorschau. Anwenden.

> **⚠️ Achtung:** Bei Aspekten lieber vorsichtig sein, weil nicht alle 18V haben. Lieber Filter feiner machen oder vorher nochmal Datenblätter checken.

## Häufige Fragen

- **Wie viele Produkte kann ich gleichzeitig bearbeiten?**  
  Bis zu 500 in einer einzelnen Bulk-Aktion. Wenn mehr: in mehrere Schritte aufteilen.

- **Kann ich die Bulk-Aktion abbrechen, während sie läuft?**  
  Nein, sobald du **Anwenden** geklickt hast, läuft sie durch. Aber wenn die Vorschau noch offen ist, kannst du jederzeit auf **Abbrechen** klicken, ohne dass was passiert.

- **Werden Audit-Logs erstellt?**  
  Ja. Jede Bulk-Aktion landet im **Aktivitäts-Log** unter **Einstellungen → Verlauf**. Du kannst dort sehen, wer wann was geändert hat.

- **Was, wenn ich eine Bulk-Aktion abbrechen muss, weil sie zu langsam ist?**  
  Bei wirklich vielen Produkten (z. B. 500+) kann das einige Minuten dauern. Du kannst die App in der Zwischenzeit weiter benutzen — die Bulk-Aktion läuft im Hintergrund. Falls sie hängt: Team-Lead fragen.

- **Gibt es eine "Bulk-Aktion-Vorlage", die ich speichern kann?**  
  Aktuell nicht. Wenn du dieselbe Aktion oft brauchst (z. B. monatlich), schreib dir die Einstellungen in einem Notiz-Dokument auf — geht in 1 Minute neu einzutippen.
