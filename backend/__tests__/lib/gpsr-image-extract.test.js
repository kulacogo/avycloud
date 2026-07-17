'use strict';

// Dedizierter GPSR-Bild-Extraktor (Incident 2026-07-17): fokussierter Vision-Call
// liest Hersteller/EU-Rep deterministisch vom Etikett. aiClient gemockt (kein Netz);
// Bilder via opts.imageParts injiziert (kein fetch).

const { extractGpsrFromImages } = require('../../lib/gpsr-image-extract');

const IMG = [{ inlineData: { data: 'x', mimeType: 'image/jpeg' } }];

function mkClient(jsonObj, { throwTimes = 0 } = {}) {
  let calls = 0;
  return {
    models: {
      generateContent: vi.fn(async () => {
        calls += 1;
        if (calls <= throwTimes) throw new Error('transient');
        return { text: JSON.stringify(jsonObj) };
      }),
    },
    __calls: () => calls,
  };
}

describe('extractGpsrFromImages', () => {
  it('mappt Etikett-Rollen aufs kanonische Schema (manufacturer_country→entity_country)', async () => {
    const ai = mkClient({
      label_visible: true,
      manufacturer_name: 'Guangzhou Yuanshi Technology Co., Ltd.',
      manufacturer_address: '106 Fengze East Road, Guangzhou',
      manufacturer_country: 'CN',
      manufacturer_email: 'gr4tec.service@outlook.com',
      eu_responsible_name: 'Pro Logistik SP. Zo.o',
      eu_responsible_country: 'Polen',
    });
    const res = await extractGpsrFromImages({ id: 'p1' }, { imageParts: IMG, aiClient: ai });
    expect(res.source).toBe('product_image');
    expect(res.gpsr.manufacturer_name).toContain('Guangzhou Yuanshi');
    expect(res.gpsr.entity_country).toBe('CN');
    expect(res.gpsr.email).toBe('gr4tec.service@outlook.com');
    expect(res.gpsr.eu_responsible_name).toContain('Pro Logistik');
    // Keine Hersteller-PLZ/Telefon geliefert → nicht im Ergebnis (keine Erfindung)
    expect(res.gpsr.manufacturer_postalcode).toBeUndefined();
    expect(res.gpsr.manufacturer_phone).toBeUndefined();
  });

  it('label_visible=false → null', async () => {
    const ai = mkClient({ label_visible: false });
    const res = await extractGpsrFromImages({ id: 'p1' }, { imageParts: IMG, aiClient: ai });
    expect(res).toBeNull();
  });

  it('keine Bilder → null (kein Call)', async () => {
    const ai = mkClient({ label_visible: true, manufacturer_name: 'X' });
    const res = await extractGpsrFromImages({ id: 'p1' }, { imageParts: [], aiClient: ai });
    expect(res).toBeNull();
    expect(ai.__calls()).toBe(0);
  });

  it('transienter Fehler → EIN Retry, dann Erfolg', async () => {
    const ai = mkClient({ label_visible: true, manufacturer_name: 'Guangzhou Yuanshi', manufacturer_country: 'CN' }, { throwTimes: 1 });
    const res = await extractGpsrFromImages({ id: 'p1' }, { imageParts: IMG, aiClient: ai });
    expect(res.gpsr.manufacturer_name).toContain('Guangzhou');
    expect(ai.__calls()).toBe(2);
  });

  it('label_visible aber keine Rollen-Namen → null', async () => {
    const ai = mkClient({ label_visible: true, manufacturer_address: 'irgendwo' });
    const res = await extractGpsrFromImages({ id: 'p1' }, { imageParts: IMG, aiClient: ai });
    expect(res).toBeNull();
  });

  it('Junk-Werte ("null"/"n/a") werden nicht als Etikett-Wert übernommen', async () => {
    const ai = mkClient({ label_visible: true, manufacturer_name: 'Echte Firma GmbH', eu_responsible_name: 'null', manufacturer_postalcode: 'n/a' });
    const res = await extractGpsrFromImages({ id: 'p1' }, { imageParts: IMG, aiClient: ai });
    expect(res.gpsr.manufacturer_name).toBe('Echte Firma GmbH');
    expect(res.gpsr.eu_responsible_name).toBeUndefined();
    expect(res.gpsr.manufacturer_postalcode).toBeUndefined();
  });

  it('Website im E-Mail-Feld → landet als url, nicht als E-Mail (verhindert eBay-Ablehnung)', async () => {
    const ai = mkClient({ label_visible: true, manufacturer_name: 'Centrum Elektroniki Sp. z o.o.', manufacturer_country: 'Poland', manufacturer_email: 'www.centrumelektroniki.pl' });
    const res = await extractGpsrFromImages({ id: 'p1' }, { imageParts: IMG, aiClient: ai });
    expect(res.gpsr.email).toBeUndefined();
    expect(res.gpsr.url).toBe('https://www.centrumelektroniki.pl');
  });

  it('echte E-Mail bleibt im E-Mail-Feld', async () => {
    const ai = mkClient({ label_visible: true, manufacturer_name: 'X GmbH', manufacturer_email: 'info@x-gmbh.de' });
    const res = await extractGpsrFromImages({ id: 'p1' }, { imageParts: IMG, aiClient: ai });
    expect(res.gpsr.email).toBe('info@x-gmbh.de');
    expect(res.gpsr.url).toBeUndefined();
  });
});
