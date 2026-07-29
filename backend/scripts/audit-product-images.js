#!/usr/bin/env node
'use strict';

/**
 * Bild-Audit ueber products_v2 — STRIKT READ-ONLY.
 *
 * Beantwortet zwei Fragen mit Zahlen statt Meinungen:
 *   1. Wie viele Produktbilder liegen auf FREMDEN Servern (und welche davon
 *      duerfen wir aus Urheberrechtsgruenden nicht mal umhosten)?
 *   2. Wie viele Bilder sind kleiner als die eBay-Zoom-Schwelle (1600 px
 *      laengste Kante)? — nur mit --measure, weil dafuer HTTP noetig ist.
 *
 * Klassifizierung kommt komplett aus lib/image-hosts.js (reine Funktionen).
 * Der /api/image-proxy?url=-Wrapper wird ausgepackt: sonst sieht ein
 * durchgereichtes Amazon-Bild wie ein eigenes aus.
 *
 * DIESES SCRIPT SCHREIBT NIE. Es gibt kein --apply. Wird --apply uebergeben,
 * bricht es mit Fehler ab.
 *
 * Aufruf:
 *   node backend/scripts/audit-product-images.js
 *   node backend/scripts/audit-product-images.js --sellable
 *   node backend/scripts/audit-product-images.js --sellable --limit 50
 *   node backend/scripts/audit-product-images.js --blocked-only
 *   node backend/scripts/audit-product-images.js --measure --measure-limit 40
 *   node backend/scripts/audit-product-images.js --json > report.json
 *
 * Flags:
 *   --tenant <id>        Tenant-Filter (default TENANT_ID bzw. 'default')
 *   --sellable           nur Produkte mit inventory.quantity > 0
 *   --limit <n>          maximal n Produkte in der Detailtabelle
 *   --blocked-only       Detailtabelle nur fuer Produkte mit gesperrten Hosts
 *   --foreign-only       Detailtabelle nur fuer Produkte mit Fremdhost-Bildern
 *   --measure            echte Pixelkante per HTTP messen (langsam!)
 *   --measure-limit <n>  max. Bilder fuer --measure (default 30, hart 200)
 *   --measure-timeout    ms pro Bild (default 12000)
 *   --hosts <n>          Top-n Hosts in der Zusammenfassung (default 25)
 *   --json               Report als JSON auf stdout (statt Tabelle)
 */

const path = require('path');

const { classifyImageHost } = require('../lib/image-hosts');

// eBay schaltet die Zoomlupe erst ab dieser laengsten Kante frei.
const EBAY_ZOOM_EDGE = 1600;

// ─── Argumente ───────────────────────────────────────────────────────────────

function parseArgs(argv = process.argv.slice(2)) {
  if (argv.includes('--apply')) {
    console.error('FEHLER: audit-product-images.js ist read-only. --apply gibt es hier nicht.');
    process.exit(2);
  }

  const valueOf = (flag, fallback) => {
    const i = argv.indexOf(flag);
    if (i < 0 || !argv[i + 1]) return fallback;
    const n = parseInt(argv[i + 1], 10);
    return Number.isFinite(n) ? n : fallback;
  };
  const strOf = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };

  const measureLimit = Math.min(valueOf('--measure-limit', 30), 200);

  return {
    tenant: strOf('--tenant', process.env.TENANT_ID || 'default'),
    sellable: argv.includes('--sellable'),
    limit: valueOf('--limit', 40),
    blockedOnly: argv.includes('--blocked-only'),
    foreignOnly: argv.includes('--foreign-only'),
    measure: argv.includes('--measure'),
    measureLimit,
    measureTimeout: valueOf('--measure-timeout', 12000),
    hostsTop: valueOf('--hosts', 25),
    json: argv.includes('--json'),
  };
}

// ─── Bild-URL aus einem details.images-Eintrag ziehen ────────────────────────

function imageUrlOf(entry) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return '';
  const raw = entry.url_or_base64 || entry.url || '';
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && typeof raw.url === 'string') return raw.url;
  return '';
}

// ─── Messung (optional, HTTP) ────────────────────────────────────────────────

async function measureEdge(url, timeoutMs) {
  const fetchImpl = global.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'no_fetch' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'avycloud-image-audit/1.0' },
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    const sharp = require('sharp');
    const meta = await sharp(buf).metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    return {
      ok: true,
      width,
      height,
      longest: Math.max(width, height),
      bytes: buf.length,
      format: meta.format || null,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message ? err.message : String(err)).slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Tabellen-Ausgabe ────────────────────────────────────────────────────────

function pad(value, width, right = false) {
  const s = value == null ? '' : String(value);
  const clipped = s.length > width ? `${s.slice(0, Math.max(1, width - 1))}…` : s;
  return right ? clipped.padStart(width) : clipped.padEnd(width);
}

function printTable(headers, rows) {
  const widths = headers.map((h) => h.width);
  console.log(headers.map((h, i) => pad(h.label, widths[i], h.right)).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(row.map((cell, i) => pad(cell, widths[i], headers[i].right)).join('  '));
  }
}

