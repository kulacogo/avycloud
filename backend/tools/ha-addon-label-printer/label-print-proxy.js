'use strict';

/**
 * Label Print Proxy — runs on a Raspberry Pi (with Home Assistant or standalone)
 * Receives PDF via HTTP POST, prints via CUPS (handles format negotiation with printer).
 *
 * Requires: cups, cups-filters, poppler-utils
 *
 * Environment variables:
 *   PRINTER_IP     — Brother printer IP address (default: 192.168.178.24)
 *   PORT           — HTTP port for this proxy (default: 3001)
 *   ALLOWED_ORIGIN — CORS origin (default: * for any)
 */

const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PRINTER_IP = process.env.PRINTER_IP || '192.168.178.24';
const PORT = parseInt(process.env.PORT || '3001', 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const PRINTER_NAME = 'BrotherQL';

// ─── Print via CUPS ────────────────────────────────────────

function printLabel(pdfBuffer) {
  const tmpDir = os.tmpdir();
  const pdfPath = path.join(tmpDir, `label-${Date.now()}.pdf`);

  try {
    fs.writeFileSync(pdfPath, pdfBuffer);

    console.log(`[print] Sending ${(pdfBuffer.length / 1024).toFixed(1)} KB PDF to CUPS printer ${PRINTER_NAME}...`);
    const output = execSync(
      `lp -d ${PRINTER_NAME} "${pdfPath}"`,
      { timeout: 30000, encoding: 'utf-8' }
    );

    console.log(`[print] OK: ${output.trim()}`);
    return { ok: true, message: output.trim() };
  } finally {
    try { fs.unlinkSync(pdfPath); } catch (_) {}
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
    let printerStatus = 'unknown';
    try {
      printerStatus = execSync(`lpstat -p ${PRINTER_NAME}`, { encoding: 'utf-8', timeout: 5000 }).trim();
    } catch (_) {}
    return sendJson(res, 200, {
      ok: true,
      printer: PRINTER_NAME,
      printerIp: PRINTER_IP,
      status: printerStatus,
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
  console.log(`\n  Label Print Proxy (CUPS)`);
  console.log(`  ──────────────────────────`);
  console.log(`  Proxy:   http://0.0.0.0:${PORT}`);
  console.log(`  Printer: ${PRINTER_NAME} @ ${PRINTER_IP}`);
  console.log(`  CORS:    ${ALLOWED_ORIGIN}`);
  console.log(`\n  POST /print  — send PDF → CUPS → printer`);
  console.log(`  GET  /health — check status\n`);
});
