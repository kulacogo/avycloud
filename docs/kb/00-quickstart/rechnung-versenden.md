---
title: Wie funktionieren Rechnungen?
for: [user]
lastReviewed: 2026-05-18
section: 00-quickstart
topic: rechnungen
icon: 🧾
order: 11
---

# Wie funktionieren Rechnungen?

Rechnungen sind in AvyCloud **fast komplett automatisch**: beim Versand wird die Rechnung erstellt, der Käufer bekommt sie per E-Mail, und die PDF ist sofort verfügbar. Du musst nichts manuell anstoßen — außer, du willst was korrigieren.

> **💡 Tipp:** Wenn du keine eigene Buchhaltungssoftware nutzt, hilft dir der Rechnungen-Tab beim Monatsabschluss enorm: alle PDFs sind sortiert, Beträge automatisch in der CSV-Exportdatei.

## Schritt 1 — Rechnungen-Tab öffnen

Klick oben auf **Rechnungen**. Du siehst eine Liste aller Rechnungen, sortiert nach Datum (neueste oben):

- **Rechnungsnummer**
- **Bestellung** (verlinkt)
- **Käufer**
- **Betrag (brutto/netto)**
- **Status** (Erstellt, Versendet, Bezahlt, Korrektur)

Du kannst nach Datum, Status oder Käufer filtern.

> **💡 Tipp:** Mit der Suche oben findest du eine Rechnung schnell, wenn du nur die Rechnungsnummer hast (z. B. wenn der Käufer per Mail nach dem PDF fragt).

## Schritt 2 — Wann wird eine Rechnung erstellt?

**Automatisch** bei diesen Ereignissen:

- **Bestellung wird auf "Versendet" gesetzt** → Rechnung wird erstellt und an den Käufer gemailt.
- **Bestellung wird storniert** → eine **Stornorechnung** (Gutschrift) wird erstellt.
- **Retoure wird erstattet** → eine **Korrekturrechnung** (Teil-Gutschrift) wird erstellt.

Du musst nichts manuell auslösen.

> **⚠️ Achtung:** Wenn der Käufer eine **abweichende Rechnungsadresse** angegeben hat (z. B. Geschenk an Person A, Rechnung an Firma B), trägt AvyCloud das automatisch ein — soweit der Marktplatz die Daten liefert.

## Schritt 3 — Rechnung als PDF herunterladen

Klick auf eine Rechnung in der Liste. Im Detailfenster siehst du:

- **Vorschau** des Rechnungs-PDFs
- **Knopf "PDF herunterladen"** — speichert das Dokument auf deinem Rechner
- **Knopf "Per Mail an Käufer erneut senden"** — falls der Käufer die Mail verloren hat
- **Knopf "An Buchhaltung weiterleiten"** — falls du eine konfigurierte Buchhaltungs-E-Mail hast

> **💡 Tipp:** Bei vielen Rechnungen lohnt sich der **Sammel-Export** (oben rechts): Zeitraum wählen, **Alle als ZIP**, fertig. Perfekt für den Steuerberater.

## Schritt 4 — Was steht in der Rechnung?

Die automatische Rechnung enthält:

- **Deine Firmendaten** (aus den Einstellungen → Firmenprofil)
- **Käuferdaten** (aus dem Marktplatz)
- **Rechnungsnummer** (fortlaufend, z. B. **RE-2026-00342**)
- **Rechnungsdatum**
- **Bestelldatum**
- **Artikel** (mit Menge, Einzelpreis, Steuer)
- **Versandkosten**
- **Summen** (netto, MwSt., brutto)
- **Zahlungshinweis** (meist "Bezahlt via [eBay/Kaufland]")
- **Hinweise zu Widerruf und Rückgaberecht**

> **⚠️ Achtung:** Deine **Firmendaten** musst du einmalig in **Einstellungen → Firmenprofil** korrekt eintragen. Sonst stimmen deine Rechnungen nicht — und das fällt beim Finanzamt auf.

## Schritt 5 — Bezahltstatus markieren

Bei Marktplatz-Bestellungen ist die Zahlung im Grunde sofort drin (eBay/Kaufland zieht ab dem Käufer ein und überweist dir später). AvyCloud markiert die Rechnung deswegen automatisch als **bezahlt**.

Falls du eine **manuelle Rechnung** für eine externe Bestellung erstellt hast (z. B. Ladenverkauf, Direktanfrage):

1. Im Rechnungs-Detail auf **Bezahltstatus** klicken.
2. Auf **Bezahlt** setzen.
3. Datum eintragen.
4. Bestätigen.

