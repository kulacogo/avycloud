'use strict';

/**
 * export-legacy-books.js — GoBD/GDPdU-Export der Geschäftsbücher für den
 * TrendOcean Einzelunternehmen → GmbH Cutover.
 *
 * Exportiert die geschäfts- und behördenrelevanten Collections (Bestellungen,
 * Rechnungen, Retouren, Versand) als:
 *   - CSV pro Tabelle  (Semikolon-getrennt, Dezimal-Komma, UTF-8, CRLF — das
 *     Format, das Prüfsoftware wie IDEA erwartet)
 *   - JSONL pro Tabelle (volle Rohdaten, verlustfrei)
 *   - index.xml nach dem GDPdU-Beschreibungsstandard (gdpdu-01-09-2004), der
 *     die CSVs für die Prüfsoftware der Finanzbehörden beschreibt
 *   - _manifest.json mit Zählern + ok-Gate
 *
 * Die Rechnungs-PDFs sichert weiterhin export-legacy-invoices.js — beide
 * Skripte gehören zum Cutover-Archiv. DRY-RUN by default; schreibt nur mit
 * --apply. Liest Firestore nur (keine Mutation).
 */

const { writeFileDurable } = require('./export-legacy-invoices');

// ─── CSV-Primitiven ─────────────────────────────────────────────────────────

