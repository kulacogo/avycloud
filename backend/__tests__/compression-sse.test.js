/**
 * Antwort-Komprimierung (2026-08-03, Kostenanalyse Juli: 758 GiB Egress =
 * 69,74 €). Der kritische Punkt ist NICHT die Ersparnis, sondern dass
 * Live-Verbindungen weiterlaufen: `compression` puffert Antworten, und ein
 * gepufferter SSE-Stream bedeutet für den Betrieb, dass Auftrags-Benachrichti-
 * gungen, Chat-Antworten und der Erfassen-Fortschritt nicht mehr ankommen.
 * Der Integrationstest unten fährt einen echten Server hoch und beweist, dass
 * SSE-Chunks VOR dem Antwortende beim Client landen.
 */
const http = require('http');
const express = require('express');
const compression = require('compression');
const { makeCompressionFilter } = require('../lib/compression-filter');

describe('makeCompressionFilter', () => {
  const alwaysTrue = () => true;
  const resWith = (contentType) => ({ getHeader: () => contentType });

  it('komprimiert JSON-Antworten', () => {
    const filter = makeCompressionFilter(alwaysTrue);
    expect(filter({ headers: {} }, resWith('application/json'))).toBe(true);
  });

  it('komprimiert SSE NIEMALS (auch mit charset-Suffix)', () => {
    const filter = makeCompressionFilter(alwaysTrue);
    expect(filter({ headers: {} }, resWith('text/event-stream'))).toBe(false);
    expect(filter({ headers: {} }, resWith('text/event-stream; charset=utf-8'))).toBe(false);
    expect(filter({ headers: {} }, resWith('TEXT/EVENT-STREAM'))).toBe(false);
  });

  it('respektiert den Notausstieg x-no-compression', () => {
    const filter = makeCompressionFilter(alwaysTrue);
    expect(filter({ headers: { 'x-no-compression': '1' } }, resWith('application/json'))).toBe(false);
  });

  it('reicht an den Standard-Filter durch (z.B. bereits komprimierte Bilder)', () => {
    const filter = makeCompressionFilter(() => false);
    expect(filter({ headers: {} }, resWith('image/jpeg'))).toBe(false);
  });

  it('funktioniert ohne Content-Type und ohne Standard-Filter', () => {
    const filter = makeCompressionFilter(null);
    expect(filter({ headers: {} }, { getHeader: () => undefined })).toBe(true);
  });
});

describe('Integration: echter Server mit Komprimierung', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    const app = express();
    app.use(compression({ filter: makeCompressionFilter(compression.filter), threshold: 0 }));

    // Nachbau des SSE-Musters aus routes/sse.js: Header zuerst, dann Chunks.
    app.get('/events', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.flushHeaders();
      res.write('data: {"type":"hello"}\n\n');
      setTimeout(() => {
        res.write('data: {"type":"tick"}\n\n');
        res.end();
      }, 250);
    });

    app.get('/products', (req, res) => {
      res.json({ products: Array.from({ length: 500 }, (_, i) => ({ id: i, name: 'Produkt '.repeat(20) })) });
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('liefert SSE-Chunks SOFORT aus (nicht gepuffert bis zum Ende)', async () => {
    const { firstChunkAt, endAt, encoding } = await new Promise((resolve, reject) => {
      const started = Date.now();
      let first = null;
      const req = http.get(`${baseUrl}/events`, { headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
        res.on('data', () => { if (first === null) first = Date.now() - started; });
        res.on('end', () => resolve({
          firstChunkAt: first,
          endAt: Date.now() - started,
          encoding: res.headers['content-encoding'],
        }));
      });
      req.on('error', reject);
    });

    // Kern der Aussage: der erste Chunk kommt deutlich vor dem Ende an.
    expect(encoding).toBeUndefined();
    expect(firstChunkAt).not.toBeNull();
    expect(endAt - firstChunkAt).toBeGreaterThan(100);
  });

  it('komprimiert die Produktliste und spart dabei deutlich Bandbreite', async () => {
    const fetchSize = (acceptEncoding) => new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}/products`, { headers: { 'Accept-Encoding': acceptEncoding } }, (res) => {
        let bytes = 0;
        res.on('data', (c) => { bytes += c.length; });
        res.on('end', () => resolve({ bytes, encoding: res.headers['content-encoding'] }));
      });
      req.on('error', reject);
    });

    const plain = await fetchSize('identity');
    const gzipped = await fetchSize('gzip');

    expect(plain.encoding).toBeUndefined();
    expect(gzipped.encoding).toBe('gzip');
    expect(gzipped.bytes).toBeLessThan(plain.bytes * 0.5);
  });
});
