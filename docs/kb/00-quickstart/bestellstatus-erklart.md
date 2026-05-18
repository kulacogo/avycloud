---
title: Was bedeuten die Bestellstatus?
for: [user]
lastReviewed: 2026-05-18
section: 00-quickstart
topic: bestellungen
icon: 📊
order: 8
---

# Was bedeuten die Bestellstatus?

In AvyCloud läuft jede Bestellung durch eine **Pipeline mit Statussen**. Jeder Status bedeutet was Konkretes — und sagt dir auch, was als Nächstes zu tun ist.

Hier die komplette Übersicht als Spickzettel.

> **💡 Tipp:** Du musst dir das nicht auswendig merken. Im Bestelldetail steht immer ein kleiner Hinweis, was du als Nächstes klicken kannst.

## Die Tabelle aller Status

| Status | Was bedeutet das? | Was musst du tun? |
|--------|-------------------|-------------------|
| **Neu** | Bestellung ist von eBay/Kaufland reingekommen, du hast sie noch nicht angesehen. | Anschauen, Käufernachrichten prüfen, ggf. bestätigen. |
| **Bestätigt** | Du hast die Bestellung angenommen. Bei Kaufland: Bestätigung wurde an den Marktplatz gesendet. | Mit der Kommissionierung anfangen. |
| **In Kommissionierung** | Du bist gerade dabei, die Ware aus dem Lager zu holen. | Ware finden, picken, **Pick bestätigen** klicken. |
| **Kommissioniert** | Ware ist aus dem Regal raus und im Versand-Puffer. | Mit dem Packen anfangen. |
| **In Verpackung** | Du verpackst die Ware gerade. | Karton fertig packen, **Verpackt** klicken. |
| **Verpackt** | Karton ist fertig, wartet auf Etikett. | **Versand erstellen** — Carrier wählen, Etikett drucken. |
| **Versendet** | Etikett gedruckt, Karton ist beim Transporteur. Tracking ist an den Marktplatz übergeben. | Nichts. AvyCloud verfolgt automatisch. |
| **Zugestellt** | Track-and-Trace meldet "delivered" beim Käufer. | Nichts. Fertig. 🎉 |
| **Storniert** | Bestellung wurde abgebrochen (von dir oder vom Käufer). Geld wurde zurückerstattet. | Nichts. Bestand wurde automatisch zurückgebucht. |
| **Retour** | Käufer hat einen Rücksendewunsch gestellt. Ware kommt zurück. | Siehe [Retoure bearbeiten](retoure-bearbeiten.md). |

## Was passiert technisch dabei?

Auch wenn du dich um die Technik nicht kümmern musst: für dein Verständnis, was im Hintergrund läuft.

### Bei "Neu" → "Bestätigt"
- Eine Bestätigung geht an Kaufland (bei eBay nicht nötig, dort ist Bestätigung automatisch).
- Der Käufer sieht "Order accepted" in seinem Marktplatz-Account.

### Bei "Bestätigt" → "In Kommissionierung"
- Eine Pickliste wird erzeugt mit BIN und Menge.
- Der Bestand ist noch normal verfügbar (nichts geblockt).

### Bei "In Kommissionierung" → "Kommissioniert"
- Der Bestand wird **aus dem BIN ausgebucht**.
- Die Stücke landen in einem virtuellen **Versand-Puffer**, getrennt vom normalen Lager.
- Diese Stücke sind ab jetzt nicht mehr für neue Bestellungen verfügbar.

### Bei "Kommissioniert" → "In Verpackung" → "Verpackt"
- Reine Status-Updates für dich. Im Hintergrund passiert nichts Magisches.
- Du kannst diese Schritte auch überspringen, wenn du Pick und Verpackung gleichzeitig machst — Karte direkt von **Kommissioniert** auf **Verpackt** ziehen.

### Bei "Verpackt" → "Versendet"
- Das Etikett wurde generiert (siehe [Versand erstellen](versand-erstellen.md)).
- Die Tracking-Nummer wird **automatisch** an eBay/Kaufland gesendet.
- Der Käufer bekommt eine Versandmail mit Trackinglink.
- Die **Rechnung** wird automatisch erstellt und an den Käufer geschickt (siehe [Rechnung versenden](rechnung-versenden.md)).
- Der Bestand wird **endgültig** aus dem System gebucht (war vorher "Pufferzone").

