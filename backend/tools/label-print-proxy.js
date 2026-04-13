'use strict';

/**
 * Label Print Proxy — runs on a Raspberry Pi (with Home Assistant or standalone)
 * Receives PDF via HTTP POST, converts to PNG, sends to Brother label printer via IPP.
 *
 * Requires: poppler-utils (pdftoppm) for PDF → PNG conversion
 *
 * Environment variables:
 *   PRINTER_IP     — Brother printer IP address (default: 192.168.178.24)
 *   PRINTER_PORT   — IPP port (default: 631)
 *   PORT           — HTTP port for this proxy (default: 3001)
 *   ALLOWED_ORIGIN — CORS origin (default: * for any)
 */

const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PRINTER_IP = process.env.PRINTER_IP || '192.168.178.24';
const PRINTER_PORT = parseInt(process.env.PRINTER_PORT || '631', 10);
const PORT = parseInt(process.env.PORT || '3001', 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ─── PDF → PNG Conversion ─────────────────────────────────

/**
 * Convert a PDF buffer to PNG using pdftoppm.
 * Returns a PNG buffer ready for the Brother printer.
 */
function pdfToPng(pdfBuffer) {
  const tmpDir = os.tmpdir();
  const id = `label-${Date.now()}`;
  const pdfPath = path.join(tmpDir, `${id}.pdf`);
  const pngBase = path.join(tmpDir, id);

  fs.writeFileSync(pdfPath, pdfBuffer);

  // Convert first page to PNG at 300 DPI (good quality for labels)
  execSync(`pdftoppm -png -r 300 -singlefile "${pdfPath}" "${pngBase}"`, { timeout: 10000 });

  const pngPath = `${pngBase}.png`;
  const pngBuffer = fs.readFileSync(pngPath);

  // Cleanup temp files
  try { fs.unlinkSync(pdfPath); } catch (_) {}
  try { fs.unlinkSync(pngPath); } catch (_) {}

  return pngBuffer;
}

// ─── IPP Protocol Helpers ──────────────────────────────────

function ippAttribute(tag, name, value) {
  const nameBuf = Buffer.from(name, 'utf-8');
  const valueBuf = Buffer.from(value, 'utf-8');
  const buf = Buffer.alloc(1 + 2 + nameBuf.length + 2 + valueBuf.length);
  let offset = 0;
  buf.writeUInt8(tag, offset); offset += 1;
  buf.writeUInt16BE(nameBuf.length, offset); offset += 2;
  nameBuf.copy(buf, offset); offset += nameBuf.length;
  buf.writeUInt16BE(valueBuf.length, offset); offset += 2;
  valueBuf.copy(buf, offset);
  return buf;
}

function buildIppPrintJob(printerUri, imageBuffer) {
  const header = Buffer.alloc(8);
  header.writeUInt16BE(0x0200, 0); // IPP version 2.0
  header.writeUInt16BE(0x0002, 2); // Print-Job operation
  header.writeUInt32BE(1, 4);      // request-id

  const opGroupTag = Buffer.from([0x01]);

  const attrs = [
    ippAttribute(0x47, 'attributes-charset', 'utf-8'),
    ippAttribute(0x48, 'attributes-natural-language', 'en'),
    ippAttribute(0x45, 'printer-uri', printerUri),
    ippAttribute(0x49, 'document-format', 'image/png'),
    ippAttribute(0x42, 'job-name', `avycloud-label-${Date.now()}`),
  ];

  const endTag = Buffer.from([0x03]);

  return Buffer.concat([header, opGroupTag, ...attrs, endTag, imageBuffer]);
}

function parseIppResponse(buffer) {
  if (buffer.length < 8) {
    return { ok: false, statusCode: -1, statusMessage: 'Invalid IPP response (too short)' };
  }
  const statusCode = buffer.readUInt16BE(2);
  const ok = statusCode <= 0x00FF;

  const statusMessages = {
    0x0000: 'successful-ok',
    0x0001: 'successful-ok-ignored-substituted-attributes',
    0x0400: 'client-error-bad-request',
    0x0401: 'client-error-forbidden',
    0x0402: 'client-error-not-authenticated',
    0x0404: 'client-error-not-found',
    0x0409: 'client-error-document-format-not-supported',
    0x040a: 'client-error-document-format-not-supported',
    0x0500: 'server-error-internal-error',
    0x0503: 'server-error-busy',
  };

  return {
    ok,
    statusCode,
    statusMessage: statusMessages[statusCode] || `status-0x${statusCode.toString(16).padStart(4, '0')}`,
  };
}

function printViaIpp(imageBuffer) {
  return new Promise((resolve, reject) => {
    const printerUri = `ipp://${PRINTER_IP}:${PRINTER_PORT}/ipp/print`;
    const ippBody = buildIppPrintJob(printerUri, imageBuffer);

    const req = http.request({
      hostname: PRINTER_IP,
      port: PRINTER_PORT,
      path: '/ipp/print',
      method: 'POST',
      headers: {
        'Content-Type': 'application/ipp',
        'Content-Length': ippBody.length,
      },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const ippResponse = parseIppResponse(Buffer.concat(chunks));
        if (ippResponse.ok) {
          resolve(ippResponse);
        } else {
          reject(new Error(`IPP error: ${ippResponse.statusMessage}`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Printer unreachable: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Printer timeout (15s)')); });
    req.write(ippBody);
    req.end();
  });
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
      printer: `ipp://${PRINTER_IP}:${PRINTER_PORT}/ipp/print`,
      model: 'Brother QL-1110NWB',
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
        // Convert PDF → PNG (Brother QL doesn't accept PDF via IPP)
        console.log('[print] Converting PDF to PNG (300 DPI)...');
        const pngBuffer = pdfToPng(pdfBuffer);
        console.log(`[print] PNG ready: ${(pngBuffer.length / 1024).toFixed(1)} KB, sending to ${PRINTER_IP}...`);

        printViaIpp(pngBuffer)
          .then((result) => {
            console.log(`[print] OK: ${result.statusMessage}`);
            sendJson(res, 200, { ok: true, message: result.statusMessage });
          })
          .catch((err) => {
            console.error(`[print] IPP error: ${err.message}`);
            sendJson(res, 500, { ok: false, error: err.message });
          });
      } catch (err) {
        console.error(`[print] Conversion error: ${err.message}`);
        sendJson(res, 500, { ok: false, error: `PDF conversion failed: ${err.message}` });
      }
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Label Print Proxy (PDF → PNG → IPP)`);
  console.log(`  ──────────────────────────────────────`);
  console.log(`  Proxy:   http://0.0.0.0:${PORT}`);
  console.log(`  Printer: ipp://${PRINTER_IP}:${PRINTER_PORT}/ipp/print`);
  console.log(`  Model:   Brother QL-1110NWB`);
  console.log(`  CORS:    ${ALLOWED_ORIGIN}`);
  console.log(`\n  POST /print  — send PDF body → converts to PNG → prints`);
  console.log(`  GET  /health — check status\n`);
});
