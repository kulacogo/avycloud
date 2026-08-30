# AvyCloud Druck-Agent

Holt Druckaufträge aus AvyCloud und schickt sie an den richtigen
Etikettendrucker. Damit sieht der Bediener am Handscanner **nie wieder Androids
Teilen-/Druckauswahl** und muss **nie wieder den Drucker raten**.

## Warum ein eigenes Programm

Das Backend läuft auf Cloud Run in `europe-west3` und kann eine private
LAN-Adresse (`192.168.x.x`) **prinzipiell nicht** erreichen. Und der Browser des
Handscanners darf von einer HTTPS-Seite aus kein `http://` im lokalen Netz
aufrufen (gemischte Inhalte werden blockiert). Beide Wege sind zu.

Also andersherum: AvyCloud legt den Auftrag ab, der Agent im Büro holt ihn.
Gleiches Muster wie `tools/foto-agent/`.

## Die zwei Rollen

| Rolle    | Maß          | Transporteur          | ENV               |
|----------|--------------|-----------------------|-------------------|
| `parcel` | 103 × 164 mm | DHL, DPD              | `PRINTER_PARCEL`  |
| `letter` |  62 × 100 mm | Deutsche Post         | `PRINTER_LETTER`  |

Welches Etikett welche Rolle hat, entscheidet **das Backend**
(`backend/lib/label-format.js`) — nie der Agent. Zwei Wahrheiten würden
auseinanderdriften.

**Fehlt ein Druckername, wird NICHT gedruckt.** Der Agent weicht bewusst nicht
auf den Standarddrucker aus: ein 103-mm-Paketetikett auf der 62-mm-Briefrolle
hat einen abgeschnittenen Barcode, und das Paket bleibt im Verteilzentrum
liegen.

## Einrichtung — ein Befehl

```bash
bash tools/print-agent/einrichten.sh
```

Fragt **nur** E-Mail und Passwort. Alles andere ist vorausgefüllt. Das Skript

1. prüft, dass beide Drucker existieren,
2. prüft die Anmeldung **und** das Schreibrecht, bevor es irgendetwas einrichtet,
3. schreibt `~/Library/LaunchAgents/de.trendocean.print-agent.plist` (`chmod 600`,
   enthält das Passwort),
4. startet den Agenten und wartet auf die erste Lebendmeldung.

Bricht einer der Schritte ab, wird nichts halb eingerichtet zurückgelassen.

### Am Gerät gemessen (2026-08-24)

| CUPS-Name       | Beschreibung   | Gerät              | Rolle    |
|-----------------|----------------|--------------------|----------|
| `DHL_DPD_Label` | DHL/DPD Label  | Brother QL-1110NWB | `parcel` |
| `DP_Label`      | DP Label       | Brother QL-820NWB  | `letter` |

Beide führen die Rollenformate **benannt**: `103x164mm` bzw. `62x100mm`.

**Die Namen stehen nirgends fest verdrahtet.** Setup und Agent erkennen den
Drucker am eingelegten **Rollenformat**: nur ein Gerät führt `103x164mm`. Für die
Briefrolle reicht das Maß allein nicht (`DP_Label` und `SKU_Label` führen beide
`62x100mm`), deshalb scheidet der Paketdrucker dort aus (er führt beide Maße) und
`SKU` wird abgewertet. Bei Gleichstand wird **nicht geraten** — dann
`PRINTER_PARCEL` / `PRINTER_LETTER` setzen, die gewinnen immer.

Hintergrund: Am 2026-08-24 wurde `Versandlabel` in `DHL_DPD_Label` umbenannt und
die Einrichtung brach ab, weil der Name fest eingetragen war.

### Manueller Betrieb (ohne launchd)

```bash
export AVYCLOUD_URL="https://product-hub-backend-79205549235.europe-west3.run.app"
export FIREBASE_API_KEY="…"   # steht in .env.local als VITE_FIREBASE_API_KEY
export AGENT_EMAIL="…@trendocean.de"
export AGENT_PASSWORT="…"
export PRINTER_PARCEL="DHL_DPD_Label"   # nur noetig, wenn die Erkennung nicht eindeutig ist
export PRINTER_LETTER="DP_Label"

npm run dry-run   # holt Aufträge, druckt aber nichts
npm start         # Dauerbetrieb
```

## Warum `103x164mm` und nicht `Custom.103x164mm`

Das ist **nicht dasselbe**. Der benannte Eintrag ist die vom Treiber kalibrierte
Rollenvorlage samt der echten nicht bedruckbaren Ränder; bei `Custom.` schätzt
CUPS die Ränder selbst. Der Unterschied fällt als *versetzter Druck* auf — und
niemand findet die Ursache.

Der Agent liest deshalb beim Start `lpoptions -p <Drucker> -l` und nimmt den
benannten Eintrag, wenn der Drucker ihn führt. Beim Start meldet er, welcher Weg
gilt:

```
103x164 mm -> "DHL_DPD_Label" (media=103x164mm, kalibriert)
62x100 mm -> "DP_Label" (media=62x100mm, kalibriert)
```

Steht dort `geschätzt`, führt der Drucker das Maß nicht benannt — dann lohnt es,
das Rollenformat im Treiber anzulegen.

## Weitere Schalter

| Variable              | Vorgabe | Bedeutung |
|-----------------------|---------|-----------|
| `PRINT_AGENT_ID`      | Rechnername | Kennung in der Agentenliste |
| `PRINT_POLL_MS`       | `2000`  | Abfragetakt |
| `PRINT_FIT_TO_PAGE`   | `on`    | `off` = ohne Einpassen drucken |

`PRINT_FIT_TO_PAGE` steht bewusst auf `on`: Das PDF hat bereits exakt das
Rollenmaß, aber jeder Drucker hat einen nicht bedruckbaren Rand. Ohne Einpassen
schneidet genau dieser Rand den Barcode an. Das Einpassen behält das
Seitenverhältnis bei, es verzerrt nichts.

## Dauerbetrieb einrichten (launchd, macOS)

`~/Library/LaunchAgents/de.trendocean.print-agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>de.trendocean.print-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/oguz/Dev/avycloud/tools/print-agent/index.js</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>AVYCLOUD_URL</key><string>…</string>
    <key>FIREBASE_API_KEY</key><string>…</string>
    <key>AGENT_EMAIL</key><string>…</string>
    <key>AGENT_PASSWORT</key><string>…</string>
    <key>PRINTER_PARCEL</key><string>…</string>  <!-- optional, Erkennung reicht -->
    <key>PRINTER_LETTER</key><string>…</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/avycloud-print-agent.log</string>
  <key>StandardErrorPath</key><string>/tmp/avycloud-print-agent.err</string>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/de.trendocean.print-agent.plist
```

## Wenn der Agent nicht läuft

AvyCloud merkt das (der Agent meldet sich alle 30 s) und **fällt automatisch auf
den alten Teilen-Weg zurück**. Der Bediener kann weiterarbeiten — er sieht dann
wieder Androids Druckauswahl, aber nichts bleibt liegen. Ein Auftrag bei totem
Agenten stumm einzureihen wäre schlimmer: das Paket bliebe unfrankiert stehen,
ohne dass es jemand merkt.

## Tests

```bash
npm test    # 19 Tests, laufen auch im Wurzel-`npm test` mit
```
