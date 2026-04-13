'use strict';

/**
 * Label Print Proxy — runs on a Raspberry Pi (with Home Assistant or standalone)
 * Receives PDF via HTTP POST, converts to PNG, prints via CUPS.
 * Falls back to raw TCP port 9100 if CUPS print fails.
 *
 * Requires: cups, cups-filters, cups-ipp-utils, poppler-utils
 *
 * Environment variables:
 *   PRINTER_IP     — Brother printer IP address (default: 192.168.178.24)
 *   PORT           — HTTP port for this proxy (default: 3001)
 *   ALLOWED_ORIGIN — CORS origin (default: * for any)
 */

const http = require('http');
const net = require('net');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PRINTER_IP = process.env.PRINTER_IP || '192.168.178.24';
const PORT = parseInt(process.env.PORT || '3001', 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const PRINTER_NAME = 'BrotherQL';

// ─── PDF → PNG Conversion ─────────────────────────────────

function pdfToPng(pdfPath) {
  const pngBase = pdfPath.replace(/\.pdf$/, '');
  execSync(`pdftoppm -png -r 300 -singlefile "${pdfPath}" "${pngBase}"`, { timeout: 15000 });
  return `${pngBase}.png`;
}

// ─── Print Methods ─────────────────────────────────────────

/**
 * Try printing via CUPS (handles format negotiation).
 */
function printViaCups(pdfPath) {
  const output = execSync(
    `lp -d ${PRINTER_NAME} -o fit-to-page -o media=Custom.103x164mm "${pdfPath}"`,
    { timeout: 30000, encoding: 'utf-8' }
  );
  return output.trim();
}

/**
 * Fallback: send PNG directly to printer via raw TCP port 9100.
 * Brother QL printers accept raw data on this port.
 */
function printViaRawTcp(pngPath) {
  return new Promise((resolve, reject) => {
    const data = fs.readFileSync(pngPath);
    const socket = new net.Socket();

    socket.setTimeout(15000);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('TCP timeout (15s)')); });
    socket.on('error', (err) => reject(new Error(`TCP error: ${err.message}`)));

    socket.connect(9100, PRINTER_IP, () => {
      socket.write(data, () => {
        socket.end();
        resolve('sent via TCP:9100');
      });
    });
  });
}

// ─── Print Pipeline ────────────────────────────────────────

async function printLabel(pdfBuffer) {
  const tmpDir = os.tmpdir();
  const id = `label-${Date.now()}`;
  const pdfPath = path.join(tmpDir, `${id}.pdf`);

  try {
    fs.writeFileSync(pdfPath, pdfBuffer);

    // First try CUPS (best quality — handles format conversion)
    try {
      console.log('[print] Trying CUPS...');
      const cupsResult = printViaCups(pdfPath);
      console.log(`[print] CUPS OK: ${cupsResult}`);

      // Wait a moment, then check if job actually completed vs stuck
      await new Promise(r => setTimeout(r, 3000));
      const jobStatus = execSync(`lpstat -W completed -o ${PRINTER_NAME} 2>/dev/null || true`, {
        encoding: 'utf-8', timeout: 5000
      }).trim();

      if (jobStatus) {
        return { ok: true, method: 'cups', message: cupsResult };
      }

      // Job might be stuck — check for errors
      const printerState = execSync(`lpstat -p ${PRINTER_NAME} 2>/dev/null || true`, {
        encoding: 'utf-8', timeout: 5000
      }).trim();

      if (printerState.includes('idle')) {
        // Printer idle after job — probably printed OK
        return { ok: true, method: 'cups', message: cupsResult };
      }

      console.warn(`[print] CUPS job may have failed. Printer state: ${printerState}`);
      // Fall through to PNG conversion + raw TCP
    } catch (cupsErr) {
      console.warn(`[print] CUPS failed: ${cupsErr.message}, trying raw TCP fallback...`);
    }

    // Fallback: convert to PNG and send raw to port 9100
    console.log('[print] Converting PDF to PNG (300 DPI) for raw TCP...');
    const pngPath = pdfToPng(pdfPath);
    const pngSize = (fs.statSync(pngPath).size / 1024).toFixed(1);
    console.log(`[print] PNG ready: ${pngSize} KB, sending via TCP:9100 to ${PRINTER_IP}...`);

    const tcpResult = await printViaRawTcp(pngPath);
    console.log(`[print] TCP OK: ${tcpResult}`);

    try { fs.unlinkSync(pngPath); } catch (_) {}
    return { ok: true, method: 'tcp-raw', message: tcpResult };
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

      console.log(`[print] Received ${(pdfBuffer.length / 1024).toFixed(1)} KB PDF`);

      printLabel(pdfBuffer)
        .then((result) => sendJson(res, 200, result))
        .catch((err) => {
          console.error(`[print] Error: ${err.message}`);
          sendJson(res, 500, { ok: false, error: err.message });
        });
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Label Print Proxy v2.1 (CUPS + TCP fallback)`);
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  Proxy:   http://0.0.0.0:${PORT}`);
  console.log(`  Printer: ${PRINTER_NAME} @ ${PRINTER_IP}`);
  console.log(`  CORS:    ${ALLOWED_ORIGIN}`);
  console.log(`\n  POST /print  — PDF → CUPS (or TCP:9100 fallback)`);
  console.log(`  GET  /health — check status\n`);
});
