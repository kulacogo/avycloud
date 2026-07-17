'use strict';

// analyzeCompetitorReliability (Incident 2026-07-17): ein einzelnes falsch
// etikettiertes EAN-Angebot (Bosch 59€, Markt 4-12€) darf nie "Günstigster
// Konkurrent" sein. Pure Funktion — kein Netz/Firestore.

const { analyzeCompetitorReliability } = require('../lib/competitor-prices');

describe('analyzeCompetitorReliability', () => {
  it('einzelnes Angebot → nicht belastbar (insufficient_sample)', () => {
    const listings = [{ price: 59 }];
    const r = analyzeCompetitorReliability(listings);
    expect(r.reliable).toBe(false);
    expect(r.unreliableReason).toBe('insufficient_sample');
    expect(r.cheapestReliable).toBeNull();
    // < MIN_RELIABLE → keine Ausreißerprüfung, outlier bleibt false
    expect(listings[0].outlier).toBe(false);
  });

  it('markiert Ausreißer bei belastbarer Stichprobe (>=3)', () => {
    const listings = [{ price: 5 }, { price: 6 }, { price: 7 }, { price: 59 }];
    const r = analyzeCompetitorReliability(listings);
    // Median der 4 = 6.5; 59 > 6.5*3 → Ausreißer
    expect(listings.find((l) => l.price === 59).outlier).toBe(true);
    expect(listings.find((l) => l.price === 5).outlier).toBe(false);
    expect(r.reliable).toBe(true);
    expect(r.cheapestReliable).toBe(5);
  });

  it('nach Ausreißer-Filter zu wenige → nicht belastbar', () => {
    const listings = [{ price: 5 }, { price: 6 }, { price: 500 }];
    // Median 6; 500 > 18 → Ausreißer → clean = [5,6] (2 < 3)
    const r = analyzeCompetitorReliability(listings);
    expect(r.reliable).toBe(false);
    expect(r.unreliableReason).toBe('insufficient_after_outlier_filter');
  });

  it('leere/invalide Liste → nicht belastbar, wirft nicht', () => {
    expect(analyzeCompetitorReliability([]).reliable).toBe(false);
    expect(analyzeCompetitorReliability(null).reliable).toBe(false);
  });
});
