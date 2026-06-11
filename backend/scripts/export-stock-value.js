/* eslint-disable no-console */
/**
 * Warenbestand-Export mit Verkaufswert (read-only).
 *
 * Exportiert NUR Produkte, die physisch auf Lager sind (inventory.quantity > 0).
 * Pro Position: Verkaufspreis je Stück, Lagerbestand und Verkaufswert (Preis × Menge).
 * Am Ende: Gesamt-Verkaufswert über alle Positionen.
 *
 * Effektiver Verkaufspreis = details.pricing.sellPrice (bestätigter Override) wenn gesetzt,
 * sonst details.pricing.lowest_price.amount (recherchierter Marktpreis) — exakt die Regel,
 * die AdminTable.tsx "Preis"-Spalte und lib/kaufland-api.js verwenden.
 *
 * Usage:
 *   cd backend && node scripts/export-stock-value.js
 *
 * Output (Excel-DE-freundlich: Semikolon-Trennung, Komma-Dezimal, UTF-8 BOM):
 *   backend/exports/warenbestand-verkaufswert.csv
 */

const fs = require('fs');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');

const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
});

const OUT_DIR = path.join(__dirname, '..', 'exports');
const OUT_FILE = path.join(OUT_DIR, 'warenbestand-verkaufswert.csv');

// Deutsche Zahlen-Formatierung (Komma als Dezimaltrenner, kein Tausenderpunkt im CSV-Wert)
function num(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return value.toFixed(2).replace('.', ',');
}

// CSV-Feld für Semikolon-Trennung escapen
function csv(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[";\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Effektiver Verkaufspreis je Stück + Quelle (mirror AdminTable.tsx:624-630)
function resolveUnitPrice(pricing) {
  const sell = Number(pricing?.sellPrice);
  if (Number.isFinite(sell) && sell > 0) {
    return { price: sell, source: 'bestätigt (sellPrice)' };
  }
  const market = Number(pricing?.lowest_price?.amount);
  if (Number.isFinite(market) && market > 0) {
    return { price: market, source: 'Marktpreis-Schätzung' };
  }
  return { price: null, source: 'kein Preis' };
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('Lese products_v2 …');
  const snap = await firestore.collection('products_v2').get();

  const rows = [];
  let totalUnits = 0;
  let totalValue = 0;
  let noPriceCount = 0;

  snap.forEach((doc) => {
    const d = doc.data() || {};
    const qty = Number(d.inventory?.quantity ?? 0);
    if (!(qty > 0)) return; // nur was auf Lager ist

    const pricing = d.details?.pricing || {};
    const { price, source } = resolveUnitPrice(pricing);
    const currency = pricing?.lowest_price?.currency || 'EUR';
    const lineValue = price !== null ? price * qty : null;

    if (price === null) noPriceCount++;
    totalUnits += qty;
    if (lineValue !== null) totalValue += lineValue;

    rows.push({
      sku: d.identification?.sku || d.details?.identifiers?.sku || doc.id,
      name: d.identification?.name || '',
      brand: d.identification?.brand || '',
      ean: d.details?.identifiers?.ean || d.details?.identifiers?.gtin || '',
      qty,
      price,
      source,
      currency,
      lineValue,
    });
  });

  // Wertvollste Positionen zuerst — schneller Überblick übers gebundene Kapital
  rows.sort((a, b) => (b.lineValue || 0) - (a.lineValue || 0));

  const header = [
    'SKU',
    'Name',
    'Marke',
    'EAN',
    'Lagerbestand (Stück)',
    'Verkaufspreis je Stück',
    'Preisquelle',
    'Währung',
    'Verkaufswert (Position)',
  ];

  const lines = [header.map(csv).join(';')];
  for (const r of rows) {
    lines.push([
      csv(r.sku),
      csv(r.name),
      csv(r.brand),
      csv(r.ean),
      csv(r.qty),
      csv(num(r.price)),
      csv(r.source),
      csv(r.currency),
      csv(num(r.lineValue)),
    ].join(';'));
  }

  // Summen-Zeile
  lines.push('');
  lines.push([
    csv('GESAMT'),
    csv(`${rows.length} Positionen`),
    '',
    '',
    csv(totalUnits),
    '',
    '',
    'EUR',
    csv(num(totalValue)),
  ].join(';'));

  // UTF-8 BOM, damit Excel die Umlaute korrekt liest
  fs.writeFileSync(OUT_FILE, '﻿' + lines.join('\r\n'), 'utf8');

  console.log('');
  console.log('✓ Export geschrieben:', OUT_FILE);
  console.log('  Positionen auf Lager :', rows.length);
  console.log('  Stückzahl gesamt     :', totalUnits);
  console.log('  Verkaufswert gesamt  :', num(totalValue), 'EUR');
  if (noPriceCount > 0) {
    console.log('  ⚠ ohne Preis (Wert=0):', noPriceCount, '— in CSV mit leerem Verkaufswert');
  }
}

main().catch((err) => {
  console.error('FEHLER:', err.message);
  process.exit(1);
});
