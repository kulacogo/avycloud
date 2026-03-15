#!/bin/bash
# Fügt Serena MCP zu Claude Desktop Config hinzu
# Erstellt automatisch ein Backup vorher

CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
BACKUP="$HOME/Library/Application Support/Claude/claude_desktop_config.json.backup"

echo "=== Serena MCP zu Claude Desktop hinzufügen ==="

# Backup
cp "$CONFIG" "$BACKUP"
echo "✓ Backup erstellt: claude_desktop_config.json.backup"

# Prüfen ob jq vorhanden
if ! command -v jq &> /dev/null; then
  echo "jq nicht gefunden. Installiere mit: brew install jq"
  echo "Oder füge manuell ein (siehe unten)."
  echo ""
  echo 'Nach "home-assistant": { ... }, füge hinzu:'
  echo '    "serena": {'
  echo '      "command": "uvx",'
  echo '      "args": ["--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server", "/Users/oguz/Dev/avycloud"]'
  echo '    }'
  exit 1
fi

# Serena hinzufügen via jq
jq '.mcpServers.serena = {
  "command": "uvx",
  "args": ["--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server", "/Users/oguz/Dev/avycloud"]
}' "$CONFIG" > "$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"

echo "✓ Serena MCP hinzugefügt"
echo ""
echo "Neue Config:"
cat "$CONFIG" | jq .
echo ""
echo "=== Jetzt Claude Desktop neu starten ==="