> **💡 Tipp:** Wenn du **Mahnungen** schreiben willst, gibt's dafür einen separaten Knopf **Mahnung erstellen** im Rechnungs-Detail. AvyCloud schreibt automatisch die 1./2./3. Mahnung mit Fristsetzung.

## Schritt 6 — Korrekturrechnungen

Eine Korrekturrechnung (auch "Gutschrift" genannt) entsteht in zwei Fällen:

### Fall A — Vollständige Erstattung

Wenn du eine Bestellung **stornierst** oder eine Retoure mit voller Erstattung abschließt, erstellt AvyCloud automatisch eine **Stornorechnung**:

- Negativbetrag der Originalrechnung.
- Verweis auf die Original-Rechnungsnummer.
- Verschickt an den Käufer.

### Fall B — Teilweise Erstattung

Bei einer Retoure mit **teilweiser** Erstattung (z. B. Käufer hat 1 von 2 Artikeln behalten) gibt's eine **Korrekturrechnung** mit dem reduzierten Betrag.

In beiden Fällen siehst du in der Rechnungen-Liste neben der Originalrechnung den Hinweis **"Storno"** oder **"Korrektur"**.

> **💡 Tipp:** Original + Storno + Korrektur ergeben am Ende den korrekten Endbetrag. Das ist wichtig für deine Steuererklärung — alle drei Belege gehören zusammen.

## Schritt 7 — Eigene Rechnung manuell erstellen

Manchmal brauchst du eine Rechnung **außerhalb** einer Marktplatz-Bestellung (z. B. Direktverkauf vor Ort, B2B-Auftrag).

1. Im Rechnungen-Tab oben auf **Neue Rechnung**.
2. Käufer-Daten eintragen (oder bestehenden Kunden auswählen).
3. Artikel hinzufügen (entweder aus deinem Inventar oder als "Freie Position").
4. Versandkosten, MwSt.-Satz prüfen.
5. **Speichern und versenden** klicken — die Mail geht raus, PDF wird erstellt.

> **⚠️ Achtung:** Eine manuelle Rechnung muss **manuell als bezahlt markiert** werden, sobald das Geld auf deinem Konto ist. Sonst bleibt sie als **offen** stehen.

## Schritt 8 — Rechnungs-Layout anpassen

Wenn du das Aussehen deiner Rechnungen anpassen willst (Logo, Farbe, Fußzeile):

1. Geh zu **Einstellungen → Rechnungsvorlage**.
2. Lade dein Logo hoch.
3. Wähle eine Akzentfarbe.
4. Trag deine Bankdaten und Fußzeilen-Texte ein.
5. **Vorschau** klicken — wenn's gut aussieht: **Speichern**.

Ab dem nächsten Versand wird die neue Vorlage automatisch genutzt.

> **💡 Tipp:** Ein professionelles Logo macht einen großen Unterschied bei Premium-Käufern. Investier 10 Minuten in eine gute Rechnungsvorlage — das wirkt seriös und sorgt für gute Bewertungen.

## Häufige Fragen

- **Sind die Rechnungen gesetzeskonform?**  
  Ja, sie enthalten alle Pflichtangaben nach §14 UStG (deutsche MwSt.-Regelung). Die Nummerierung ist fortlaufend und lückenlos. Wenn du Kleinunternehmer bist, fügt AvyCloud automatisch den entsprechenden Hinweis ein (sobald du das im Firmenprofil aktivierst).

- **Kann ich Rechnungen an meine Buchhaltungssoftware exportieren?**  
  Ja, im Rechnungen-Tab oben rechts auf **Export** → DATEV-Format, CSV oder Lexware-kompatibel.

- **Was, wenn der Käufer die Rechnung nicht bekommen hat?**  
  Im Rechnungs-Detail auf **Per Mail an Käufer erneut senden** klicken. Wenn das nicht klappt: PDF runterladen und manuell senden (z. B. über deine normale Mail).

- **Wann wird die Rechnung steuerlich relevant?**  
  In dem Moment, in dem das Rechnungsdatum gesetzt wird (also beim Versand). Bei einer Storno-Rechnung das Datum der Storno-Bestätigung.

- **Kann ich die Rechnungsnummer überspringen oder anpassen?**  
  Nein, das wäre nicht gesetzeskonform. Die Nummerierung läuft fortlaufend ab dem Wert, den du in **Einstellungen → Rechnungsnummer-Start** beim Einrichten festgelegt hast.
