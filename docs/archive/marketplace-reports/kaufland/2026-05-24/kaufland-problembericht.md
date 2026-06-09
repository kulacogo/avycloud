# Kaufland-Integration — Problembericht für die Geschäftsführung

**Stand:** 24. Mai 2026
**Für:** Geschäftsführung / IT-Service-Management (nicht-technisch)
**Erstellt nach:** direkter Prüfung der echten Kaufland-Daten (nicht aus AvyCloud, sondern direkt bei Kaufland abgefragt)

---

## Das Wichtigste in einem Satz

AvyCloud und Kaufland erzählen zwei verschiedene Geschichten darüber, was bei uns
online ist — und beide Zahlen, die AvyCloud anzeigt, sind aus unterschiedlichen
Gründen falsch. Das eigentliche Listing funktioniert inzwischen **teilweise**,
scheitert aber fast immer am letzten Pflichtfeld.

---

## Die drei Zahlen, die nicht zusammenpassen

Wenn man dieselbe Frage — "Wie viele Angebote sind aktiv?" — an drei Stellen
stellt, kommen drei verschiedene Antworten:

| Quelle | Sagt "aktiv" | Was die Zahl WIRKLICH bedeutet |
|--------|-------------|-------------------------------|
| **Kaufland-Portal** (die Wahrheit) | **309** | Tatsächlich kaufbare Angebote |
| **Kaufland-Schnittstelle (API)** | **394** | Angebote, die WIR anbieten (Status "verfügbar") |
| **AvyCloud-Oberfläche** | **330 + 64 = 394** | Zählt unseren Angebots-Status, nicht die echte Kaufbarkeit |

**Übersetzt:**
- Wir bieten Kaufland **394** Artikel an.
- Kaufland zeigt davon nur **309** als wirklich kaufbar.
- Die **85 Differenz** sind Artikel, die wir anbieten, die Kaufland aber
  **versteckt**, weil die Produktdaten unvollständig sind.
- AvyCloud merkt diesen Unterschied **nicht** — es hält alle 394 für aktiv.

> **Analogie:** Stellen Sie sich ein Schaufenster vor. Wir stellen 394 Produkte
> hinein. Kaufland hängt aber bei 85 davon einen Vorhang davor ("fehlende Daten"),
> sodass Kunden nur 309 sehen. AvyCloud schaut von hinten ins Schaufenster und
> zählt 394 — und meldet alles sei sichtbar.

---

## Problem 1: "92 erfolgreich gelistet" ist irreführend

Beim letzten Bulk-Listing meldete AvyCloud: *"92 von 100 erfolgreich gelistet"*.

**Was wirklich passiert ist:**
- "Erfolgreich gelistet" heißt nur: das **Angebot wurde bei Kaufland angelegt**.
- Es heißt **nicht**: das Produkt ist kaufbar.

**Stichprobe (7 frisch gelistete Artikel, direkt bei Kaufland geprüft):**
Alle 7 stehen auf `nicht kaufbar` — es fehlt bei fast jedem genau **ein**
Pflichtfeld:

| Artikel | Was noch fehlt |
|---------|---------------|
| 6 von 7 | **Materialzusammensetzung** (bei Kleidung Pflicht) |
| 1 von 7 | GPSR-Kontakt fehlerhaft formatiert |
| (Nebenbefund) | 1 Bild abgelehnt, weil dasselbe Bild doppelt geschickt |

> **Das bedeutet:** Die Meldung "92 erfolgreich" sollte ehrlicherweise lauten
> *"92 Angebote angelegt — davon werden die meisten erst kaufbar, sobald das
> letzte Pflichtfeld ergänzt ist."*

**Gute Nachricht:** Der Kategorie-Fix von letzter Woche **wirkt**. Vorher fehlten
diesen Artikeln **5 Pflichtfelder** (Kaufland lehnte alles ab). Jetzt fehlt nur
noch **1**. Wir sind also von "gar nichts geht durch" auf "fast fertig" gekommen.

---

## Problem 2: AvyCloud zeigt "Inaktiv", obwohl der Artikel live verkauft wird

**Beispiel:** Die *ZMH Pendelleuchte 3-flammig* (SKU-1194071499).

- **Bei Kaufland:** live, kaufbar, 25,86 € — verkauft sich (Sie haben sie selbst
  im Shop gefunden).
- **In AvyCloud:** als **"Inaktiv"** markiert.

**Ursache:** Kaufland hat diesem Angebot irgendwann eine **neue interne Nummer**
gegeben (von `391697909106` auf `392125425300`). AvyCloud hat die **alte Nummer**
behalten und als "tot" (STALE) markiert — die neue Nummer wurde nie sauber
übernommen.

> **Analogie:** Ein Mitarbeiter bekommt eine neue Personalnummer. Unser System
> führt ihn unter der alten Nummer als "ausgeschieden", obwohl er jeden Tag zur
> Arbeit kommt — nur unter neuer Nummer.

