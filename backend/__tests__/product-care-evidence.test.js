const { classifyCareEvent, normalizeSaveActivity } = require('../lib/product-care-evidence');
const change = (field, from, to) => ({ field, from, to });
const event = (changes, activity) => ({ action: 'product.updated', details: { changes, activity } });
const json = JSON.stringify;

describe('Inhaltliche Datenaufbereitung statt automatischer Erfassungs-Saves', () => {
  it('gibt für den echten Erfassungsfehler keine Pflegepunkte: Neu-Default, leere Kennnummern, Preisreset, Registry-Metadaten', () => {
    const value = classifyCareEvent(event([
      change('details.attributes', json({ Material: 'Stahl' }), json({ Material: 'Stahl', condition: 'new' })),
      change('details.identifiers.gtin', null, ''), change('details.identifiers.upc', null, ''),
      change('details.identifiers.mpn', null, ''), change('details.pricing.lowest_price.amount', '77.84', '0'),
      change('details.gpsr', json({ manufacturer_name: 'Beispiel' }), json({ manufacturer_name: 'Beispiel', evidence: { status: 'registry', updated_at_iso: 'now' } })),
    ]));
    expect(value).toEqual({ edited: false, ready: false });
  });
  it('zählt Barcode, Gewicht, Lagerangaben und Fotos allein nicht als Datenaufbereitung', () => {
    expect(classifyCareEvent(event([
      change('identification.barcodes', '[]', '["123"]'), change('details.identifiers.ean', null, '123'),
      change('details.weight', '2', '3'), change('details.images', '[]', '[{"url":"photo"}]'),
      change('details.attributes', '{}', json({ 'Gewicht (kg)': '3', Lagerplatz: 'A1', condition: 'used' })),
    ])).edited).toBe(false);
  });
  it('schreibt automatisch beim Lesen ergänzte Registry-Felder nicht dem speichernden Mitarbeiter zu', () => {
    expect(classifyCareEvent(event([change('details.gpsr', json({ manufacturer_name: 'Beispiel' }), json({ manufacturer_name: 'Beispiel', manufacturer_phone: '+49123', evidence: { status: 'registry', updated_at_iso: 'now' } }))])).edited).toBe(false);
  });
  it('zählt echte Beschreibung, Merkmale und GPSR-Korrekturen, unabhängig vom Benutzer oder früherer Erfassung', () => {
    for (const c of [change('details.description', 'Alt', 'Fachlich korrigiert'), change('details.attributes', json({ Farbe: 'rot' }), json({ Farbe: 'blau' })), change('details.gpsr', json({ manufacturer_city: 'Alt' }), json({ manufacturer_city: 'Neu' })), change('details.identifiers.mpn', null, 'Hersteller-42')]) {
      expect(classifyCareEvent(event([c])).edited).toBe(true);
    }
  });
  it('ignoriert Schlüsselreihenfolge, leere Zusatzfelder und reinen Leerraum', () => {
    expect(classifyCareEvent(event([
      change('details.attributes', json({ Farbe: 'rot', Material: 'Stahl' }), json({ Material: ' Stahl ', Farbe: 'rot', leer: '' })),
      change('details.description', 'Eine Beschreibung', ' Eine  Beschreibung\n'),
    ])).edited).toBe(false);
  });
  it('verlangt tatsächliche Vorher/Nachher-Belege statt bloßer Feldnamen oder unlesbarer Objekte', () => {
    expect(classifyCareEvent({ details: { changedFields: ['details.description'] } }).edited).toBe(false);
    expect(classifyCareEvent(event([change('details.attributes', 'bad json', '{}')])).edited).toBe(false);
    expect(classifyCareEvent(event([{ field: 'details.description', to: 'Neu' }])).edited).toBe(false);
  });
  it('hält Erfassungsabschluss, Preisänderung und Bearbeitungsübernahme von späterer Datenblattarbeit getrennt', () => {
    for (const activity of ['capture', 'ownership', 'pricing']) expect(classifyCareEvent(event([change('details.description', 'Alt', 'Neu')], activity)).edited).toBe(false);
    expect(classifyCareEvent(event([change('details.description', 'Alt', 'Neu')], 'datasheet')).edited).toBe(true);
  });
  it('stellt nur einen belegten Statuswechsel als Bereit-Abschluss dar', () => {
    expect(classifyCareEvent(event([change('ops.readiness', 'in_progress', 'ready')]))).toEqual({ edited: false, ready: true });
    expect(classifyCareEvent(event([change('ops.readiness', 'ready', 'ready')])).ready).toBe(false);
    expect(classifyCareEvent(event([{ field: 'ops.readiness', to: 'ready' }])).ready).toBe(false);
  });
  it('übernimmt keine beliebigen Querywerte als Auditaktivität', () => {
    expect(normalizeSaveActivity('capture')).toBe('capture');
    for (const value of ['other', ['capture'], {}, undefined]) expect(normalizeSaveActivity(value)).toBe('unspecified');
  });
});
