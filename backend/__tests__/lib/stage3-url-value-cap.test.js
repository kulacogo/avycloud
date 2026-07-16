'use strict';

// REGRESSION GUARD — Incident 2026-07-16: Stage-3-Normalisierung kappte
// Attributwerte hart auf 60 Zeichen (eBay-ItemSpecifics-Limit) und der Wert
// floss zurück ins kanonische Datenblatt — eine GCS-Sicherheitsdatenblatt-URL
// wurde dabei zerstört (404). URLs dürfen NIE gekappt werden.

const { capSpecificValue } = require('../../lib/identify-v3-stage3');

describe('capSpecificValue — URLs sind von der 60-Zeichen-Kappung ausgenommen', () => {
  it('lässt lange URLs unangetastet', () => {
    const url = 'https://storage.googleapis.com/prodsandjobs/products/bc36c5c3-f2cd-4a7e-b5f8-a6fb05f2686e/sds_662f01cd273d097ef7c77e9ebc4e66ea.pdf';
    expect(capSpecificValue(url)).toBe(url);
  });

  it('kappt Nicht-URL-Werte weiterhin auf 60 Zeichen', () => {
    const long = 'x'.repeat(100);
    expect(capSpecificValue(long)).toHaveLength(60);
  });

  it('kurze Werte bleiben unverändert', () => {
    expect(capSpecificValue('Rot')).toBe('Rot');
  });
});
