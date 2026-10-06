#!/bin/bash
#
# Druck-Agent einrichten — fragt E-Mail und Passwort lokal ab.
#
# Alles andere ist bereits bekannt und hier eingetragen:
#   - Backend-Adresse
#   - Firebase-Schluessel (oeffentlich, steckt auch im Frontend-Bundle)
#   - Drucker (automatisch am eingelegten Rollenformat erkannt,
#     NICHT am Namen — Namen aendern sich)
#
# Das Passwort wird nur zur Anmeldung verwendet und nicht gespeichert.
# Die erneuerbare Sitzung liegt unter Application Support, Modus 600.

set -euo pipefail

AGENT_VERZEICHNIS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# Das Installationsprogramm prüft echte Rechte, speichert eine erneuerbare
# Sitzung (kein Passwort) und kopiert den Agenten aus dem Checkout heraus.
export AVYCLOUD_URL FIREBASE_API_KEY AGENT_EMAIL AGENT_PASSWORT PRINTER_PARCEL PRINTER_LETTER
node "$AGENT_VERZEICHNIS/install.js"
unset AGENT_PASSWORT