### Bei "Versendet" → "Zugestellt"
- AvyCloud fragt regelmäßig bei DHL/DPD nach (Tracking-Polling).
- Sobald die Sendung "delivered" gemeldet ist, wird der Status automatisch geändert.
- Bei Kaufland wird zusätzlich der Status "delivered" an den Marktplatz gemeldet.

## Status, die zurückspringen können

Manchmal geht ein Status **rückwärts**. Das ist normal in folgenden Situationen:

- **Kommissioniert → Bestätigt**: Du hast einen Fehler beim Pick gemacht und auf **Pick zurücksetzen** geklickt. Der Bestand wird wieder reingebucht.
- **Verpackt → In Verpackung**: Du merkst, dass du was vergessen hast (z. B. Begleitschreiben), öffnest den Karton wieder.
- **Versendet → Verpackt**: Etikett war fehlerhaft und das Paket ist noch da. **Sehr selten**, sollte vermieden werden, weil die Tracking-Nummer schon beim Marktplatz ist.

> **⚠️ Achtung:** Sobald die Bestellung **Versendet** ist, solltest du keinen Rückspringer mehr machen. Wenn was schiefgegangen ist, stornier lieber und mach ne neue Versandadresse. Sonst stimmen die Tracking-Daten beim Käufer nicht mehr.

## Sonderstatus: "Storniert"

Eine Bestellung wird storniert, wenn:

- **Du selbst stornierst** — z. B. Ware kaputt, nicht lieferbar.
- **Der Käufer storniert** — über eBay/Kaufland-Stornoanfrage, die du genehmigst.
- **Der Marktplatz storniert** — z. B. Verdacht auf Betrug.

Was passiert dann automatisch:

- ✅ Rückerstattung wird beim Marktplatz angestoßen (durch eBay/Kaufland).
- ✅ Falls schon kommissioniert: Bestand wird wieder ins Lager zurückgebucht.
- ✅ Falls schon versendet (selten): Du musst den Käufer kontaktieren und ggf. das Paket "auf Rückweg" senden lassen.

## Sonderstatus: "Retour"

Wenn der Käufer eine Rücksendung anfragt, **bevor** die Bestellung zugestellt ist: das geht nicht. Wenn **nachdem** sie zugestellt ist: die Bestellung bleibt im Status **Zugestellt**, aber es entsteht parallel eine neue **Retoure** im Retouren-Tab.

Details: [Retoure bearbeiten](retoure-bearbeiten.md).

## Status im Pipeline-Board (visuell)

So sieht das Board in **Bestellungen** typischerweise aus:

```
[Neu] [Bestätigt] [In Komm.] [Komm.] [In Verp.] [Verpackt] [Versendet] [Zugestellt]
  ▣      ▣         ▣           ▣        ▣          ▣           ▣            ▣
  ▣      ▣                              ▣          ▣           ▣            ▣
                                                                 ▣            ▣
```

Jedes ▣ ist eine Bestellungskarte. Du ziehst sie per Drag & Drop oder klickst pro Karte auf den nächsten-Schritt-Knopf.

> **💡 Tipp:** Wenn du eine Karte versehentlich in die falsche Spalte gezogen hast, einfach zurückziehen oder im Detailfenster den vorherigen Status klicken.

## Häufige Fragen

- **Kann ich Statussen anpassen oder eigene hinzufügen?**  
  Aktuell nein. Die Status-Pipeline ist fix, damit eBay/Kaufland-Updates funktionieren.

- **Warum springt eine Bestellung von "Neu" direkt auf "Versendet", wenn ich das Etikett drucke?**  
  Wenn du im Versand-Tab arbeitest und nicht den Pick/Pack-Workflow nutzt, überspringt AvyCloud die Zwischenstatus. Bestand wird trotzdem korrekt verbucht.

- **Wie kann ich nur "Neue" Bestellungen sehen?**  
  In der Pipeline ist die **Neu**-Spalte ganz links. In der Listenansicht oben filtern auf "Neu".

- **Ich habe Bestellungen, die ewig in "Versendet" hängen — warum?**  
  Die meisten Pakete brauchen 1-3 Tage zur Zustellung. Wenn nach 7+ Tagen keine "Zugestellt"-Meldung kommt: im Bestelldetail auf den Tracking-Link klicken und beim Carrier nachfragen.