// ─── Hauptlauf ───────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  // Firestore erst hier laden — Modul-Load stellt eine echte Verbindung her.
  const { firestore } = require('../lib/firestore');
  const collection = process.env.USE_PRODUCTS_V2 === 'false' ? 'products' : 'products_v2';

  if (!opts.json) {
    console.log('============================================================');
    console.log(' BILD-AUDIT — READ-ONLY. Dieses Script schreibt nichts.');
    console.log(` Collection: ${collection} | Tenant: ${opts.tenant}`);
    console.log(` Scope: ${opts.sellable ? 'nur Bestand (quantity > 0)' : 'alle Produkte'}`);
    console.log('============================================================');
  }

  const snap = await firestore
    .collection(collection)
    .select('details.images', 'identification.sku', 'identification.name', 'inventory.quantity', 'tenantId')
    .get();

  const products = [];
  const hostCounts = new Map();
  const totals = {
    docsScanned: 0,
    docsInScope: 0,
    docsWithImages: 0,
    docsWithoutImages: 0,
    docsWithBlocked: 0,
    docsWithForeign: 0,
    images: 0,
    own: 0,
    foreign: 0,
    blocked: 0,
    rehostable: 0,
    unusable: 0,
    proxied: 0,
  };

  for (const doc of snap.docs) {
    totals.docsScanned += 1;
    const tenantId = doc.get('tenantId') || 'default';
    if (opts.tenant && tenantId !== opts.tenant) continue;

    const quantity = Number(doc.get('inventory.quantity')) || 0;
    if (opts.sellable && quantity <= 0) continue;
    totals.docsInScope += 1;

    const rawImages = doc.get('details.images');
    const images = Array.isArray(rawImages) ? rawImages : [];
    if (!images.length) {
      totals.docsWithoutImages += 1;
    } else {
      totals.docsWithImages += 1;
    }

    const classified = [];
    for (const entry of images) {
      const url = imageUrlOf(entry);
      const info = classifyImageHost(url);
      classified.push({ url, ...info });

      totals.images += 1;
      if (info.proxied) totals.proxied += 1;
      if (info.own) totals.own += 1;
      else if (info.blocked) {
        totals.blocked += 1;
        totals.foreign += 1;
      } else if (info.rehostable) {
        totals.rehostable += 1;
        totals.foreign += 1;
      } else {
        totals.unusable += 1;
      }

      const key = info.host || `<${info.reason}>`;
      const bucket = hostCounts.get(key) || { host: key, count: 0, own: 0, blocked: 0, rehostable: 0 };
      bucket.count += 1;
      if (info.own) bucket.own += 1;
      if (info.blocked) bucket.blocked += 1;
      if (info.rehostable) bucket.rehostable += 1;
      hostCounts.set(key, bucket);
    }

    const blockedCount = classified.filter((c) => c.blocked).length;
    const foreignCount = classified.filter((c) => !c.own && (c.blocked || c.rehostable)).length;
    if (blockedCount) totals.docsWithBlocked += 1;
    if (foreignCount) totals.docsWithForeign += 1;

    products.push({
      id: doc.id,
      sku: doc.get('identification.sku') || doc.id,
      name: doc.get('identification.name') || '',
      quantity,
      imageCount: classified.length,
      ownCount: classified.filter((c) => c.own).length,
      rehostableCount: classified.filter((c) => c.rehostable).length,
      blockedCount,
      foreignCount,
      unusableCount: classified.filter((c) => !c.own && !c.blocked && !c.rehostable).length,
      blockedHosts: Array.from(new Set(classified.filter((c) => c.blocked).map((c) => c.host))),
      images: classified,
    });
  }

  // ─── Optionale Messung ────────────────────────────────────────────────────
  const measurements = [];
  if (opts.measure) {
    const queue = [];
    for (const p of products) {
      for (const img of p.images) {
        if (!img.url) continue;
        if (img.reason === 'data_uri' || img.reason === 'empty' || img.reason === 'relative_path') continue;
        queue.push({ sku: p.sku, url: img.url, host: img.host, own: img.own, blocked: img.blocked });
        if (queue.length >= opts.measureLimit) break;
      }
      if (queue.length >= opts.measureLimit) break;
    }
    if (!opts.json) {
      console.log(`\nMesse ${queue.length} Bilder per HTTP (Timeout ${opts.measureTimeout} ms)…`);
    }
    for (const item of queue) {
      /* eslint-disable no-await-in-loop */
      const m = await measureEdge(item.url, opts.measureTimeout);
      measurements.push({ ...item, ...m });
      /* eslint-enable no-await-in-loop */
    }
  }

  // ─── Report ───────────────────────────────────────────────────────────────

  const hostRows = Array.from(hostCounts.values()).sort((a, b) => b.count - a.count);

  const measuredOk = measurements.filter((m) => m.ok);
  const belowZoom = measuredOk.filter((m) => m.longest < EBAY_ZOOM_EDGE);

  const report = {
    generatedAt: new Date().toISOString(),
    collection,
    tenant: opts.tenant,
    scope: opts.sellable ? 'sellable' : 'all',
    totals: {
      ...totals,
      foreignShare: totals.images ? Number((totals.foreign / totals.images).toFixed(4)) : 0,
      blockedShare: totals.images ? Number((totals.blocked / totals.images).toFixed(4)) : 0,
    },
    hosts: hostRows,
    measured: opts.measure
      ? {
          attempted: measurements.length,
          ok: measuredOk.length,
          failed: measurements.length - measuredOk.length,
          belowEbayZoom: belowZoom.length,
          belowEbayZoomShare: measuredOk.length
            ? Number((belowZoom.length / measuredOk.length).toFixed(4))
            : 0,
          zoomEdge: EBAY_ZOOM_EDGE,
          samples: measurements,
        }
      : null,
    products: products.map((p) => ({ ...p, images: undefined })),
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Detailtabelle
  let detail = products.filter((p) => p.imageCount > 0);
  if (opts.blockedOnly) detail = detail.filter((p) => p.blockedCount > 0);
  if (opts.foreignOnly) detail = detail.filter((p) => p.foreignCount > 0);
  detail.sort((a, b) => b.blockedCount - a.blockedCount || b.foreignCount - a.foreignCount);
  const shown = detail.slice(0, opts.limit);

  console.log(`\n── Produkte (${shown.length} von ${detail.length} angezeigt) ──`);
  printTable(
    [
      { label: 'SKU', width: 18 },
      { label: 'Bez', width: 5, right: true },
      { label: 'Bild', width: 5, right: true },
      { label: 'eigen', width: 5, right: true },
      { label: 'rehost', width: 6, right: true },
      { label: 'GESPERRT', width: 8, right: true },
      { label: 'gesperrte Hosts', width: 30 },
      { label: 'Titel', width: 40 },
    ],
    shown.map((p) => [
      p.sku,
      p.quantity,
      p.imageCount,
      p.ownCount,
      p.rehostableCount,
      p.blockedCount,
      p.blockedHosts.join(','),
      p.name,
    ])
  );

  console.log(`\n── Hosts (Top ${opts.hostsTop}) ──`);
  printTable(
    [
      { label: 'Host', width: 46 },
      { label: 'Bilder', width: 7, right: true },
      { label: 'eigen', width: 6, right: true },
      { label: 'rehost', width: 6, right: true },
      { label: 'GESPERRT', width: 8, right: true },
    ],
    hostRows
      .slice(0, opts.hostsTop)
      .map((h) => [h.host, h.count, h.own, h.rehostable, h.blocked])
  );

  if (opts.measure) {
    console.log(`\n── Messung (${measuredOk.length}/${measurements.length} abrufbar) ──`);
    printTable(
      [
        { label: 'SKU', width: 18 },
        { label: 'Host', width: 34 },
        { label: 'Kante', width: 6, right: true },
        { label: 'Pixel', width: 12, right: true },
        { label: 'Zoom?', width: 6 },
        { label: 'Fehler', width: 22 },
      ],
      measurements.map((m) => [
        m.sku,
        m.host,
        m.ok ? m.longest : '-',
        m.ok ? `${m.width}x${m.height}` : '-',
        m.ok ? (m.longest >= EBAY_ZOOM_EDGE ? 'ja' : 'NEIN') : '-',
        m.ok ? '' : m.error,
      ])
    );
    console.log(
      `\nUnter eBay-Zoom-Schwelle (${EBAY_ZOOM_EDGE} px): ` +
        `${belowZoom.length} von ${measuredOk.length} gemessenen ` +
        `(${measuredOk.length ? Math.round((belowZoom.length / measuredOk.length) * 100) : 0} %)`
    );
  }

  const pct = (n) => (totals.images ? `${Math.round((n / totals.images) * 1000) / 10} %` : '0 %');
  console.log('\n── Summe ──');
  console.log(
    `Produkte im Scope: ${totals.docsInScope} (mit Bild ${totals.docsWithImages}, ohne Bild ${totals.docsWithoutImages}) ` +
      `von ${totals.docsScanned} gescannt`
  );
  console.log(
    `Bilder gesamt: ${totals.images} | eigen ${totals.own} (${pct(totals.own)}) | ` +
      `fremd ${totals.foreign} (${pct(totals.foreign)}) | davon GESPERRT ${totals.blocked} (${pct(totals.blocked)}) | ` +
      `umhostbar ${totals.rehostable} (${pct(totals.rehostable)}) | unbrauchbar ${totals.unusable}`
  );
  console.log(
    `Produkte mit gesperrten Bildern: ${totals.docsWithBlocked} | ` +
      `Produkte mit Fremdbildern: ${totals.docsWithForeign} | ` +
      `image-proxy-Wrapper: ${totals.proxied}`
  );
  console.log('\n(read-only — es wurde nichts geschrieben)');
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(`[audit-product-images] ${err && err.message ? err.message : err}`);
      if (err && err.stack) console.error(err.stack);
      process.exit(1);
    }
  );
}

module.exports = { imageUrlOf, parseArgs, EBAY_ZOOM_EDGE, measureEdge };
