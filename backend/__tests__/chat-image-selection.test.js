'use strict';

/**
 * BEFUND 2026-09-03 (Produkt 371fce64 / SKU-1698488489, gemessen):
 * 26 Bilder — Platz 0 und 1 sind fremde Amazon-Werbebilder ("Manuell
 * hinzugefügt"), Platz 2..25 sind 24 eigene Aufnahmen im eigenen GCS-Bucket.
 * Der Chat sendete `images.slice(0, 4)`: zwei Amazon-Bilder und zwei
 * beliebige eigene Fotos. Der Bediener sah "der Chat schaut nicht drauf".
 */

const {
  selectChatImages,
  describeImageSelection,
  isGeneratedImage,
} = require('../lib/chat-image-selection');

// Die echte Bildliste des Produkts, verkürzt auf ihre Struktur.
const ECHTE_BILDER = [
  { source: 'web', variant: 'other', url_or_base64: 'https://m.media-amazon.com/images/I/61DfYWWRf5L._AC_SL1500_.jpg', notes: 'Manuell hinzugefügt' },
  { source: 'web', variant: 'other', url_or_base64: 'https://m.media-amazon.com/images/I/61BZ1cA0vJL._AC_SL1500_.jpg', notes: 'Manuell hinzugefügt' },
  ...Array.from({ length: 24 }, (_, i) => ({
    source: 'upload',
    variant: 'reference',
    url_or_base64: `https://storage.googleapis.com/prodsandjobs/products/identify-uploads/v3_1788435067007_${i}_x.jpg`,
  })),
];

describe('selectChatImages — der Vorfall', () => {
  it('schickt keine fremden Amazon-Bilder vor die eigenen Aufnahmen', () => {
    const res = selectChatImages(ECHTE_BILDER, { limit: 8 });
    expect(res.gesamt).toBe(26);
    expect(res.gesendet).toBe(8);
    const amazon = res.urls.filter((u) => u.includes('media-amazon.com'));
    expect(amazon).toHaveLength(0);
    expect(res.urls.every((u) => u.includes('storage.googleapis.com'))).toBe(true);
  });

  it('streut ueber die eigenen Aufnahmen statt die ersten N zu nehmen', () => {
    const res = selectChatImages(ECHTE_BILDER, { limit: 4 });
    const indizes = res.selected.map((s) => s.index);
    // Nicht einfach 2,3,4,5 — die Auswahl muss den hinteren Teil erreichen,
    // wo bei einer Fotoserie das Etikett liegt.
    expect(Math.max(...indizes)).toBeGreaterThan(20);
    expect(new Set(indizes).size).toBe(indizes.length);
  });

  it('nimmt Fremdbilder erst, wenn sonst nichts da ist', () => {
    const nurFremd = ECHTE_BILDER.slice(0, 2);
    const res = selectChatImages(nurFremd, { limit: 4 });
    expect(res.gesendet).toBe(2);
    expect(res.urls[0]).toContain('media-amazon.com');
  });

  it('zieht Etikett-/Typenschild-Kandidaten bei GPSR-Fragen nach vorne', () => {
    const bilder = [
      ...Array.from({ length: 10 }, (_, i) => ({
        source: 'upload',
        url_or_base64: `https://storage.googleapis.com/prodsandjobs/a_${i}.jpg`,
      })),
      { source: 'upload', variant: 'label', notes: 'Typenschild Rückseite', url_or_base64: 'https://storage.googleapis.com/prodsandjobs/typenschild.jpg' },
    ];
    const res = selectChatImages(bilder, { limit: 3, purpose: 'gpsr' });
    expect(res.urls).toContain('https://storage.googleapis.com/prodsandjobs/typenschild.jpg');
    expect(res.urls[0]).toBe('https://storage.googleapis.com/prodsandjobs/typenschild.jpg');
  });

  it('schliesst KI-erzeugte Bilder aus — sie belegen nie eine Tatsache', () => {
    const bilder = [
      { source: 'ai', generatedByAi: true, url_or_base64: 'https://storage.googleapis.com/avycloud-genai-images/x.jpg' },
      { source: 'upload', url_or_base64: 'https://storage.googleapis.com/prodsandjobs/echt.jpg' },
    ];
    const res = selectChatImages(bilder, { limit: 4 });
    expect(res.urls).toEqual(['https://storage.googleapis.com/prodsandjobs/echt.jpg']);
    expect(res.uebersprungen.ki_erzeugt).toBe(1);
    expect(isGeneratedImage(bilder[0])).toBe(true);
  });

  it('ueberspringt Bilder ohne brauchbare Adresse, ohne zu werfen', () => {
    const res = selectChatImages(
      [{ url_or_base64: '' }, { url_or_base64: 'data:image/png;base64,AAAA' }, null, 'https://storage.googleapis.com/prodsandjobs/ok.jpg'],
      { limit: 4 }
    );
    expect(res.urls).toEqual(['https://storage.googleapis.com/prodsandjobs/ok.jpg']);
    expect(res.uebersprungen.keine_url).toBe(3);
  });

  it('ist fail-safe bei kaputter Eingabe', () => {
    expect(selectChatImages(null).urls).toEqual([]);
    expect(selectChatImages(undefined).gesamt).toBe(0);
    expect(selectChatImages([]).gesendet).toBe(0);
  });

  it('liefert nie mehr als das Kontingent', () => {
    for (const limit of [1, 2, 4, 8, 26, 50]) {
      const res = selectChatImages(ECHTE_BILDER, { limit });
      expect(res.gesendet).toBeLessThanOrEqual(limit);
      expect(res.gesendet).toBeLessThanOrEqual(26);
    }
  });

  it('ist deterministisch', () => {
    const a = selectChatImages(ECHTE_BILDER, { limit: 8 }).urls;
    const b = selectChatImages(ECHTE_BILDER, { limit: 8 }).urls;
    expect(a).toEqual(b);
  });
});

describe('describeImageSelection — das Modell muss wissen, dass es blind ist', () => {
  it('nennt die echte Zahl, nicht die Gesamtzahl', () => {
    const text = describeImageSelection({ gesamt: 26, gesendet: 8 });
    expect(text).toContain('26');
    expect(text).toContain('8');
    expect(text).toMatch(/NICHT alle/i);
  });

  it('sagt deutlich, wenn gar kein Bild ankam', () => {
    const text = describeImageSelection({ gesamt: 26, gesendet: 0 });
    expect(text).toMatch(/kein/i);
    expect(text).toMatch(/NIE|nicht/i);
  });

  it('bleibt still-korrekt, wenn wirklich alles mitging', () => {
    expect(describeImageSelection({ gesamt: 3, gesendet: 3 })).toMatch(/alle 3/);
  });

  it('behandelt Produkte ganz ohne Fotos', () => {
    expect(describeImageSelection({ gesamt: 0, gesendet: 0 })).toMatch(/KEINE Produktfotos/);
  });
});
