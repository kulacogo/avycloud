'use strict';

/**
 * Label Print Proxy — runs on a Raspberry Pi (with Home Assistant or standalone)
 * Receives PDF via HTTP POST and sends it directly to a Brother label printer via IPP.
 * No CUPS required — speaks IPP natively.
 *
 * Setup:
 *   1. Copy this file to the Raspberry Pi
 *   2. Run:  PRINTER_IP=192.168.178.24 node label-print-proxy.js
 *   3. In AvyCloud Profile Settings, set Label-Drucker Proxy URL to:
 *      http://<raspberry-pi-ip>:3001
 *
 * Environment variables:
 *   PRINTER_IP     — Brother printer IP address (default: 192.168.178.24)
 *   PRINTER_PORT   — IPP port (default: 631)
 *   PORT           — HTTP port for this proxy (default: 3001)
 *   ALLOWED_ORIGIN — CORS origin (default: * for any)
 *
 * As Docker container:
 *   docker run -d --name label-proxy --network host \
 *     -e PRINTER_IP=192.168.178.24 \
 *     node:20-slim node /app/label-print-proxy.js
 */

const http = require('http');

const PRINTER_IP = process.env.PRINTER_IP || '192.168.178.24';
const PRINTER_PORT = parseInt(process.env.PRINTER_PORT || '631', 10);
const PORT = parseInt(process.env.PORT || '3001', 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ─── IPP Protocol Helpers ──────────────────────────────────

/**
 * Encode a string as IPP attribute value.
 * Format: [value-tag(1)] [name-len(2)] [name] [value-len(2)] [value]
 */
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

/**
 * Build an IPP Print-Job request body with embedded PDF data.
 */
function buildIppPrintJob(printerUri, pdfBuffer) {
  // IPP header: version 2.0, operation Print-Job (0x0002), request-id 1
  const header = Buffer.alloc(8);
  header.writeUInt16BE(0x0200, 0); // IPP version 2.0
  header.writeUInt16BE(0x0002, 2); // Print-Job operation
  header.writeUInt32BE(1, 4);      // request-id

  // Operation attributes group tag
  const opGroupTag = Buffer.from([0x01]);

  // Required operation attributes
  const attrs = [
    ippAttribute(0x47, 'attributes-charset', 'utf-8'),
    ippAttribute(0x48, 'attributes-natural-language', 'en'),
    ippAttribute(0x45, 'printer-uri', printerUri),
    ippAttribute(0x49, 'document-format', 'application/pdf'),
    ippAttribute(0x42, 'job-name', `avycloud-label-${Date.now()}`),
  ];

  // End of attributes
  const endTag = Buffer.from([0x03]);

  return Buffer.concat([header, opGroupTag, ...attrs, endTag, pdfBuffer]);
}

/**
 * Parse minimal IPP response to check if the print job was accepted.
 * Returns { ok, statusCode, statusMessage }
 */
function parseIppResponse(buffer) {
  if (buffer.length < 8) {
    return { ok: false, statusCode: -1, statusMessage: 'Invalid IPP response (too short)' };
  }
  const statusCode = buffer.readUInt16BE(2);
  // IPP status 0x0000 = successful-ok, 0x0001 = successful-ok-ignored-or-substituted-attributes
  const ok = statusCode <= 0x00FF;

  const statusMessages = {
    0x0000: 'successful-ok',
    0x0001: 'successful-ok-ignored-substituted-attributes',
    0x0400: 'client-error-bad-request',
    0x0401: 'client-error-forbidden',
    0x0402: 'client-error-not-authenticated',
    0x0404: 'client-error-not-found',
    0x0409: 'client-error-document-format-not-supported',
    0x0500: 'server-error-internal-error',
    0x0503: 'server-error-busy',
  };

  return {
    ok,
    statusCode,
    statusMessage: statusMessages[statusCode] || `status-0x${statusCode.toString(16).padStart(4, '0')}`,
  };
}

/**
 * Send a PDF to the Brother printer via IPP Print-Job operation.
 */
function printViaIpp(pdfBuffer) {
  return new Promise((resolve, reject) => {
    const printerUri = `ipp://${PRINTER_IP}:${PRINTER_PORT}/ipp/print`;
    const ippBody = buildIppPrintJob(printerUri, pdfBuffer);

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
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  // Health check — also pings the printer to verify IPP connectivity
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, {
      ok: true,
      printer: `ipp://${PRINTER_IP}:${PRINTER_PORT}/ipp/print`,
      model: 'Brother QL-1110NWB',
    });
  }

  // Print endpoint
  if (req.method === 'POST' && req.url === '/print') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const pdfBuffer = Buffer.concat(chunks);
      if (!pdfBuffer.length) {
        return sendJson(res, 400, { ok: false, error: 'No PDF data received' });
      }

      console.log(`[print] Received ${(pdfBuffer.length / 1024).toFixed(1)} KB PDF, sending to ${PRINTER_IP}...`);

      printViaIpp(pdfBuffer)
        .then((result) => {
          console.log(`[print] OK: ${result.statusMessage}`);
          sendJson(res, 200, { ok: true, message: result.statusMessage });
        })
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
  console.log(`\n  Label Print Proxy (IPP direct)`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  Proxy:   http://0.0.0.0:${PORT}`);
  console.log(`  Printer: ipp://${PRINTER_IP}:${PRINTER_PORT}/ipp/print`);
  console.log(`  Model:   Brother QL-1110NWB`);
  console.log(`  CORS:    ${ALLOWED_ORIGIN}`);
  console.log(`\n  POST /print  — send PDF body to print`);
  console.log(`  GET  /health — check status\n`);
});
