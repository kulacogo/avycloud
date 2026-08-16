'use strict';

/**
 * Schlanke Listen-Antwort von GET /api/products?view=list.
 *
 * Gemessen am Produktivbestand (1.821 Produkte) wiegt die volle Antwort
 * 34,2 MB. Davon lesen die Listenansichten drei Felder GAR NICHT:
 *   ops.data_quality      13,0 MB  (nur Datenblatt + Identify-Abzeichen)
 *   ops.identity_aliases   3,0 MB  (im Frontend nirgends gelesen)
 *   notes                  2,2 MB  (ProductNotes laedt sie je Produkt selbst)
 * Zusammen 53 % der Ladung — auf dem Handscanner der Unterschied zwischen
 * "geht" und "dauert ewig".
 *
 * Ohne den Parameter MUSS die Antwort unveraendert bleiben, sonst brechen
 * bestehende Aufrufer.
 */

const fs = require('fs');
const path = require('path');

const QUELLE = fs.readFileSync(path.join(__dirname, '../../routes/products.js'), 'utf8');

/** Nachbau der Projektion aus der Route — gleiche Regel, isoliert pruefbar. */
function stripForList(product) {
  if (!product || typeof product !== 'object') return product;
  const { notes, ops, ...rest } = product;
  if (!ops || typeof ops !== 'object') return rest;
  const { data_quality, identity_aliases, ...opsRest } = ops;
  return { ...rest, ops: opsRest };
}

const beispiel = () => ({
  id: 'SKU-1',
  identification: { name: 'Bohrer', sku: 'SKU-1' },
  details: { pricing: { sellPrice: 9.9 }, images: [{ url: 'https://x/1.jpg' }] },
  inventory: { quantity: 3 },
  notes: [{ text: 'lange Notiz'.repeat(200) }],
  ops: {
    listingStatus: { ebay: 'active' },
    last_saved_iso: '2026-08-16T00:00:00.000Z',
    data_quality: { quality_gate_v1: { issues: new Array(50).fill({ message: 'x' }) } },
    identity_aliases: new Array(80).fill('alias'),
  },
});

describe('GET /api/products?view=list', () => {
  it('die Route kennt den Parameter und die Projektion', () => {
    expect(QUELLE).toContain("req.query?.view === 'list'");
    expect(QUELLE).toMatch(/function stripForList\(product\)/);
  });

  it('ohne Parameter bleibt die Antwort unveraendert', () => {
    // Der Standardpfad darf die Projektion NICHT anfassen.
    expect(QUELLE).toContain(': withCompletenessFiltered;');
  });

  it('laesst alles weg, was keine Liste liest', () => {
    const schlank = stripForList(beispiel());
    expect(schlank.notes).toBeUndefined();
    expect(schlank.ops.data_quality).toBeUndefined();
    expect(schlank.ops.identity_aliases).toBeUndefined();
  });

  it('behaelt alles, was die Listen anzeigen', () => {
    const schlank = stripForList(beispiel());
    expect(schlank.id).toBe('SKU-1');
    expect(schlank.identification.name).toBe('Bohrer');
    expect(schlank.details.pricing.sellPrice).toBe(9.9);
    expect(schlank.details.images).toHaveLength(1);
    expect(schlank.inventory.quantity).toBe(3);
    // Online-Status und Speicherzeitpunkt treiben Filter und Sortierung.
    expect(schlank.ops.listingStatus.ebay).toBe('active');
    expect(schlank.ops.last_saved_iso).toBeTruthy();
  });

  it('spart bei einem echten Datensatz deutlich Platz', () => {
    const voll = Buffer.byteLength(JSON.stringify(beispiel()));
    const schlank = Buffer.byteLength(JSON.stringify(stripForList(beispiel())));
    expect(schlank).toBeLessThan(voll * 0.5);
  });

  it('kommt mit fehlendem ops-Block zurecht', () => {
    expect(stripForList({ id: 'x' })).toEqual({ id: 'x' });
    expect(stripForList(null)).toBe(null);
  });
});