/** Quotet Werte mit Semikolon/Quote/Zeilenumbruch (Quote-Verdopplung). */
function csvEscape(value) {
  const s = String(value);
  if (/[;"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Formatiert einen Zellwert: Beträge mit Dezimal-Komma, null/undefined leer. */
function formatCsvValue(value, type) {
  if (value === null || value === undefined) return '';
  if (type === 'numeric') {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return n.toFixed(2).replace('.', ',');
  }
  return String(value);
}

/** Baut die komplette CSV (Header + Zeilen, CRLF). */
function toCsv(columns, docs) {
  const header = columns.map((c) => csvEscape(c.name)).join(';');
  const rows = docs.map((d) =>
    columns.map((c) => csvEscape(formatCsvValue(c.get(d), c.type))).join(';')
  );
  return [header, ...rows].join('\r\n') + '\r\n';
}

// ─── GDPdU index.xml ────────────────────────────────────────────────────────

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * index.xml nach GDPdU-Beschreibungsstandard (gdpdu-01-09-2004.dtd): beschreibt
 * jede CSV (Trennzeichen, Dezimal-Komma, Spalten + Typen), damit die Prüf-
 * software der Finanzverwaltung sie direkt einlesen kann.
 */
function buildIndexXml({ supplierName, location = '', comment = '', tables = [] }) {
  const columnXml = (col, isKey) => {
    const tag = isKey ? 'VariablePrimaryKey' : 'VariableColumn';
    const type = col.type === 'numeric'
      ? '<Numeric><Accuracy>2</Accuracy></Numeric>'
      : '<AlphaNumeric/>';
    return `        <${tag}><Name>${xmlEscape(col.name)}</Name>${type}</${tag}>`;
  };

  const tableXml = (t) => {
    const cols = t.columns || [];
    const [first, ...rest] = cols;
    return [
      '    <Table>',
      `      <URL>${xmlEscape(t.url)}</URL>`,
      `      <Name>${xmlEscape(t.name)}</Name>`,
      `      <Description>${xmlEscape(t.description || '')}</Description>`,
      t.from && t.to
        ? `      <Validity><Range><From>${xmlEscape(t.from)}</From><To>${xmlEscape(t.to)}</To></Range></Validity>`
        : null,
      '      <UTF8/>',
      '      <DecimalSymbol>,</DecimalSymbol>',
      '      <DigitGroupingSymbol>.</DigitGroupingSymbol>',
      '      <Range><From>2</From></Range>', // Zeile 1 = Header
      '      <VariableLength>',
      '        <ColumnDelimiter>;</ColumnDelimiter>',
      '        <TextEncapsulator>"</TextEncapsulator>',
      first ? columnXml(first, true) : null,
      ...rest.map((c) => columnXml(c, false)),
      '      </VariableLength>',
      '    </Table>',
    ].filter(Boolean).join('\n');
  };

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004.dtd">',
    '<DataSet>',
    '  <Version>1.0</Version>',
    '  <DataSupplier>',
    `    <Name>${xmlEscape(supplierName || '')}</Name>`,
    `    <Location>${xmlEscape(location)}</Location>`,
    `    <Comment>${xmlEscape(comment)}</Comment>`,
    '  </DataSupplier>',
    '  <Media>',
    '    <Name>Datentraeger 1</Name>',
    ...tables.map(tableXml),
    '  </Media>',
    '</DataSet>',
    '',
  ].join('\n');
}

// ─── Vollständigkeits-Gate ──────────────────────────────────────────────────

/** ok ⇔ pro Collection: Firestore-Count === CSV-Zeilen === JSONL-Zeilen. */
function verifyBooksExport(tableResults) {
  const mismatches = [];
  for (const t of tableResults) {
    if (t.firestoreCount !== t.csvRows || t.firestoreCount !== t.jsonlLines) {
      mismatches.push(
        `${t.name}: Firestore=${t.firestoreCount}, CSV=${t.csvRows}, JSONL=${t.jsonlLines}`
      );
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

// ─── Tabellen-Spezifikationen (defensiv gegen Feld-Varianten) ───────────────

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

const BOOK_TABLES = [
  {
    collection: 'orders',
    name: 'Bestellungen',
    description: 'Marktplatz-Bestellungen (eBay/Kaufland) mit Status und Betrag',
    columns: [
      { name: 'id', type: 'alphanumeric', get: (d) => d.id },
      { name: 'auftragsnummer', type: 'alphanumeric', get: (d) => d.orderNumber || d.number || null },
      { name: 'marktplatz', type: 'alphanumeric', get: (d) => d.marketplace || d.source || null },
      { name: 'marktplatz_bestellnr', type: 'alphanumeric', get: (d) => d.marketplaceOrderId || null },
      { name: 'status', type: 'alphanumeric', get: (d) => d.omsStatus || d.status || null },
      { name: 'kunde', type: 'alphanumeric', get: (d) => d.customer?.name || null },
      { name: 'betrag_brutto', type: 'numeric', get: (d) => num(d.totalAmount) },
      { name: 'waehrung', type: 'alphanumeric', get: (d) => d.currency || 'EUR' },
      { name: 'bestellt_am', type: 'alphanumeric', get: (d) => d.orderedAt || d.createdAt || null },
      { name: 'versendet_am', type: 'alphanumeric', get: (d) => d.shippedAt || null },
      { name: 'rechnungsnummer', type: 'alphanumeric', get: (d) => d.invoiceNumber || null },
    ],
  },
  {
    collection: 'invoices',
    name: 'Rechnungen',
    description: 'Ausgangsrechnungen (Nummern von SevDesk vergeben)',
    columns: [
      { name: 'id', type: 'alphanumeric', get: (d) => d.id },
      { name: 'rechnungsnummer', type: 'alphanumeric', get: (d) => d.invoiceNumber || null },
      { name: 'sevdesk_id', type: 'alphanumeric', get: (d) => d.sevdeskId || null },
      { name: 'auftrag_id', type: 'alphanumeric', get: (d) => d.orderId || null },
      { name: 'marktplatz', type: 'alphanumeric', get: (d) => d.marketplace || null },
      { name: 'kunde', type: 'alphanumeric', get: (d) => d.customer?.name || null },
      { name: 'betrag_netto', type: 'numeric', get: (d) => num(d.amountNetto ?? d.amountNet) },
      { name: 'ust_satz', type: 'numeric', get: (d) => num(d.vatRate) },
      { name: 'ust_betrag', type: 'numeric', get: (d) => num(d.vatAmount) },
      { name: 'betrag_brutto', type: 'numeric', get: (d) => num(d.amountBrutto ?? d.amountGross) },
      { name: 'waehrung', type: 'alphanumeric', get: (d) => d.currency || 'EUR' },
      { name: 'status', type: 'alphanumeric', get: (d) => d.status || null },
      { name: 'rechnungsdatum', type: 'alphanumeric', get: (d) => d.date || null },
      { name: 'faellig_am', type: 'alphanumeric', get: (d) => d.dueDate || null },
      { name: 'pdf', type: 'alphanumeric', get: (d) => d.pdfUrl || null },
      { name: 'erstellt_am', type: 'alphanumeric', get: (d) => d.createdAt || null },
    ],
  },
  {
    collection: 'returns',
    name: 'Retouren',
    description: 'Retouren und Erstattungen',
    columns: [
      { name: 'id', type: 'alphanumeric', get: (d) => d.id },
      { name: 'auftrag_id', type: 'alphanumeric', get: (d) => d.orderId || null },
      { name: 'marktplatz', type: 'alphanumeric', get: (d) => d.marketplace || d.source || null },
      { name: 'status', type: 'alphanumeric', get: (d) => d.status || null },
      { name: 'grund', type: 'alphanumeric', get: (d) => d.reason || d.reasonCategory || null },
      { name: 'erstattung', type: 'numeric', get: (d) => num(d.refundAmount) },
      { name: 'erstellt_am', type: 'alphanumeric', get: (d) => d.createdAt || null },
      { name: 'aktualisiert_am', type: 'alphanumeric', get: (d) => d.updatedAt || null },
    ],
  },
  {
    collection: 'shipments',
    name: 'Versand',
    description: 'Versandlabels und Sendungsverfolgung',
    columns: [
      { name: 'id', type: 'alphanumeric', get: (d) => d.id },
      { name: 'auftrag_id', type: 'alphanumeric', get: (d) => d.orderId || null },
      { name: 'carrier', type: 'alphanumeric', get: (d) => d.carrier || d.shippingMethodName || null },
      { name: 'tracking', type: 'alphanumeric', get: (d) => d.trackingNumber || d.tracking || null },
      { name: 'status', type: 'alphanumeric', get: (d) => d.status || null },
      { name: 'erstellt_am', type: 'alphanumeric', get: (d) => d.createdAt || null },
    ],
  },
];

// ─── Orchestrierung ─────────────────────────────────────────────────────────

/**
 * Liest alle Bücher-Collections (bewusst OHNE tenant-Where: Legacy-Docs ohne
 * tenantId dürfen im Rechts-Archiv nicht fehlen; gefiltert wird in-memory) und
 * schreibt CSV+JSONL+index.xml+Manifest über den injizierten Writer.
 */
async function runBooksExport({ firestore, archive, tenantId = 'default', apply = false, supplierName = 'TrendOcean (Einzelunternehmen)', exportedAtIso, log = () => {} }) {
  const tableResults = [];
  const xmlTables = [];
  let minDate = null;
  let maxDate = null;

  for (const spec of BOOK_TABLES) {
    const snap = await firestore.collection(spec.collection).limit(50000).get();
    const docs = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((d) => !d.tenantId || d.tenantId === tenantId);

    for (const d of docs) {
      const created = typeof d.createdAt === 'string' ? d.createdAt.slice(0, 10) : null;
      if (created) {
        if (!minDate || created < minDate) minDate = created;
        if (!maxDate || created > maxDate) maxDate = created;
      }
    }

    const csv = toCsv(spec.columns, docs);
    const jsonl = docs.map((d) => JSON.stringify(d)).join('\n') + (docs.length ? '\n' : '');

    let csvRows = docs.length;
    let jsonlLines = docs.length;
    if (apply) {
      await archive.writeFile(`${spec.collection}.csv`, csv);
      await archive.writeFile(`${spec.collection}.jsonl`, jsonl);
    }

    tableResults.push({ name: spec.collection, firestoreCount: docs.length, csvRows, jsonlLines });
    xmlTables.push({
      url: `${spec.collection}.csv`,
      name: spec.name,
      description: spec.description,
      from: minDate,
      to: maxDate,
      columns: spec.columns.map((c) => ({ name: c.name, type: c.type })),
    });
    log(`  ${apply ? 'exportiert' : 'würde exportieren'}: ${spec.name} (${docs.length})`);
  }

  const summary = verifyBooksExport(tableResults);
  const manifest = {
    exportedAt: exportedAtIso || null,
    tenantId,
    supplierName,
    standard: 'GDPdU/GoBD Beschreibungsstandard (gdpdu-01-09-2004)',
    ok: summary.ok,
    mismatches: summary.mismatches,
    tables: tableResults,
  };

  if (apply) {
    await archive.writeFile('index.xml', buildIndexXml({
      supplierName,
      comment: `AvyCloud Geschäftsbücher-Export (${exportedAtIso || ''}) — Alt-Datenbestand vor GmbH-Umstellung`,
      tables: xmlTables,
    }));
    await archive.writeFile('_manifest.json', JSON.stringify(manifest, null, 2));
  }

  return { apply, summary, manifest, tableResults };
}

/** CLI-Args: DRY-RUN default; --apply zum Schreiben. */
function parseArgs(argv) {
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  return {
    apply: argv.includes('--apply'),
    tenant: val('--tenant') || 'default',
    out: val('--out'),
  };
}

module.exports = {
  csvEscape,
  formatCsvValue,
  toCsv,
  buildIndexXml,
  verifyBooksExport,
  runBooksExport,
  parseArgs,
  BOOK_TABLES,
};

// ─── CLI (dünner Kleber über dem getesteten Kern) ───────────────────────────
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');

  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const { firestore } = require('../lib/firestore');

    const dir = args.out || path.join(process.cwd(), 'legacy-books-archive', args.tenant);
    fs.mkdirSync(dir, { recursive: true });
    const archive = {
      async writeFile(name, content) { writeFileDurable(fs, path.join(dir, name), content); },
    };

    console.log(`[export-legacy-books] tenant=${args.tenant} mode=${args.apply ? 'APPLY' : 'DRY-RUN'} dest=${dir}`);
    console.log('  Format: GoBD/GDPdU (CSV + index.xml) + JSONL-Rohdaten');

    const result = await runBooksExport({
      firestore,
      archive,
      tenantId: args.tenant,
      apply: args.apply,
      exportedAtIso: new Date().toISOString(),
      log: (m) => process.stdout.write(`${m}\n`),
    });

    const total = result.tableResults.reduce((s, t) => s + t.firestoreCount, 0);
    console.log(`\n  Datensätze gesamt: ${total}`);
    if (result.summary.mismatches.length) {
      result.summary.mismatches.forEach((m) => console.log(`  ❌ ${m}`));
    }

    if (!args.apply) {
      console.log('\nDRY-RUN — nichts geschrieben. Mit --apply ausführen.');
      process.exit(0);
    }
    if (result.summary.ok) {
      console.log('\n✅ Export vollständig verifiziert (GoBD-Format).');
      console.log('   Hinweis: Die Rechnungs-PDFs sichert zusätzlich export-legacy-invoices.js --apply.');
      process.exit(0);
    }
    console.log('\n❌ Export NICHT vollständig — Archiv nicht als gesichert betrachten.');
    process.exit(1);
  })().catch((err) => {
    console.error(`[export-legacy-books] FATAL: ${err.message}`, err);
    process.exit(1);
  });
}
