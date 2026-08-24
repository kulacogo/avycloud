# AvyCloud Foto-Agent

Erfasst neue Produktfotos vom lokalen Datei-Share automatisch und legt sie
danach in den IDENT-Ordner.

```
smb://192.168.178.61/ProduktFotos
  RAW_INBOX/            neue Fotos hier ablegen (die NAS sortiert nach Datum)
  RAW/JJJJ-MM-TT/       wartet auf Erfassung   <- der Agent liest hier
  IDENT/JJJJ-MM-TT/     erfasst und abgelegt   <- der Agent legt hier ab
  FEHLER/JJJJ-MM-TT/    mehrfach gescheitert   <- braucht einen Menschen
```

## Warum ein eigenes Programm

Das Backend läuft auf Cloud Run in `europe-west3` und kann eine private Adresse
wie `192.168.178.61` prinzipiell nicht erreichen. Ein Cron-Job im Backend würde
den Share also nie sehen. Der Agent läuft im selben Netz wie der Share und
spricht über HTTPS mit den **bestehenden** Schnittstellen — es wurde dafür keine
neue Route gebaut.

## Was der Agent tut

1. Nimmt sich jeden Ordner `RAW/JJJJ-MM-TT` vor.
2. **Ruhezeit:** ist das jüngste Foto weniger als 30 Minuten alt, bleibt der
   Ordner liegen. Sonst würde ein Lauf mitten in die Fotosession fallen und die
   Bilder eines Produkts auf zwei Läufe zerreißen — das erzeugt genau die
   Dublette, die der Umbau verhindern soll. (Gemessen: die größte Lücke
   *innerhalb* einer Session lag bei 27,6 Minuten.)
3. **Los:** liest `LOS.txt` aus dem Tagesordner. Fehlt sie, bleibt der Ordner
   liegen und wird gemeldet. Der Agent rät nie — am Los hängt der Einkaufspreis.
4. Liest die **Aufnahmezeit aus dem EXIF**, nicht die Dateizeit. Auf dem Share
   tragen ganze Tagesstapel dieselbe Kopierzeit (gemessen: 63 Dateien vom 17.08.
   mit Dateizeit 13:49, echte Aufnahmen 13:38 bis 15:29).
5. Zerteilt den Tag in handliche Blöcke (je Gerät, an großen Zeitlücken).
   **Dieser Schritt entscheidet nicht, was ein Produkt ist** — das macht die
   Bilderkennung von AvyCloud (`POST /api/v2/group-images`).
6. Erfasst jede erkannte Gruppe (`POST /api/v2/identify`). Ob das Produkt schon
   existiert, entscheidet der Server (siehe `DEDUP_SEARCH`).
7. Verschiebt die Fotos nach `IDENT/JJJJ-MM-TT`.

**Ein Foto wird nie gelöscht.** Was dreimal scheitert, wandert nach
`FEHLER/JJJJ-MM-TT` — sonst kostet es bei jedem Lauf erneut Geld.

## LOS.txt

Eine Textdatei im Tagesordner mit genau einem Los-Code. Zeilen mit `#` sind
Kommentar.

```
# Auktion München, Mischware
L-081703
```

Gültig sind `L-MMJJNN` (Auktions-Los) und `NL-MMJJ` (Non-Los). Steht in der
ersten inhaltlichen Zeile kein gültiger Code, bleibt der Ordner liegen.

## Einrichten

```bash
cd tools/foto-agent
npm test          # 34 Tests, keine Abhängigkeiten
node index.js --dry-run
```

Der Trockenlauf zeigt, welche Ordner er anfassen würde und wie er die Fotos
aufteilt. Er meldet sich nicht an, erfasst nichts und verschiebt nichts.

### Zugangsdaten

Ein **eigenes Firebase-Konto** für den Agenten anlegen, nicht das eines
Mitarbeiters mitbenutzen — sonst laufen seine Erfassungen unter deren Namen in
der Mitarbeiter-Auswertung.

| Variable | Bedeutung |
|----------|-----------|
| `AVYCLOUD_URL` | z. B. `https://product-hub-backend-79205549235.europe-west3.run.app` |
| `FIREBASE_API_KEY` | Web-API-Schlüssel des Firebase-Projekts |
| `AGENT_EMAIL` / `AGENT_PASSWORT` | Zugangsdaten des Dienstkontos |
| `FOTO_SHARE` | Voreinstellung `/Volumes/ProduktFotos` |
| `FOTO_RUHEZEIT_MINUTEN` | Voreinstellung `30` |
| `FOTO_MAX_PRO_LAUF` | Voreinstellung `10` Produkte je Lauf |
| `FOTO_MAX_VERSUCHE` | Voreinstellung `3`, danach nach `FEHLER/` |
| `FOTO_KONTINGENT` | Voreinstellung `12` Erfassungen je 15 Minuten |
| `FOTO_AGENT_REGISTER` | Voreinstellung `~/.avycloud-foto-agent.json` |

### Warum die Drossel wichtig ist

`identifyLimiter` lässt 30 Anfragen je 15 Minuten zu, und der Zähler läuft
**vor** der Anmeldung — also pro IP-Adresse. Der Agent teilt sie sich mit jedem
Mitarbeiter im selben Büro. Ohne Drossel würde ein Stapellauf den
Erfassen-Assistenten der Kollegen für 15 Minuten sperren. Voreingestellt nimmt
der Agent nur 12 der 30 Anfragen.

### Alle 30 Minuten laufen lassen (macOS)

`~/Library/LaunchAgents/cloud.avy.foto-agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>cloud.avy.foto-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/oguz/Dev/avycloud/tools/foto-agent/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AVYCLOUD_URL</key><string>https://…run.app</string>
    <key>FIREBASE_API_KEY</key><string>…</string>
    <key>AGENT_EMAIL</key><string>foto-agent@…</string>
    <key>AGENT_PASSWORT</key><string>…</string>
  </dict>
  <key>StartInterval</key><integer>1800</integer>
  <key>StandardOutPath</key><string>/tmp/foto-agent.log</string>
  <key>StandardErrorPath</key><string>/tmp/foto-agent.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/cloud.avy.foto-agent.plist
```

Der Rechner muss laufen und den Share gemountet haben. Läuft der Agent auf der
NAS selbst (Node ≥ 20), entfällt beides — dann zeigt `FOTO_SHARE` auf den
lokalen Pfad statt auf `/Volumes/...`.

## Register

`~/.avycloud-foto-agent.json` merkt sich je Foto (nach Inhalts-Hash), ob es
erfasst wurde. Das ist die **zweite** Markierung neben dem Verschieben: gelingt
die Erfassung, scheitert aber das Verschieben, liefe die Datei sonst beim
nächsten Lauf erneut durch die Erkennung. Der Erfolg wird deshalb sofort nach
der Erfassung vermerkt, noch vor dem Verschieben.

Das Register zu löschen ist ungefährlich, solange in `RAW/` nur unerfasste
Fotos liegen — es wird dann neu aufgebaut.
