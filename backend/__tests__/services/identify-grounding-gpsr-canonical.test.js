'use strict';

/**
 * Regression (2026-07): identify-grounding.js mapped GPSR onto NON-canonical keys
 * `manufacturer_email` + `manufacturer_country`. The canonical GPSR whitelist
 * (normalizeGpsrObject in lib/gpsr-manufacturer-registry.js) only keeps `email`
 * and `entity_country` and DROPS everything else → the grounded manufacturer email
 * and country were silently discarded and never published.
 *
 * This test proves the mechanism (whitelist drops legacy keys, keeps canonical
 * ones) and guards the identify-grounding.js source so the mapping cannot regress.
 */

const fs = require('fs');
const path = require('path');
const { normalizeGpsrObject } = require('../../lib/gpsr-manufacturer-registry');

const GROUNDED = {
  gpsr_manufacturer_name: 'Bosch',
  gpsr_manufacturer_address: 'Robert-Bosch-Platz 1',
  gpsr_manufacturer_email: 'info@bosch.de',
  gpsr_manufacturer_phone: '+49 711 400 40990',
  gpsr_manufacturer_country: 'Deutschland',
};

describe('GPSR canonical-key survival through normalizeGpsrObject', () => {
  it('KEEPS email + entity_country when mapped with canonical keys (the fix)', () => {
    // This mirrors the object identify-grounding.js now builds.
    const canonical = normalizeGpsrObject({
      manufacturer_name: GROUNDED.gpsr_manufacturer_name,
      manufacturer_address: GROUNDED.gpsr_manufacturer_address,
      email: GROUNDED.gpsr_manufacturer_email,
      manufacturer_phone: GROUNDED.gpsr_manufacturer_phone,
      entity_country: GROUNDED.gpsr_manufacturer_country,
    });

    expect(canonical.email).toBe('info@bosch.de');
    expect(canonical.entity_country).toBeTruthy(); // normalized "Deutschland" → "Germany"
    expect(canonical.country_code).toBe('DE'); // derived only when entity_country survives
  });

  it('DROPS email + country when mapped with the OLD non-canonical keys (the bug)', () => {
    const legacy = normalizeGpsrObject({
      manufacturer_name: GROUNDED.gpsr_manufacturer_name,
      manufacturer_address: GROUNDED.gpsr_manufacturer_address,
      manufacturer_email: GROUNDED.gpsr_manufacturer_email,
      manufacturer_phone: GROUNDED.gpsr_manufacturer_phone,
      manufacturer_country: GROUNDED.gpsr_manufacturer_country,
    });

    expect(legacy.email).toBeUndefined();
    expect(legacy.entity_country).toBeUndefined();
    expect(legacy.manufacturer_email).toBeUndefined(); // not in whitelist either
    expect(legacy.manufacturer_country).toBeUndefined();
  });
});

describe('identify-grounding.js source uses canonical GPSR keys', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'services', 'identify-grounding.js'),
    'utf8'
  );
  // Isolate the V2 GPSR mapping block.
  const block = src.slice(
    src.indexOf('if (groundedRecord.gpsr_manufacturer_name)'),
    src.indexOf('// Grounding metadata')
  );

  it('maps the grounded email/country onto canonical keys', () => {
    expect(block).toMatch(/email:\s*groundedRecord\.gpsr_manufacturer_email/);
    expect(block).toMatch(/entity_country:\s*groundedRecord\.gpsr_manufacturer_country/);
  });

  it('no longer uses the dropped non-canonical keys', () => {
    expect(block).not.toMatch(/manufacturer_email:/);
    expect(block).not.toMatch(/manufacturer_country:/);
  });
});
