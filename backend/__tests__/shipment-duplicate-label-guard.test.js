'use strict';

/**
 * Der Duplikat-Schutz haengt an Status, die es in echt nicht gibt.
 *
 * Gemessen 2026-08-17 ueber 562 Sendungen der Sammlung `shipments`:
 *   Delivered 334 · ausstehend 134 · cancelled 58 · Awaiting customer pickup 27 · problem 9
 *
 * Der Schutz in services/shipping-engine.js blockte 'ausstehend',
 * 'in_zustellung' und 'zugestellt'. Die letzten beiden kommen NULL Mal vor —
 * fuer 361 von 562 Sendungen (64 %) war der Schutz blind. Ein zweiter
 * Frankier-Versuch haette dort ein zweites Label gekauft: echtes Geld.
 */

const { istAktiveSendung, normalizeShipmentStatus } = require('../lib/shipment-status');

describe('Lebendige Sendungen blocken einen zweiten Frankier-Versuch', () => {
  it('erkennt die real vorkommenden Zustaende', () => {
    // Genau die Werte aus der Messung.
    expect(istAktiveSendung('ausstehend')).toBe(true);
    expect(istAktiveSendung('Delivered')).toBe(true);
    expect(istAktiveSendung('Awaiting customer pickup')).toBe(true);
  });

  it('erkennt die uebrigen SendCloud-Zustaende', () => {
    for (const s of ['Announced', 'In transit', 'Ready to send', 'Out for delivery', 'At sorting centre']) {
      expect(istAktiveSendung(s)).toBe(true);
    }
  });

  it('laesst tote Sendungen neu frankieren', () => {
    for (const s of ['problem', 'cancelled', 'Cancelled', 'storniert']) {
      expect(istAktiveSendung(s)).toBe(false);
    }
  });

  it('leerer Status blockt nicht', () => {
    expect(istAktiveSendung('')).toBe(false);
    expect(istAktiveSendung(null)).toBe(false);
    expect(istAktiveSendung(undefined)).toBe(false);
  });

  it('unbekannter Status blockt — fail-closed', () => {
    // Ein zu Unrecht geblockter Versand kostet eine Rueckfrage.
    // Ein zu Unrecht erlaubter kostet ein zweites Label.
    expect(istAktiveSendung('Irgendein neuer SendCloud-Zustand')).toBe(true);
  });

  it('vereinheitlicht Schreibweisen', () => {
    expect(normalizeShipmentStatus('Awaiting customer pickup')).toBe('awaiting_customer_pickup');
    expect(normalizeShipmentStatus('  Ready-to-send ')).toBe('ready_to_send');
  });
});

describe('Der Versandmotor nutzt die gemeinsame Regel', () => {
  const fs = require('fs');
  const path = require('path');
  const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'services', 'shipping-engine.js'), 'utf8');

  it('kein eigenes Status-Set mehr im Versandmotor', () => {
    expect(SOURCE).not.toMatch(/BLOCKING_STATUSES\s*=\s*new Set/);
  });

  it('fragt istAktiveSendung', () => {
    expect(SOURCE).toMatch(/istAktiveSendung\s*\(/);
  });
});
