#!/bin/bash
#
# Druck-Agent einrichten — fragt genau EINE Sache ab: das Passwort.
#
# Alles andere ist bereits bekannt und hier eingetragen:
#   - Backend-Adresse
#   - Firebase-Schluessel (oeffentlich, steckt auch im Frontend-Bundle)
#   - Drucker (automatisch am eingelegten Rollenformat erkannt,
#     NICHT am Namen — Namen aendern sich)
#
# Das Passwort wird NICHT in dieser Datei gespeichert, sondern nur in der
# launchd-Datei unter ~/Library/LaunchAgents (nur fuer dich lesbar, chmod 600).

set -euo pipefail

AGENT_VERZEICHNIS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/de.trendocean.print-agent.plist"

AVYCLOUD_URL="https://product-hub-backend-79205549235.europe-west3.run.app"
FIREBASE_API_KEY="AIzaSyBP0YAdmyTiGTIJwA1q5bvEF2lUxmHoq9U"
echo "AvyCloud Druck-Agent einrichten"
echo "==============================="
echo

# ── Drucker bestimmen ────────────────────────────────────────────────────────
# UEBER DAS ROLLENFORMAT, NICHT UEBER DEN NAMEN. Namen aendern sich (aus
# "Versandlabel" wurde "DHL_DPD_Label" und die Einrichtung brach ab); das
# eingelegte Rollenformat ist die stabile Eigenschaft.
# Gesetzte PRINTER_PARCEL / PRINTER_LETTER gewinnen immer.
ERKANNT=$(AGENT_DIR="$AGENT_VERZEICHNIS" node -e '
const { sammleDrucker, ermittleDrucker } = require(process.env.AGENT_DIR + "/lib/drucker");
(async () => {
  const alle = await sammleDrucker();
  const zeile = [];
  for (const rolle of ["parcel", "letter"]) {
    const r = ermittleDrucker(rolle, alle);
    zeile.push(r.name || "");
    zeile.push((r.kandidaten || []).join("|"));
  }
  console.log(zeile.join("\t"));
})().catch(() => console.log("\t\t\t"));
' 2>/dev/null)

AUTO_PARCEL=$(echo "$ERKANNT" | cut -f1)
KAND_PARCEL=$(echo "$ERKANNT" | cut -f2)
AUTO_LETTER=$(echo "$ERKANNT" | cut -f3)
KAND_LETTER=$(echo "$ERKANNT" | cut -f4)

PRINTER_PARCEL="${PRINTER_PARCEL:-$AUTO_PARCEL}"
PRINTER_LETTER="${PRINTER_LETTER:-$AUTO_LETTER}"

fehlt() {
  echo "FEHLER: Kein Drucker fuer $1 ($2) gefunden."
  if [ -n "$3" ]; then echo "  Kandidaten waren: $3 (nicht eindeutig)"; fi
  echo "  Vorhandene Drucker und ihre Formate:"
  for d in $(lpstat -a 2>/dev/null | awk '{print $1}'); do
    M=$(lpoptions -p "$d" -l 2>/dev/null | grep -i "^PageSize" | sed 's/.*: //' | tr ' ' '\n' | tr -d '*' | grep -E "^(103x164|62x100)mm$" | tr '\n' ' ')
    printf "    %-24s %s\n" "$d" "${M:-(kein Etikettenformat)}"
  done
  echo
  echo "  Dann von Hand setzen, z. B.:"
  echo "    PRINTER_PARCEL=DHL_DPD_Label PRINTER_LETTER=DP_Label bash $0"
  exit 1
}

if [ -z "$PRINTER_PARCEL" ]; then fehlt "DHL/DPD" "103x164 mm" "$KAND_PARCEL"; fi
if [ -z "$PRINTER_LETTER" ]; then fehlt "Deutsche Post" "62x100 mm" "$KAND_LETTER"; fi

for drucker in "$PRINTER_PARCEL" "$PRINTER_LETTER"; do
  if ! lpstat -p "$drucker" >/dev/null 2>&1; then
    echo "FEHLER: Drucker \"$drucker\" existiert nicht."
    lpstat -a 2>/dev/null | awk '{print "  - " $1}'
    exit 1
  fi
done

echo "Drucker erkannt (am Rollenformat, nicht am Namen):"
echo "  103x164 mm (DHL/DPD)      -> $PRINTER_PARCEL"
echo "  62x100 mm (Deutsche Post) -> $PRINTER_LETTER"
echo

# ── Zugang abfragen ──────────────────────────────────────────────────────────
read -r -p "E-Mail des Kontos, unter dem der Agent laufen soll: " AGENT_EMAIL
if [[ "$AGENT_EMAIL" != *"@trendocean.de" ]]; then
  echo "FEHLER: Das Backend laesst nur Adressen auf @trendocean.de zu."
  exit 1
fi
read -r -s -p "Passwort: " AGENT_PASSWORT
echo
echo

# ── Anmeldung sofort pruefen, bevor irgendetwas eingerichtet wird ────────────
echo "Pruefe Anmeldung…"
ANTWORT="$(curl -s -X POST \
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$FIREBASE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$AGENT_EMAIL\",\"password\":\"$AGENT_PASSWORT\",\"returnSecureToken\":true}")"

