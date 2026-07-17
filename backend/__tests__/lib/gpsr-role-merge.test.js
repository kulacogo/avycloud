'use strict';

const {
  buildMergedGpsr, sameCompany, sameCountry, normName,
} = require('../../lib/gpsr-role-merge');

describe('normName / sameCompany (Material-Change-Gate)', () => {
  it('behandelt Bindestrich/Leerzeichen-Varianten als dieselbe Firma', () => {
    expect(sameCompany('SCT-Vertriebs GmbH', 'SCT Vertriebs GmbH')).toBe(true);
  });

  it('behandelt OCR-Drift (ein verschluckter Buchstabe) als dieselbe Firma', () => {
    expect(sameCompany('R. Lühdorff GmbH', 'R. Lühdorf GmbH')).toBe(true);
  });

  it('behandelt echte verschiedene Firmen als verschieden', () => {
    expect(sameCompany('Katadyn Deutschland GmbH', 'Katadyn Produkte AG')).toBe(false);
  });

  it('normalisiert Rechtsform-Suffixe weg', () => {
    expect(normName('Foo Bar GmbH')).toBe('foo bar');
  });
});

describe('sameCountry', () => {
  it('gleiches Land trotz unterschiedlicher Schreibweise', () => {
    expect(sameCountry('Germany', 'DE')).toBe(true);
  });
  it('verschiedene Länder', () => {
    expect(sameCountry('Germany', 'Switzerland')).toBe(false);
  });
  it('unbekanntes Land auf einer Seite -> nicht als Unterschied werten', () => {
    expect(sameCountry('', 'Germany')).toBe(true);
  });
});

describe('buildMergedGpsr', () => {
  it('MATERIAL: andere Firma + anderes Land -> ersetzt Hersteller + eVatmaster (Nicht-EU)', () => {
    const existing = { manufacturer_name: 'Katadyn Deutschland GmbH', entity_country: 'Germany' };
    const label = { manufacturer_name: 'Katadyn Produkte AG', manufacturer_city: 'Kemptthal', manufacturer_postalcode: '8310', entity_country: 'Switzerland' };
    const { next, contributedRoles, materialChange, euRepDefaultApplied } = buildMergedGpsr(existing, label);
    expect(materialChange).toBe(true);
    expect(contributedRoles).toContain('manufacturer');
    expect(next.manufacturer_name).toBe('Katadyn Produkte AG');
    expect(next.entity_country).toBe('Switzerland');
    expect(euRepDefaultApplied).toBe(true);
    expect(next.eu_responsible_name).toBe('eVatmaster Consulting GmbH');
  });

  it('COSMETIC: gleiche Firma + gleiches Land -> Bestandsnamen behalten, kein materialChange', () => {
    const existing = { manufacturer_name: 'SCT-Vertriebs GmbH', entity_country: 'Germany', eu_responsible_name: 'SCT-Vertriebs GmbH' };
    const label = { manufacturer_name: 'SCT Vertriebs GmbH', entity_country: 'Germany' };
    const { next, contributedRoles, materialChange } = buildMergedGpsr(existing, label);
    expect(materialChange).toBe(false);
    expect(contributedRoles).toContain('manufacturer_confirmed');
    expect(next.manufacturer_name).toBe('SCT-Vertriebs GmbH'); // Bestandsname behalten
  });

  it('OCR-Drift wird nicht zur Verschlechterung: Lühdorff bleibt Lühdorff', () => {
    const existing = { manufacturer_name: 'R. Lühdorff GmbH', entity_country: 'Germany' };
    const label = { manufacturer_name: 'R. Lühdorf GmbH', entity_country: 'Germany' };
    const { next, materialChange } = buildMergedGpsr(existing, label);
    expect(materialChange).toBe(false);
    expect(next.manufacturer_name).toBe('R. Lühdorff GmbH');
  });

  it('rollenweiser Merge: Etikett ohne EU-Rep wischt bestehenden EU-Rep NICHT weg', () => {
    const existing = { manufacturer_name: 'Marke X', entity_country: 'France', eu_responsible_name: 'Geaplan GmbH', eu_responsible_country: 'Germany' };
    const label = { manufacturer_name: 'Echter Hersteller SARL', entity_country: 'France' };
    const { next } = buildMergedGpsr(existing, label);
    expect(next.eu_responsible_name).toBe('Geaplan GmbH');
  });

  it('EU-Hersteller ohne EU-Rep -> KEIN eVatmaster', () => {
    const existing = { manufacturer_name: 'Alt GmbH', entity_country: 'Germany' };
    const label = { manufacturer_name: 'Neu Fabrik GmbH', entity_country: 'Germany' };
    const { euRepDefaultApplied } = buildMergedGpsr(existing, label);
    expect(euRepDefaultApplied).toBe(false);
  });

  it('Fake-Gate: NEU eingelesene Fake-Telefonnummer wird gestrippt', () => {
    const existing = { manufacturer_name: 'Alt GmbH', entity_country: 'Germany' };
    const label = { manufacturer_name: 'Neu Werk GmbH', entity_country: 'Germany', manufacturer_phone: '+1234567890' };
    const { next, gateStripped } = buildMergedGpsr(existing, label);
    expect(next.manufacturer_phone).toBeUndefined();
    expect(gateStripped.some((g) => g.startsWith('fake_phone'))).toBe(true);
  });

  it('Fake-Gate: BESTEHENDE E-Mail wird NICHT gelöscht (nur neu eingelesene Werte)', () => {
    // Gleiche Firma -> confirmed; bestehende E-Mail bleibt unangetastet.
    const existing = { manufacturer_name: 'SCT-Vertriebs GmbH', entity_country: 'Germany', email: 'info@sct-germany.de' };
    const label = { manufacturer_name: 'SCT Vertriebs GmbH', entity_country: 'Germany' };
    const { next } = buildMergedGpsr(existing, label);
    expect(next.email).toBe('info@sct-germany.de');
  });

  it('Erstbefüllung: fehlender Hersteller wird aus Etikett gefüllt (materialChange)', () => {
    const existing = {};
    const label = { manufacturer_name: 'Neu Hersteller GmbH', entity_country: 'Germany' };
    const { next, materialChange, contributedRoles } = buildMergedGpsr(existing, label);
    expect(materialChange).toBe(true);
    expect(contributedRoles).toContain('manufacturer');
    expect(next.manufacturer_name).toBe('Neu Hersteller GmbH');
  });
});
