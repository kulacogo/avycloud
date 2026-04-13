'use strict';

/**
 * Label Print Proxy — runs on Raspberry Pi (Home Assistant add-on or standalone)
 * Receives PDF via HTTP POST → converts to PNG → prints via brother_ql (TCP:9100).
 *
 * Uses brother_ql_inventree which has native QL-1110NWB support.
 * No CUPS, no IPP, no drivers needed.
 *
 * Environment variables:
 *   PRINTER_IP     — Brother printer IP (default: 192.168.178.24)
 *   LABEL_SIZE     — Label size code (default: 103x164 for DK-11247)
 *   PORT           — HTTP port (default: 3001)
 *   ALLOWED_ORIGIN — CORS origin (default: *)
 */

const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PRINTER_IP = process.env.PRINTER_IP || '192.168.178.24';
const LABEL_SIZE = process.env.LABEL_SIZE || '103x164';
const PORT = parseInt(process.env.PORT || '3001', 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ─── Print Pipeline: PDF → PNG → brother_ql → TCP:9100 ────

function printLabel(pdfBuffer) {
  const tmpDir = os.tmpdir();
  const id = `label-${Date.now()}`;
  const pdfPath = path.join(tmpDir, `${id}.pdf`);
  const pngBase = path.join(tmpDir, id);
  const pngPath = `${pngBase}.png`;

  try {
    fs.writeFileSync(pdfPath, pdfBuffer);

    // 1. PDF → PNG at 300 DPI
    console.log('[print] Converting PDF to PNG (300 DPI)...');
    execSync(`pdftoppm -png -r 300 -singlefile "${pdfPath}" "${pngBase}"`, { timeout: 15000 });

    const pngSize = (fs.statSync(pngPath).size / 1024).toFixed(1);
    console.log(`[print] PNG ready: ${pngSize} KB`);

    // 2. Print via brother_ql (native QL-1110NWB support, TCP:9100)
    console.log(`[print] Sending to QL-1110NWB at ${PRINTER_IP} (label: ${LABEL_SIZE})...`);
    const output = execSync(
      `brother_ql -b network -m QL-1110NWB -p tcp://${PRINTER_IP}:9100 print -l ${LABEL_SIZE} "${pngPath}"`,
      { timeout: 30000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    console.log(`[print] OK: ${output.trim() || 'sent'}`);
    return { ok: true, message: output.trim() || 'Label printed' };
  } finally {
    try { fs.unlinkSync(pdfPath); } catch (_) {}
    try { fs.unlinkSync(pngPath); } catch (_) {}
  }
}

// ─── HTTP Server ───────────────────────────────────────────

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, {
      ok: true,
      printer: `tcp://${PRINTER_IP}:9100`,
      model: 'QL-1110NWB',
      labelSize: LABEL_SIZE,
      method: 'brother_ql_inventree',
    });
  }

  if (req.method === 'POST' && req.url === '/print') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const pdfBuffer = Buffer.concat(chunks);
      if (!pdfBuffer.length) {
        return sendJson(res, 400, { ok: false, error: 'No PDF data received' });
      }

      console.log(`[print] Received ${(pdfBuffer.length / 1024).toFixed(1)} KB PDF`);

      try {
        const result = printLabel(pdfBuffer);
        sendJson(res, 200, result);
      } catch (err) {
        const msg = err.stderr ? err.stderr.toString().trim() : err.message;
        console.error(`[print] Error: ${msg}`);
        sendJson(res, 500, { ok: false, error: msg });
      }
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Label Print Proxy v3 (brother_ql_inventree)`);
  console.log(`  ──────────────────────────────────────────────`);
  console.log(`  Proxy:   http://0.0.0.0:${PORT}`);
  console.log(`  Printer: tcp://${PRINTER_IP}:9100`);
  console.log(`  Model:   Brother QL-1110NWB`);
  console.log(`  Label:   ${LABEL_SIZE}`);
  console.log(`  CORS:    ${ALLOWED_ORIGIN}`);
  console.log(`\n  POST /print  — PDF → PNG → brother_ql → printer`);
  console.log(`  GET  /health — check status\n`);
});