**Warum das gefährlich ist:** Wir könnten denken, ein Artikel sei offline und uns
nicht darum kümmern — während er in Wahrheit verkauft wird (oder umgekehrt:
Bestand verkauft sich, ohne dass wir es im Blick haben → Übe­rverkauf-Risiko).

---

## Problem 3: AvyCloud zeigt 865 Angebote — real existieren nur 397

AvyCloud-Oberfläche oben: **865 Listings**. Die Wahrheit bei Kaufland: **397**.

**Aufschlüsselung der 865 im AvyCloud-Speicher:**

| Kategorie | Anzahl | Bedeutung |
|-----------|--------|-----------|
| AVAILABLE | 394 | Echte Angebote, die wir anbieten |
| ONHOLD | 3 | Pausierte Angebote |
| **STALE** | **468** | **Karteileichen — alte/tote Einträge, nie aufgeräumt** |

Die **468 STALE-Einträge** sind alte Angebots-Nummern, die längst ersetzt oder
gelöscht wurden. AvyCloud zeigt sie als **"Inaktiv" (468)** an — aber das sind
keine echten inaktiven Angebote, sondern **digitaler Müll**, der nie weggeräumt
wurde.

> **Das bedeutet:** Die "468 Inaktiv" in AvyCloud sind eine Schreckenszahl, die
> in Wahrheit größtenteils aus Karteileichen besteht. Real hat Kaufland nur
> **88 inaktive** Angebote (laut Portal).

---

## Problem 4: Die Kategorie-Vorhersage trifft manchmal absurde Kategorien

Damit ein Angebot überhaupt durchkommt, "rät" AvyCloud neuerdings die passende
Kaufland-Kategorie aus Titel + Beschreibung. Das funktioniert oft, aber manchmal
daneben:

| Echtes Produkt | Geratene Kategorie | Bewertung |
|----------------|-------------------|-----------|
| Stradivarius Damen Spitzen-Body | "Erotik-BH" | grenzwertig (Kauflands Baum führt Wäsche unter Erotik) |
| Sloggi Hipster (Unterwäsche) | "Erotik-Hipster" | nach Kauflands Logik korrekt |
| TEE-UU **Rettungs**messer | "**Kampf**messer" | **falsch** |
| Android Autoradio **mit GPS** | "Navigationsgerät" | grenzwertig |

**Zusätzliches Risiko:** Selbst wenn Kaufland einem Produkt **schon eine richtige
Kategorie** zugewiesen hat, überschreibt AvyCloud sie aktuell mit der eigenen
Vorhersage. Das kann ein korrekt einsortiertes Produkt in eine falsche Kategorie
verschieben.

---

## Problem 5: Das letzte Pflichtfeld — der eigentliche Show-Stopper

Nach allen Fixes scheitert die Aktivierung fast immer an **einem** verbleibenden
Pflichtfeld. Die häufigsten drei:

1. **Materialzusammensetzung** (z. B. "95 % Baumwolle, 5 % Elasthan") — bei
   Kleidung/Textilien von Kaufland zwingend verlangt. AvyCloud schickt es nicht
   zuverlässig mit.
2. **GPSR-Verantwortliche-Person** — der EU-Sicherheitskontakt wird manchmal in
   einem Format geschickt, das Kaufland ablehnt ("invalid_value").
3. **Bild abgelehnt** — teils weil dasselbe Bild mehrfach geschickt wird
   ("duplicate_value"), teils weil Kaufland unsere Bild-Adresse nicht herunterladen
   kann ("media_not_downloadable").

---

## Zusammenfassung: Was ist kaputt, was funktioniert?

| Bereich | Status |
|---------|--------|
| Kategorie-Erkennung (technisch durchbringen) | ✅ funktioniert (5 → 1 fehlendes Feld) |
| Materialzusammensetzung mitsenden | ❌ fehlt → blockiert die meisten Kleidungsartikel |
| GPSR-Kontakt-Format | ⚠️ manchmal abgelehnt |
| Bilder (Duplikate / nicht erreichbar) | ⚠️ manchmal abgelehnt |
| Kategorie-Vorhersage-Qualität | ⚠️ manchmal absurd, überschreibt korrekte Kategorien |
| **Statusanzeige in AvyCloud** | ❌ **falsch** — zeigt Karteileichen als "Inaktiv", verpasst neue Angebots-Nummern |
| **Zählung Aktiv/Inaktiv** | ❌ **falsch** — verwechselt "angeboten" mit "kaufbar" |

---

## Die zwei getrennten Großbaustellen

Es ist wichtig zu verstehen, dass das **zwei verschiedene Probleme** sind, die
oft verwechselt werden:

### Baustelle A — "Bekommen wir Artikel kaufbar?"
Das ist das Listing-Problem. Fortschritt vorhanden (Kategorie-Fix wirkt), aber das
letzte Pflichtfeld (meist Materialzusammensetzung) muss noch zuverlässig
mitgeschickt werden.

