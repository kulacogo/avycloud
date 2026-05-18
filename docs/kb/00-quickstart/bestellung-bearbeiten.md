---
title: Wie bearbeite ich eine neue Bestellung?
for: [user]
lastReviewed: 2026-05-18
section: 00-quickstart
topic: bestellungen
icon: 📦
order: 7
---

# Wie bearbeite ich eine neue Bestellung?

Eine neue Bestellung ist reingekommen — was jetzt? Hier zeige ich dir den Weg von der Eingangs-Bestellung bis zum versandfertigen Paket. AvyCloud hält dir den ganzen Prozess im Blick: kommissionieren, packen, versenden, fertig.

> **💡 Tipp:** Du musst nichts manuell "abrufen". eBay- und Kaufland-Bestellungen landen automatisch bei dir, meist innerhalb von **5 Minuten** nach dem Kauf.

## Schritt 1 — Bestellungen-Tab öffnen

Klick oben in der Navigation auf **Bestellungen**. Du siehst eine **Pipeline-Ansicht** mit Spalten:

- **Neu**
- **Bestätigt**
- **In Kommissionierung**
- **Kommissioniert**
- **In Verpackung**
- **Verpackt**
- **Versendet**
- **Zugestellt**

Jede Bestellung ist eine kleine Karte, die durch die Spalten wandert, während du sie bearbeitest. Wie ein digitales Kanban-Board.

> **💡 Tipp:** Wenn du nicht so viele Bestellungen hast, kannst du oben rechts auf **Listenansicht** wechseln. Spätere Schritte funktionieren genauso.

## Schritt 2 — Eine Bestellung anklicken

Klick auf eine Karte in der **Neu**-Spalte. Es öffnet sich das **Bestelldetail** als großes Seitenfenster.

Du siehst:

- **Käufer** — Name, Adresse, E-Mail.
- **Artikel** — was bestellt wurde, mit Menge und Preis.
- **Versand-Info** — Carrier-Wunsch (falls gewählt), Versandadresse.
- **Marktplatz-Daten** — welche Plattform, Bestellnummer.
- **Rechnungsstatus** — wird automatisch erstellt beim Versand.
- **Status-Verlauf** — Zeitstempel zu jedem Schritt.

> **💡 Tipp:** Wenn der Käufer eine **Nachricht** dazugeschrieben hat (z. B. "Bitte als Geschenk verpacken"), siehst du das ganz oben mit gelbem Banner. Übersieh das nicht.

## Schritt 3 — Bestellung "Bestätigen" (optional)

Manche Marktplätze (z. B. Kaufland) verlangen, dass du die Bestellung **bestätigst**, damit der Käufer weiß, dass du sie wahrgenommen hast.

Klick im Bestelldetail auf **Bestätigen**. AvyCloud schickt automatisch die Bestätigung an den Marktplatz, und die Karte wandert in die **Bestätigt**-Spalte.

> **💡 Tipp:** Manche Marktplätze (z. B. eBay) bestätigen automatisch — da musst du nichts tun.

## Schritt 4 — Kommissionieren

Klick auf **Kommissionieren starten** oder zieh die Karte in die Spalte **In Kommissionierung**.

Jetzt zeigt dir AvyCloud genau, wo die Ware liegt:

- **BIN** — z. B. **XGA0201C** (das ist dein Lagerplatz-Code).
- **Menge** — wie viele Stück zu picken.
- **Bild** — kleines Vorschaufoto, damit du das richtige Produkt findest.

Geh in dein Lager, finde den BIN, nimm die Stücke raus.

> **💡 Tipp:** Hast du mehrere Bestellungen gleichzeitig? Mach eine **Sammel-Kommissionierung**: oben in **Bestellungen** mehrere Karten auswählen (kleine Häkchen), dann **Sammel-Pickliste** klicken. Du bekommst eine optimierte Liste sortiert nach BIN — Lauf-Optimierung inklusive.

## Schritt 5 — "Kommissioniert" bestätigen

Sobald du die Ware in der Hand hast, klick auf **Pick bestätigen** (oder scanne den BIN-Barcode wenn du einen Scanner nutzt).

AvyCloud bucht den Bestand jetzt um:

- Aus dem BIN raus.
- In einen **Versand-Puffer** rein (technisch: "reserved for shipping").

Die Karte wandert in **Kommissioniert**.

> **⚠️ Achtung:** Sobald du auf **Pick bestätigen** klickst, ist der Bestand wirklich aus deinem Lager gebucht. Wenn die Bestellung später storniert wird, musst du den Bestand wieder zurückbuchen (siehe [Bestand verwalten](bestand-verwalten.md)).

## Schritt 6 — Packen

Klick auf die Karte in **Kommissioniert** und dann auf **Packen starten**. Die Karte wandert in **In Verpackung**.

Beim Packen:

1. Suche den passenden Karton (Größe und Stabilität).
2. Polster gut aus (Luftpolsterfolie, Zeitung).
3. Leg die Ware rein.
4. Wenn der Käufer eine Nachricht hatte (Geschenk!) → entsprechend behandeln.
5. Karton zumachen, beschriften (Etikett kommt im nächsten Schritt).

Wenn fertig: klick auf **Verpackt** im Bestelldetail. Die Karte wandert in die nächste Spalte.

> **💡 Tipp:** Du kannst Schritt 5 (kommissionieren) und Schritt 6 (packen) zusammenziehen. Falls du eine kleine Halle hast: pick aus dem Regal, leg direkt in den Karton, klick beides hintereinander an. AvyCloud denkt dir nichts vor.

## Schritt 7 — Versand erstellen

Aus der **Verpackt**-Spalte klick auf **Versand erstellen** an der Karte. Du wirst weitergeleitet zum **Versand-Tab**.

Hier wählst du den Carrier (DHL, DPD) und druckst das Etikett. Details: [Versand erstellen](versand-erstellen.md).

> **💡 Tipp:** Wenn du viele Bestellungen hast, kannst du das auch in einem Rutsch machen: im Versand-Tab alle versandfertigen Bestellungen auswählen, **Sammel-Etiketten** drucken — alle PDFs in einer Datei.

## Schritt 8 — Versendet

Sobald das Etikett gedruckt und auf den Karton geklebt ist, klick auf **Versendet** (im Versand-Tab oder Bestelldetail).

AvyCloud macht dann automatisch:

- ✅ Status setzen auf **Versendet**.
- ✅ Tracking-Nummer an eBay/Kaufland senden — der Käufer bekommt eine Versandbenachrichtigung.
- ✅ Rechnung erstellen (falls noch nicht) und an den Käufer mailen.
- ✅ Bestand endgültig aus dem System buchen.
- ✅ Karte wandert in **Versendet**.

Du musst nichts mehr machen — fertig!

> **💡 Tipp:** Vom Druck des Etiketts bis zur "Versendet"-Buchung dauert AvyCloud meistens nur ein paar Sekunden. Wenn du eine Bestätigung sehen willst, schau in der Karte unter **Status-Verlauf**.

## Schritt 9 — Zugestellt

Sobald das Paket beim Käufer angekommen ist (Track-and-Trace meldet "delivered"), wandert die Karte automatisch in **Zugestellt**.

Du musst nichts tun. Die meisten Käufer reagieren überhaupt nicht mehr — und das ist gut so.

## Was, wenn etwas schiefgeht?

### Bestellung stornieren

- Geht nur, **bevor** du auf "Versendet" geklickt hast.
- Im Bestelldetail oben rechts: **Stornieren** → Grund auswählen → Bestätigen.
- AvyCloud informiert den Käufer und gibt das Geld zurück (eBay/Kaufland refunds).

### Falsches Produkt gepickt

- Wenn du beim Pick einen Fehler gemerkt hast: im Bestelldetail auf **Pick zurücksetzen** klicken.
- Der Bestand wird wieder reingebucht, du kannst von vorne anfangen.

### Adresse falsch

- Falls der Käufer eine falsche oder fehlerhafte Adresse angegeben hat: im Bestelldetail unter **Käufer** auf **Bearbeiten** klicken.
- Korrigiere die Adresse. Bei nicht erreichbarem Käufer den Marktplatz-Support kontaktieren.

> **⚠️ Achtung:** Adressänderungen sollten nur gemacht werden, wenn du sicher bist (z. B. nach Rücksprache mit dem Käufer). Sonst geht das Paket an die falsche Person.

## Häufige Fragen

- **Warum sehe ich keine neuen Bestellungen, obwohl ich grad eine bekommen habe?**  
  Es kann bis zu 5 Minuten dauern, bis eine Bestellung von eBay/Kaufland im System landet. Wenn länger: in **Einstellungen** → **Integrationen** den Sync-Status prüfen.

- **Kann ich Bestellungen exportieren?**  
  Ja, oben rechts in **Bestellungen** auf **Export** → CSV oder Excel.

- **Was, wenn der Bestand 0 ist, aber die Bestellung schon da?**  
  Das nennt sich **Oversell** und sollte nicht passieren, weil AvyCloud die Bestände live syncht. Falls doch: schnell stornieren oder Käufer informieren. Mehr in [Bestand verwalten](bestand-verwalten.md).

- **Wie sehe ich nur die unbearbeiteten Bestellungen?**  
  In der Pipeline-Ansicht siehst du alles auf einen Blick. In der Listenansicht oben filtern auf **Neu** und **Bestätigt**.

- **Was bedeuten all diese Statussen?**  
  Komplette Erklärung in [Bestellstatus erklärt](bestellstatus-erklart.md).