if ! grep -q '"idToken"' <<<"$ANTWORT"; then
  echo "FEHLER: Anmeldung fehlgeschlagen."
  sed -E 's/.*"message": ?"([^"]+)".*/  Grund: \1/' <<<"$ANTWORT" | head -1
  exit 1
fi
echo "  Anmeldung ok."

# ── Schreibrecht auf Auftraege pruefen ───────────────────────────────────────
TOKEN="$(sed -E 's/.*"idToken": ?"([^"]+)".*/\1/' <<<"$ANTWORT")"
STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" "$AVYCLOUD_URL/api/print/status")"
if [ "$STATUS" != "200" ]; then
  echo "FEHLER: Konto darf die Druckwarteschlange nicht lesen (HTTP $STATUS)."
  echo "        Es braucht Schreibrecht auf Auftraege (orders:write)."
  exit 1
fi
echo "  Zugriff auf die Druckwarteschlange ok."
echo

# ── launchd-Datei schreiben ──────────────────────────────────────────────────
NODE_PFAD="$(command -v node)"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLISTENDE
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>de.trendocean.print-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PFAD</string>
    <string>$AGENT_VERZEICHNIS/index.js</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>AVYCLOUD_URL</key><string>$AVYCLOUD_URL</string>
    <key>FIREBASE_API_KEY</key><string>$FIREBASE_API_KEY</string>
    <key>AGENT_EMAIL</key><string>$AGENT_EMAIL</string>
    <key>AGENT_PASSWORT</key><string>$AGENT_PASSWORT</string>
    <key>PRINTER_PARCEL</key><string>$PRINTER_PARCEL</string>
    <key>PRINTER_LETTER</key><string>$PRINTER_LETTER</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/avycloud-print-agent.log</string>
  <key>StandardErrorPath</key><string>/tmp/avycloud-print-agent.err</string>
</dict></plist>
PLISTENDE
# Enthaelt das Passwort — nur fuer den eigenen Benutzer lesbar.
chmod 600 "$PLIST"
echo "Eingerichtet: $PLIST"

# ── Starten ──────────────────────────────────────────────────────────────────
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Agent gestartet."
echo
echo "Warte auf die erste Lebendmeldung…"
for i in $(seq 1 15); do
  sleep 2
  ONLINE="$(curl -s -H "Authorization: Bearer $TOKEN" "$AVYCLOUD_URL/api/print/status" \
    | grep -o '"online":[a-z]*' | head -1)"
  if [ "$ONLINE" = '"online":true' ]; then
    echo "  Agent ist in AvyCloud sichtbar. Fertig."
    echo
    echo "Ab jetzt druckt der Knopf \"Etikett drucken\" direkt auf dem richtigen Geraet."
    echo "Protokoll: tail -f /tmp/avycloud-print-agent.log"
    exit 0
  fi
done

echo "  Noch keine Meldung. Protokoll ansehen:"
echo "    tail -20 /tmp/avycloud-print-agent.log /tmp/avycloud-print-agent.err"
exit 1