### Baustelle B — "Zeigt AvyCloud die Wahrheit an?"
Das ist das Anzeige-/Synchronisations-Problem. AvyCloud zählt falsch (865 statt
397, 394 "aktiv" statt 309 kaufbar) und verpasst geänderte Angebots-Nummern (ZMH
Lampe). Selbst wenn das Listing perfekt liefe, würde AvyCloud die Lage falsch
darstellen.

**Diese beiden Baustellen müssen getrennt angegangen werden.** Bisher wurde fast
nur an Baustelle A gearbeitet — Baustelle B (die Anzeige) ist der Grund, warum
selbst Erfolge nicht sichtbar werden und Zahlen nie stimmen.

---

## NACHTRAG 24. Mai (nach tiefer Live-Untersuchung): Die wichtigste Erkenntnis

Bei der direkten Untersuchung an der echten Kaufland-Schnittstelle ist der
**eigentliche Kern** zutage getreten — er erklärt, warum manche Artikel sofort
laufen und andere nie:

### Kaufland besitzt den Produktkatalog, nicht wir

Jeder Artikel auf Kaufland hängt an einem **Katalog-Eintrag**, der entweder
"gültig" (`is_valid=true`) oder "Rohling" (`is_valid=false`) ist.

| Fall | Was passiert |
|------|-------------|
| **Kaufland kennt das Produkt schon** (Markenware: Boss, Tommy Hilfiger, PME Legend …) | Katalog ist bereits gültig. Wir hängen nur unser Angebot dran → **sofort kaufbar, ganz ohne Produktdaten von uns.** |
| **Nur wir verkaufen das Produkt** (No-Name, Eigenimport, Triumph-Restposten …) | Katalog ist ein leerer Rohling. **Wir müssen ALLES selbst befüllen** — und genau hier blockiert Kaufland. |

**Belegt durch Stichprobe:** Von unseren aktiven Textilien hatten zwei (Boss,
PME Legend) **gar keine** Materialangabe in unseren Daten — trotzdem kaufbar,
weil Kaufland den Katalog selbst befüllt hat. Die Problemfälle (Triumph,
Room99, Stradivarius) sind dagegen Rohlinge, die nur wir befüllen.

### Die Material-Mauer bei Textilien

Für Textil-Rohlinge, die nur wir befüllen, haben wir getestet:
- Material in **korrektem Format** geschickt ("100% Polyester", "85% Polyamid,
  15% Elastan" — exakt nach Kauflands eigener Vorschrift)
- **Richtige Kategorie** gesetzt (Bikinihose, Tagesdecke, Lederjacke)
- **Komplettes Textil-Set** mitgeschickt (Farbe, Größe, Muster, Material) —
  alle anderen Felder wurden **akzeptiert**

**Ergebnis:** Kaufland **speichert** unseren Material-Wert, zeigt ihn aber
dauerhaft als "fehlend" an. Egal welches Format, welche Vollständigkeit. Das ist
**kein Fehler auf unserer Seite** — wir liefern alles korrekt. Kaufland erkennt
bei selbst-befüllten Textil-Rohlingen die Materialzusammensetzung schlicht nicht
an.

> **Übersetzung für die GF:** Bei Markenware läuft alles automatisch. Bei
> No-Name-Textilien, die nur wir führen, stehen wir vor einer Wand, die wir
> über die Schnittstelle nicht durchbrechen können — hier braucht es entweder
> den **Kaufland-Support** (Katalog-Freischaltung) oder die manuelle Eingabe im
> **Kaufland-Portal** ("Produktdaten verwalten").

### Was technisch verbessert wurde (heute)

- **Materialdaten werden jetzt überhaupt mitgeschickt.** Vorher: nie beim ersten
  Listing. Jetzt: AvyCloud führt die zersplitterten Material-Felder ("80%" +
  "Polyamid, Polyester") intelligent zu einem gültigen Wert zusammen
  ("Polyamid, Polyester" bzw. "85% Polyamid, 15% Elastan").
- **Wirkung:** Hilft allen **Nicht-Textilien**, die eine Materialangabe brauchen
  (Möbel, Elektro, Küche — z. B. "Kunstleder, Metall"). Bei diesen ist Material
  oft das letzte fehlende Feld, und das ist jetzt gelöst.
- **Bei Textilien:** notwendige Voraussetzung, aber wegen der Kaufland-Mauer
  nicht ausreichend.

### Empfehlung

1. **Materialdaten-Verbesserung übernehmen** (hilft Nicht-Textilien sofort,
   schadet nichts — getestet, 2075 Tests grün).
2. **Kaufland-Support-Ticket** für die Textil-Rohlinge (Katalog-Freischaltung) —
   das ist der einzige bekannte Weg, diese Wand zu durchbrechen.
3. **Baustelle B trotzdem angehen** — damit AvyCloud wenigstens die Wahrheit
   anzeigt (Karteileichen weg, kaufbar statt angeboten zählen). Das ist zu 100 %
   in unserer Hand und schafft Vertrauen in die Zahlen.
