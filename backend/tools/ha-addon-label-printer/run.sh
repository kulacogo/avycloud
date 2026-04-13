#!/bin/sh

# Read config from Home Assistant options (if available)
if [ -f /data/options.json ]; then
  PRINTER_IP=$(cat /data/options.json | grep -o '"printer_ip"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -o '"[^"]*"$' | tr -d '"')
  PORT=$(cat /data/options.json | grep -o '"proxy_port"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$')
fi

PRINTER_IP="${PRINTER_IP:-192.168.178.24}"
export PORT="${PORT:-3001}"
export PRINTER_IP

# Start CUPS daemon
echo "Starting CUPS..."
cupsd

# Wait for CUPS to be ready
sleep 2

# Add the Brother printer via IPP Everywhere (driverless)
echo "Adding printer at ipp://${PRINTER_IP}:631/ipp/print ..."

# Try driverless first — queries printer capabilities and auto-configures
if ipptool -t "ipp://${PRINTER_IP}:631/ipp/print" /usr/share/cups/ipptool/get-printer-attributes.test > /dev/null 2>&1; then
  echo "Printer responds to IPP, configuring driverless..."
  lpadmin -p BrotherQL -E -v "ipp://${PRINTER_IP}:631/ipp/print" -m driverless:"ipp://${PRINTER_IP}:631/ipp/print" 2>/dev/null \
    || lpadmin -p BrotherQL -E -v "ipp://${PRINTER_IP}:631/ipp/print" -m everywhere 2>/dev/null \
    || lpadmin -p BrotherQL -E -v "ipp://${PRINTER_IP}:631/ipp/print" -m raw
else
  echo "Printer not responding to IPP, using raw mode"
  lpadmin -p BrotherQL -E -v "ipp://${PRINTER_IP}:631/ipp/print" -m raw
fi
lpoptions -d BrotherQL

echo "Printer configured:"
lpstat -p -d

# Start the proxy
exec node /app/label-print-proxy.js
