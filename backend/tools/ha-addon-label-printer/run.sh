#!/bin/sh
set -e

# Read config from Home Assistant options
if [ -f /data/options.json ]; then
  PRINTER_IP=$(cat /data/options.json | sed -n 's/.*"printer_ip"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  PRINTER_PORT=$(cat /data/options.json | sed -n 's/.*"printer_port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p')
  PORT=$(cat /data/options.json | sed -n 's/.*"proxy_port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p')
fi

export PRINTER_IP="${PRINTER_IP:-192.168.178.24}"
export PRINTER_PORT="${PRINTER_PORT:-631}"
export PORT="${PORT:-3001}"

echo "Starting Label Print Proxy..."
echo "  Printer: ipp://${PRINTER_IP}:${PRINTER_PORT}/ipp/print"
echo "  Proxy port: ${PORT}"

exec node /app/label-print-proxy.js
