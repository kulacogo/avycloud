'use strict';

/**
 * Tests for scripts/export-legacy-books.js — GoBD/GDPdU-Export der Geschäfts-
 * bücher (Bestellungen, Rechnungen, Retouren, Versand) für den GmbH-Cutover.
 *
 * Format: pro Collection eine CSV (Semikolon, Dezimal-Komma, UTF-8) + JSONL
 * (volle Rohdaten) + eine index.xml nach dem GDPdU-Beschreibungsstandard
 * (gdpdu-01-09-2004), die Prüfsoftware (IDEA) einlesen kann. Die Vollständig-
 * keits-Prüfung ist das Sicherheits-Gate — getestet wie beim Rechnungs-Export.
 *
 * Vitest CJS — globals enabled.
 */

const {
  csvEscape,
  formatCsvValue,
  toCsv,
  buildIndexXml,
  verifyBooksExport,
  BOOK_TABLES,
} = require('../../scripts/export-legacy-books');

describe('csvEscape', () => {
  it('lässt harmlose Werte unangetastet', () => {
    expect(csvEscape('RE-2026-0001')).toBe('RE-2026-0001');
  });
  it('quotet Semikolon, Anführungszeichen und Zeilenumbrüche (Quote-Verdopplung)', () => {
    expect(csvEscape('a;b')).toBe('"a;b"');
    expect(csvEscape('sagt "hi"')).toBe('"sagt ""hi"""');
    expect(csvEscape('zeile1\nzeile2')).toBe('"zeile1\nzeile2"');
  });
});

describe('formatCsvValue', () => {
  it('formatiert Beträge mit Dezimal-Komma (GDPdU DecimalSymbol)', () => {
    expect(formatCsvValue(1234.5, 'numeric')).toBe('1234,50');
    expect(formatCsvValue(0, 'numeric')).toBe('0,00');
  });
  it('leert null/undefined', () => {
    expect(formatCsvValue(null, 'alphanumeric')).toBe('');
    expect(formatCsvValue(undefined, 'numeric')).toBe('');
  });
});

describe('toCsv', () => {
  const columns = [
    { name: 'id', type: 'alphanumeric', get: (d) => d.id },
    { name: 'betrag', type: 'numeric', get: (d) => d.amount },
  ];
  it('erzeugt Header + Zeilen mit Semikolon-Trenner', () => {
    const csv = toCsv(columns, [{ id: 'a;1', amount: 9.9 }]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('id;betrag');
    expect(lines[1]).toBe('"a;1";9,90');
  });
  it('liefert rowCount = Datenzeilen', () => {
    const csv = toCsv(columns, [{ id: 'x', amount: 1 }, { id: 'y', amount: 2 }]);
    expect(csv.split('\r\n').filter(Boolean).length).toBe(3); // Header + 2
  });
});

describe('buildIndexXml (GDPdU-Beschreibungsstandard)', () => {
  const xml = buildIndexXml({
    supplierName: 'TrendOcean',
    comment: 'Alt-Datenbestand Einzelunternehmen',
    tables: [
      {
        url: 'invoices.csv',
        name: 'Rechnungen',
        description: 'Ausgangsrechnungen',
        from: '2025-01-01',
        to: '2026-07-04',
        columns: [
          { name: 'id', type: 'alphanumeric' },
          { name: 'betrag_brutto', type: 'numeric' },
        ],
      },
    ],
  });

  it('referenziert den GDPdU-Standard (DTD) und UTF-8', () => {
    expect(xml).toContain('gdpdu-01-09-2004.dtd');
    expect(xml).toContain('<UTF8/>');
  });
  it('beschreibt die Tabelle mit Trennzeichen, Dezimal-Komma und Spalten', () => {
    expect(xml).toContain('<URL>invoices.csv</URL>');
    expect(xml).toContain('<ColumnDelimiter>;</ColumnDelimiter>');
    expect(xml).toContain('<DecimalSymbol>,</DecimalSymbol>');
    expect(xml).toContain('<Name>betrag_brutto</Name>');
    expect(xml).toContain('<Numeric');
  });
  it('nutzt id als Primärschlüssel und escapet XML-Sonderzeichen', () => {
    expect(xml).toContain('<VariablePrimaryKey>');
    const xml2 = buildIndexXml({ supplierName: 'A & B', tables: [] });
    expect(xml2).toContain('A &amp; B');
  });
});

describe('verifyBooksExport (Vollständigkeits-Gate)', () => {
  it('ok, wenn jede Collection vollständig geschrieben wurde', () => {
    const s = verifyBooksExport([
      { name: 'orders', firestoreCount: 10, csvRows: 10, jsonlLines: 10 },
      { name: 'invoices', firestoreCount: 5, csvRows: 5, jsonlLines: 5 },
    ]);
    expect(s.ok).toBe(true);
    expect(s.mismatches).toEqual([]);
  });
  it('NICHT ok bei fehlenden Zeilen (stiller Datenverlust)', () => {
    const s = verifyBooksExport([
      { name: 'orders', firestoreCount: 10, csvRows: 9, jsonlLines: 10 },
    ]);
    expect(s.ok).toBe(false);
    expect(s.mismatches[0]).toContain('orders');
  });
});

describe('BOOK_TABLES (die exportierten Bücher)', () => {
  it('deckt Bestellungen, Rechnungen, Retouren und Versand ab', () => {
    const names = BOOK_TABLES.map((t) => t.collection);
    for (const c of ['orders', 'invoices', 'returns', 'shipments']) {
      expect(names).toContain(c);
    }
  });
  it('jede Tabelle hat id als erste Spalte (Primärschlüssel)', () => {
    for (const t of BOOK_TABLES) {
      expect(t.columns[0].name).toBe('id');
    }
  });
});
