/**
 * Regressionstest fuer extractTrendOceanDescriptionParts() in backend/lib/ebay-direct.js.
 *
 * Vorfall (Audit 2026-07-29): Die Abweichungs-Erkennung suchte die Vorlagen-Abschnitte
 * ueber `class="...section-title..."`, der Vorlagen-Renderer schreibt aber
 * `class="to-section-label"`. Beide Regexe matchten daher NIE:
 *
 *   - "Produkt-Highlights" wurde nie gefunden -> listingHighlightsCount immer 0
 *     -> 1.732 gemeldete Abweichungen "Highlights weicht zwischen AvyCloud und eBay ab",
 *        von denen KEINE eine echte Abweichung war.
 *   - "Produktbeschreibung" wurde nie gefunden -> descriptionHtml fiel auf das komplette
 *     Vorlagen-HTML zurueck (inkl. Versand-/Verpackungs-/CTA-Bausteinen); die Beschreibung
 *     galt nur zufaellig ueber die Substring-Regel als gleich.
 *
 * Folgeschaden ohne diesen Fix: ein automatischer Nachpflege-Lauf haette 1.732 sinnlose
 * ReviseFixedPriceItem-Calls gegen eBay gefeuert und das Tageskontingent verbrannt.
 *
 * Der Fix akzeptiert BEIDE Schreibweisen (Alt-Listings koennen noch `section-title` tragen).
 */

require('./api/_patchGcp');
require('./api/_patchLocalModules');

const {
  extractTrendOceanDescriptionParts,
  buildTrendOceanDescriptionTemplate,
} = require('../lib/ebay-direct');

const product = () => ({
  id: 'p-desc-test',
  identification: {
    name: 'FAMEX 418-18 Profi Werkzeugkoffer 195-tlg',
    brand: 'FAMEX',
    sku: 'SKU-DESC-1',
  },
  details: {
    key_features: [
      'Umfassendes Set mit 195 Teilen fuer Mechaniker',
      'Chrom-Vanadium-Stahl fuer maximale Langlebigkeit',
      'Feinzahnknarren mit 108 Zaehnen',
    ],
    short_description:
      'Der FAMEX 418-18 Profi Werkzeugkoffer ist die ideale Wahl fuer anspruchsvolle '
      + 'Handwerker und Mechaniker, die Wert auf hoechste Qualitaet legen. Dieses '
      + '195-teilige Set bietet eine umfassende Ausstattung an hochwertigen Handwerkzeugen.',
    images: [{ url_or_base64: 'https://example.com/own-1.jpg' }],
    gpsr: { manufacturer_name: 'R. Luehdorf GmbH' },
  },
  inventory: { quantity: 1 },
});

describe('extractTrendOceanDescriptionParts — Vorlage muss sich selbst wiederfinden', () => {
  it('liest die Highlights aus dem selbst gerenderten Vorlagen-HTML zurueck (Kern-Regression)', () => {
    const html = buildTrendOceanDescriptionTemplate({ listing: null, product: product() });
    const parts = extractTrendOceanDescriptionParts(html);

    expect(parts.isTemplate).toBe(true);
    // Vor dem Fix: [] — die Ursache aller 1.732 Schein-Abweichungen.
    expect(parts.highlights.length).toBe(3);
    expect(parts.highlights[0]).toContain('195 Teilen');
    expect(parts.highlights[2]).toContain('108');
  });

  it('schneidet die Produktbeschreibung heraus statt auf das ganze Vorlagen-HTML zurueckzufallen', () => {
    const html = buildTrendOceanDescriptionTemplate({ listing: null, product: product() });
    const parts = extractTrendOceanDescriptionParts(html);

    expect(parts.descriptionHtml).toContain('FAMEX 418-18 Profi Werkzeugkoffer ist die ideale Wahl');
    // Die Bausteine ausserhalb der Beschreibungs-Sektion duerfen NICHT mitkommen,
    // sonst vergleicht die Gap-Erkennung Aepfel mit Birnen.
    expect(parts.descriptionHtml).not.toContain('Hinweis zur Verpackung');
    expect(parts.descriptionHtml).not.toContain('nur solange der Vorrat reicht');
    expect(parts.descriptionHtml.length).toBeLessThan(html.length);
  });

  it('versteht weiterhin die alte Schreibweise section-title (Alt-Listings)', () => {
    const legacy = `
      <!-- START TrendOcean eBay Listing Template -->
      <div class="to-section">
        <div class="to-section-title">Produkt-Highlights</div>
        <ul><li>Alt-Highlight A</li><li>Alt-Highlight B</li></ul>
      </div>
      <div class="to-section">
        <div class="to-section-title">Produktbeschreibung</div>
        <div>Alter Beschreibungstext aus einem frueheren Vorlagen-Stand.</div>
      </div>
      <div class="to-cta"><p>Jetzt sichern</p></div>
    `;
    const parts = extractTrendOceanDescriptionParts(legacy);

    expect(parts.highlights).toEqual(['Alt-Highlight A', 'Alt-Highlight B']);
    expect(parts.descriptionHtml).toContain('Alter Beschreibungstext');
    expect(parts.descriptionHtml).not.toContain('Jetzt sichern');
  });

  it('laesst Fremd-HTML unveraendert durch (kein Vorlagen-Listing)', () => {
    const foreign = '<p>Ein Angebot, das nie ueber AvyCloud erstellt wurde.</p>';
    const parts = extractTrendOceanDescriptionParts(foreign);

    expect(parts.isTemplate).toBe(false);
    expect(parts.highlights).toEqual([]);
    expect(parts.descriptionHtml).toBe(foreign);
  });

  it('bleibt bei leerer Eingabe leer', () => {
    const parts = extractTrendOceanDescriptionParts('');
    expect(parts.highlights).toEqual([]);
    expect(parts.descriptionHtml).toBe('');
  });
});
