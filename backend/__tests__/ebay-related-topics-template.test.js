/**
 * Verdrahtung der Empfehlungs-Sektion in die TrendOcean-Angebotsvorlage.
 *
 * DER WICHTIGSTE TEST HIER ist "erzeugt keine neue Abweichung": die
 * Abweichungs-Erkennung (computeListingGaps) vergleicht NUR den inneren
 * Abschnitt "Produktbeschreibung" gegen deriveProductDescription(product) —
 * nicht das ganze Vorlagen-HTML. Deshalb darf eine zusaetzliche Sektion am Ende
 * der Vorlage KEINE Abweichung fuer die ~3.861 laufenden Angebote ausloesen.
 * Waere das anders, braeuchte das Feature einen Nachpflege-Lauf ueber alle
 * Angebote — und der ist bewusst zurueckgestellt (hoechstes Produktionsrisiko).
 */

require('./api/_patchGcp');
require('./api/_patchLocalModules');

const {
  buildTrendOceanDescriptionTemplate,
  extractTrendOceanDescriptionParts,
} = require('../lib/ebay-direct');

const product = () => ({
  id: 'p-reco',
  identification: { name: 'Bosch Bremsscheibe Vorderachse', brand: 'BOSCH', sku: 'SKU-RECO-1' },
  details: {
    description: 'Belueftete Bremsscheibe fuer die Vorderachse. Passgenau und geprueft.',
    key_features: ['Durchmesser 300 mm', 'Belueftet'],
  },
});

const tiles = [
  {
    productId: 'n1',
    title: 'ATE Bremsbelagsatz Vorderachse',
    imageUrl: 'https://storage.googleapis.com/trendocean/img/n1.jpg',
    topic: 'Bremsbelag',
    url: 'https://www.ebay.de/sch/i.html?_ssn=trendocean-store&_nkw=Bremsbelag',
  },
  {
    productId: 'n2',
    title: 'BOSCH Bremsscheibe Hinterachse',
    imageUrl: 'https://storage.googleapis.com/trendocean/img/n2.jpg',
    topic: 'Bremsscheibe',
    url: 'https://www.ebay.de/sch/i.html?_ssn=trendocean-store&_nkw=Bremsscheibe',
  },
];

const altFlag = process.env.EBAY_RELATED_TOPICS;
afterEach(() => {
  if (altFlag === undefined) delete process.env.EBAY_RELATED_TOPICS;
  else process.env.EBAY_RELATED_TOPICS = altFlag;
});

describe('Empfehlungs-Sektion in der Angebotsvorlage', () => {
  it('bleibt bei ausgeschaltetem Flag komplett aus der Vorlage', () => {
    delete process.env.EBAY_RELATED_TOPICS;

    const ohne = buildTrendOceanDescriptionTemplate({ listing: null, product: product() });
    const mitKacheln = buildTrendOceanDescriptionTemplate({
      listing: null, product: product(), relatedTiles: tiles,
    });

    // Auch das CSS muss gegatet sein — laege es immer im HTML, unterschiede sich
    // die Beschreibung JEDES bestehenden Angebots vom Spiegel.
    expect(ohne).not.toContain('to-reco');
    expect(mitKacheln).toBe(ohne);
  });

  it('rendert die Kacheln bei eingeschaltetem Flag', () => {
    process.env.EBAY_RELATED_TOPICS = 'on';

    const html = buildTrendOceanDescriptionTemplate({
      listing: null, product: product(), relatedTiles: tiles,
    });

    expect(html).toContain('Das könnte Sie auch interessieren');
    expect(html).toContain('ATE Bremsbelagsatz Vorderachse');
    expect(html).toContain('_nkw=Bremsbelag');
    expect(html).toContain('.to-reco-grid');
    expect(html).not.toMatch(/\/itm\//);
  });

  it('erzeugt KEINE neue Abweichung gegen die Abweichungs-Erkennung', () => {
    process.env.EBAY_RELATED_TOPICS = 'on';
    const p = product();

    const ohne = buildTrendOceanDescriptionTemplate({ listing: null, product: p });
    const mit = buildTrendOceanDescriptionTemplate({
      listing: null, product: p, relatedTiles: tiles,
    });

    const teileOhne = extractTrendOceanDescriptionParts(ohne);
    const teileMit = extractTrendOceanDescriptionParts(mit);

    expect(teileMit.descriptionHtml).toBe(teileOhne.descriptionHtml);
    expect(teileMit.highlights).toEqual(teileOhne.highlights);
    expect(teileMit.isTemplate).toBe(true);
  });

  it('laesst die Sektion weg, wenn nur eine Kachel uebrig ist', () => {
    process.env.EBAY_RELATED_TOPICS = 'on';

    const html = buildTrendOceanDescriptionTemplate({
      listing: null, product: product(), relatedTiles: [tiles[0]],
    });

    expect(html).not.toContain('to-reco');
  });
});
