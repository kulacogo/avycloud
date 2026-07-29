/**
 * Einbau der Kaufsicherheits-Bloecke in die eBay-Angebotsvorlage.
 *
 * Wichtigste Zusicherung: mit ausgeschaltetem Schalter (Default) bleibt die Vorlage
 * unveraendert — sonst wuerde jedes kuenftige Revise eine neue Beschreibung an eBay
 * schicken, ohne dass es jemand entschieden hat.
 */

require('./api/_patchGcp');
require('./api/_patchLocalModules');

const {
  buildTrendOceanDescriptionTemplate,
  extractTrendOceanDescriptionParts,
} = require('../lib/ebay-direct');

const product = () => ({
  id: 'p-blocks-tpl',
  identification: { name: 'FAMEX 418-18 Profi Werkzeugkoffer', brand: 'FAMEX', sku: 'SKU-BLK' },
  details: {
    key_features: ['195-teiliges Set', 'Chrom-Vanadium-Stahl'],
    short_description: 'Ein ausreichend langer Beschreibungstext fuer die Angebotsvorlage.',
    images: [{ url_or_base64: 'https://example.com/a.jpg' }],
    scope_of_delivery: ['1x Aluminium-Koffer', '195x Werkzeugteile'],
    weight: 16,
    attributes: { 'Maße': '46 x 35,5 x 18 cm', 'Passend für': 'Kfz-Werkstatt, Montage' },
    gpsr: { manufacturer_name: 'R. Luehdorf GmbH' },
  },
  inventory: { quantity: 1 },
});

describe('Angebotsvorlage — Schalter aus (Default)', () => {
  const ENV_KEYS = ['EBAY_DESCRIPTION_BLOCKS'];
  const saved = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    // Nur die eigenen Variablen zuruecksetzen. `process.env = {...}` wuerde die
    // GANZE Umgebung ersetzen und andere Testdateien im selben Worker beschaedigen.
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('rendert ohne gesetzte ENV exakt wie bisher', () => {
    delete process.env.EBAY_DESCRIPTION_BLOCKS;
    const html = buildTrendOceanDescriptionTemplate({ listing: null, product: product() });
    expect(html).not.toContain('Lieferumfang');
    expect(html).not.toContain('to-facts-row');
    expect(html).not.toContain('@media');
  });

  it('behandelt einen unbekannten Wert wie aus', () => {
    process.env.EBAY_DESCRIPTION_BLOCKS = 'vielleicht';
    const html = buildTrendOceanDescriptionTemplate({ listing: null, product: product() });
    expect(html).not.toContain('Lieferumfang');
  });

  it('hinterlaesst KEINE Leerzeilen-Artefakte an den Einhaengestellen', () => {
    // Gegen main byte-verglichen (2026-07-29). Die beiden Einhaengestellen fuer die
    // Bloecke und das CSS duerfen mit ausgeschaltetem Schalter kein einziges Zeichen
    // hinzufuegen — sonst weicht das Beschreibungs-HTML JEDES bestehenden Angebots
    // vom Spiegel ab und die Abweichungs-Erkennung meldet auf einen Schlag alle 3.667.
    delete process.env.EBAY_DESCRIPTION_BLOCKS;
    const html = buildTrendOceanDescriptionTemplate({ listing: null, product: product() });
    // Genau die zwei Einhaengestellen pruefen — nicht das ganze Dokument auf Leerzeilen,
    // die Vorlage bringt an anderen Stellen bewusst welche mit.
    expect(html).toContain('letter-spacing: 0.3px;\n}\n</style>');
    expect(html).toContain('    </div>\n  </div>\n\n  <div class="to-packaging">');
  });
});

describe('Angebotsvorlage — Schalter an', () => {
  const ENV_KEYS = ['EBAY_DESCRIPTION_BLOCKS'];
  const saved = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    // Nur die eigenen Variablen zuruecksetzen. `process.env = {...}` wuerde die
    // GANZE Umgebung ersetzen und andere Testdateien im selben Worker beschaedigen.
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('ergaenzt Lieferumfang, Maße und Passgenauigkeit', () => {
    process.env.EBAY_DESCRIPTION_BLOCKS = 'on';
    const html = buildTrendOceanDescriptionTemplate({ listing: null, product: product() });
    expect(html).toContain('Lieferumfang');
    expect(html).toContain('1x Aluminium-Koffer');
    expect(html).toContain('Maße &amp; Gewicht');
    expect(html).toContain('16 kg');
    expect(html).toContain('Passgenauigkeit');
    expect(html).toContain('Kfz-Werkstatt');
  });

  it('ergaenzt den Handy-Umbruchpunkt', () => {
    process.env.EBAY_DESCRIPTION_BLOCKS = 'on';
    const html = buildTrendOceanDescriptionTemplate({ listing: null, product: product() });
    expect(html).toContain('@media (max-width: 640px)');
  });

  it('laesst die bestehende Abweichungs-Erkennung intakt', () => {
    process.env.EBAY_DESCRIPTION_BLOCKS = 'on';
    const html = buildTrendOceanDescriptionTemplate({ listing: null, product: product() });
    const parts = extractTrendOceanDescriptionParts(html);
    expect(parts.highlights.length).toBe(2);
    expect(parts.descriptionHtml).toContain('ausreichend langer Beschreibungstext');
    // Die neuen Bloecke duerfen NICHT in den Beschreibungs-Vergleich rutschen,
    // sonst meldet die Gap-Erkennung wieder Schein-Abweichungen.
    expect(parts.descriptionHtml).not.toContain('Aluminium-Koffer');
  });

  it('laesst Bloecke ohne Quelle komplett weg', () => {
    process.env.EBAY_DESCRIPTION_BLOCKS = 'on';
    const nackt = product();
    delete nackt.details.scope_of_delivery;
    delete nackt.details.weight;
    nackt.details.attributes = { Farbe: 'Rot' };
    const html = buildTrendOceanDescriptionTemplate({ listing: null, product: nackt });
    expect(html).not.toContain('Lieferumfang');
    expect(html).not.toContain('Passgenauigkeit');
    expect(html).not.toMatch(/unbekannt/i);
  });

  it('erzeugt keine aktiven Inhalte', () => {
    process.env.EBAY_DESCRIPTION_BLOCKS = 'on';
    const html = buildTrendOceanDescriptionTemplate({ listing: null, product: product() });
    expect(html).not.toMatch(/<script|<iframe|<form|javascript:/i);
  });
});
