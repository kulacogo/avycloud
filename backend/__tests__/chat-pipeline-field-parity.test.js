'use strict';

/**
 * FELD-PARITÄT ÜBER ALLE CHAT-PIPELINES.
 *
 * Dieser eine Test hätte den Vorfall vom 2026-08-10 verhindert.
 *
 * Vorgeschichte: Die 9 `eu_responsible_*`-Felder und `mpn` wurden am
 * 2026-06-01 NUR in V3 ergänzt. V2 und Legacy bekamen sie nie. Solange V3 die
 * Default-Pipeline war, fiel das nicht auf. Als `lib/model-select.js` alle
 * Gemini-3-Namen auf 2.5 umschrieb, wurde V3 unerreichbar — und der Chat
 * konnte den EU-Verantwortlichen und die Herstellernummer schlagartig nicht
 * mehr schreiben. Neun Tage lang hat das niemand gemerkt, weil kein Test die
 * Pipelines gegeneinander hielt.
 *
 * Regel: Welche Pipeline gerade greift, darf das ERGEBNIS eines Chat-Turns
 * nicht verändern. Verschiedene Qualität ja — verschiedene FELDER nein.
 */

const contract = require('../lib/chat-datasheet-contract');

const { _testables: v2 } = require('../services/product-chat-v2');
const { _testables: v3 } = require('../services/product-chat-v3');
const { _testables: legacy } = require('../services/product-chat.js');

/** Vollpayload: jedes Feld, das die Änderungskarte tragen können muss. */
function fullPayload() {
  const gpsr = {};
  contract.GPSR_FIELDS.forEach((f, i) => {
    // Ländercodes brauchen plausible Werte, sonst greifen Normalisierer.
    if (f === 'country_code') gpsr[f] = 'CN';
    else if (f === 'eu_responsible_country_code') gpsr[f] = 'ES';
    else if (f === 'email' || f === 'eu_responsible_email') gpsr[f] = `kontakt${i}@example.com`;
    else if (f === 'url') gpsr[f] = 'https://example.com/impressum';
    else gpsr[f] = `wert-${f}`;
  });
  return {
    summary: 'Test',
    identity: { mpn: 'OL-A016FF20N2' },
    gpsr,
  };
}

const baseProduct = {
  id: 'p1',
  identification: { name: 'Ein hinreichend langer Produkttitel', brand: 'ACME', sku: 'SKU-1' },
  details: { identifiers: {}, gpsr: {}, attributes: {} },
};

function gpsrKeysOf(result) {
  const change = result && result.change ? result.change : result;
  return Object.keys((change && change.gpsr) || {}).sort();
}

describe('Feld-Parität: GPSR', () => {
  it('V2 transportiert alle 19 GPSR-Felder inklusive EU-Verantwortlichem', () => {
    const out = v2.sanitizeDatasheetChangeV2(fullPayload(), baseProduct);
    expect(gpsrKeysOf(out)).toEqual([...contract.GPSR_FIELDS].sort());
  });

  it('Legacy transportiert dieselben 19 GPSR-Felder', () => {
    const out = legacy.sanitizeDatasheetChange(fullPayload(), baseProduct);
    expect(gpsrKeysOf(out)).toEqual([...contract.GPSR_FIELDS].sort());
  });

  it('V3 transportiert dieselben 19 GPSR-Felder', () => {
    const out = v3.sanitizeDatasheetChangeV3(fullPayload());
    expect(gpsrKeysOf(out)).toEqual([...contract.GPSR_FIELDS].sort());
  });

  it('alle drei Pipelines liefern IDENTISCHE GPSR-Feldnamen', () => {
    const a = gpsrKeysOf(v2.sanitizeDatasheetChangeV2(fullPayload(), baseProduct));
    const b = gpsrKeysOf(legacy.sanitizeDatasheetChange(fullPayload(), baseProduct));
    const c = gpsrKeysOf(v3.sanitizeDatasheetChangeV3(fullPayload()));
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });
});

describe('Feld-Parität: Herstellernummer', () => {
  it('V2 transportiert mpn', () => {
    const out = v2.sanitizeDatasheetChangeV2(fullPayload(), baseProduct);
    expect(out.change.identity?.mpn).toBe('OL-A016FF20N2');
  });

  it('Legacy transportiert mpn', () => {
    const out = legacy.sanitizeDatasheetChange(fullPayload(), baseProduct);
    const change = out.change || out;
    expect(change.identity?.mpn).toBe('OL-A016FF20N2');
  });

  it('V3 transportiert mpn', () => {
    const out = v3.sanitizeDatasheetChangeV3(fullPayload());
    const change = out.change || out;
    expect(change.identity?.mpn).toBe('OL-A016FF20N2');
  });
});

describe('Verworfenes wird gemeldet, nicht verschluckt', () => {
  it('V2 meldet einen unbekannten GPSR-Schlüssel als policyIssue', () => {
    const payload = fullPayload();
    payload.gpsr.erfundenes_feld = 'irgendwas';
    const out = v2.sanitizeDatasheetChangeV2(payload, baseProduct);
    expect(out.change.gpsr.erfundenes_feld).toBeUndefined();
    expect(out.policyIssues).toContain('gpsr:dropped_unknown_key:erfundenes_feld');
  });

  it('Legacy meldet einen unbekannten GPSR-Schlüssel als policyIssue', () => {
    const payload = fullPayload();
    payload.gpsr.erfundenes_feld = 'irgendwas';
    const out = legacy.sanitizeDatasheetChange(payload, baseProduct);
    expect(out.change.gpsr.erfundenes_feld).toBeUndefined();
    expect(out.policyIssues).toContain('gpsr:dropped_unknown_key:erfundenes_feld');
  });
});

describe('Tool-Deklarationen kennen dieselben Felder wie der Kontrakt', () => {
  it('V2-Deklaration führt alle 19 GPSR-Felder und mpn', () => {
    const props = v2.UPDATE_DATASHEET_DECLARATION.parameters.properties;
    expect(Object.keys(props.gpsr.properties).sort()).toEqual([...contract.GPSR_FIELDS].sort());
    expect(props.identity.properties.mpn).toBeTruthy();
  });

  it('V3-Deklaration deckt den Kontrakt ab (Drift-Schutz)', () => {
    const { UPDATE_DATASHEET_DECLARATION } = require('../services/product-chat-v3');
    const gpsrProps = UPDATE_DATASHEET_DECLARATION.parameters.properties.gpsr.properties;
    for (const f of contract.GPSR_FIELDS) {
      expect(gpsrProps[f]).toBeTruthy();
    }
  });
});
