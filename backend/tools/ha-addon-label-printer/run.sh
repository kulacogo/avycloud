#!/bin/sh

# Read config from Home Assistant options (if available)
if [ -f /data/options.json ]; then
  export PRINTER_IP=$(cat /data/options.json | grep -o '"printer_ip"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -o '"[^"]*"$' | tr -d '"')
  export LABEL_SIZE=$(cat /data/options.json | grep -o '"label_size"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -o '"[^"]*"$' | tr -d '"')
  export PORT=$(cat /data/options.json | grep -o '"proxy_port"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$')
fi

export PRINTER_IP="${PRINTER_IP:-192.168.178.24}"
export LABEL_SIZE="${LABEL_SIZE:-103x164}"
export PORT="${PORT:-3001}"

echo "Starting Label Print Proxy v3 (brother_ql_inventree)..."
echo "  Printer: tcp://${PRINTER_IP}:9100"
echo "  Model:   QL-1110NWB"
echo "  Label:   ${LABEL_SIZE}"
echo "  Port:    ${PORT}"

exec node /app/label-print-proxy.js
