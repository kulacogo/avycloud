/**
 * Kaufsicherheits-Bloecke fuer die eBay-Angebotsbeschreibung.
 *
 * Befund (Audit 2026-07-29, an 765 Bestandsprodukten gemessen):
 *   - 617 (80 %) nennen im Beschreibungstext keinen Lieferumfang
 *   - 282 (37 %) nennen keine Mass- oder Gewichtsangabe
 *   - 514 (67 %) sagen nichts zur Passgenauigkeit
 *   - die Vorlage enthaelt KEINEN einzigen Umbruchpunkt fuer Handys,
 *     obwohl ueber 60 % der eBay-Kaeufe mobil laufen
 *
 * "Was ist eigentlich drin?" ist die haeufigste Rueckfrage vor dem Kauf.
 *
 * Harte Regel: VERLUSTFREI. Fehlt die Quelle, faellt der Block komplett weg —
 * es wird nie "Unbekannt" oder ein Platzhalter gerendert. Und es wird nichts erfunden:
 * gerendert wird ausschliesslich, was im Datenblatt steht.
 */

const {
  resolveScopeOfDelivery,
  resolveDimensions,
  resolveCompatibility,
  buildDescriptionBlocks,
  buildMobileStyles,
} = require('../../lib/ebay-description-blocks');

const p = (details = {}) => ({ id: 'p-blocks', details });

describe('resolveScopeOfDelivery — Lieferumfang', () => {
  it('nimmt das gepflegte Feld details.scope_of_delivery', () => {
    const r = resolveScopeOfDelivery(p({ scope_of_delivery: ['1x Koffer', '195x Werkzeug'] }));
    expect(r.items).toEqual(['1x Koffer', '195x Werkzeug']);
    expect(r.source).toBe('field');
  });

  it('akzeptiert das Feld auch als mehrzeiligen Text', () => {
    const r = resolveScopeOfDelivery(p({ scope_of_delivery: '1x Koffer\n195x Werkzeug\n' }));
    expect(r.items).toEqual(['1x Koffer', '195x Werkzeug']);
  });

  it('faellt auf ein passendes Artikelmerkmal zurueck', () => {
    const r = resolveScopeOfDelivery(p({ attributes: { Lieferumfang: '1x Bremsscheibe, 2x Schraube' } }));
    expect(r.items).toEqual(['1x Bremsscheibe', '2x Schraube']);
    expect(r.source).toBe('attribute');
  });

  it('liefert nichts wenn es nichts gibt (kein Platzhalter)', () => {
    const r = resolveScopeOfDelivery(p({ attributes: { Farbe: 'Rot' } }));
    expect(r.items).toEqual([]);
    expect(r.source).toBe(null);
  });

  it('wirft Platzhalter-Werte weg', () => {
    for (const muell of ['Unbekannt', 'N/A', 'Nicht zutreffend', '-', 'TODO']) {
      expect(resolveScopeOfDelivery(p({ attributes: { Lieferumfang: muell } })).items).toEqual([]);
    }
  });
});

describe('resolveDimensions — Masse und Gewicht', () => {
  it('sammelt Einzelmasse und Gewicht', () => {
    const r = resolveDimensions(p({
      weight: 16,
      attributes: { 'Länge': '46 cm', 'Breite': '35,5 cm', 'Höhe': '18 cm' },
    }));
    const labels = r.rows.map((x) => x.label);
    expect(labels).toContain('Länge');
    expect(labels).toContain('Gewicht');
    expect(r.rows.find((x) => x.label === 'Gewicht').value).toBe('16 kg');
  });

  it('nimmt eine zusammengesetzte Massangabe wenn vorhanden', () => {
    const r = resolveDimensions(p({ attributes: { 'Maße': '46 x 35,5 x 18 cm' } }));
    expect(r.rows.some((x) => x.value.includes('46 x 35,5 x 18'))).toBe(true);
  });

  it('liefert nichts ohne Masse und ohne Gewicht', () => {
    expect(resolveDimensions(p({ attributes: { Farbe: 'Rot' } })).rows).toEqual([]);
  });

  it('ignoriert unsinnige Gewichte', () => {
    expect(resolveDimensions(p({ weight: 0 })).rows).toEqual([]);
    expect(resolveDimensions(p({ weight: -3 })).rows).toEqual([]);
  });
});

describe('resolveCompatibility — Passgenauigkeit', () => {
  it('erkennt "Passend für"', () => {
    const r = resolveCompatibility(p({ attributes: { 'Passend für': 'VW Golf V, Audi A3' } }));
    expect(r.items).toEqual(['VW Golf V', 'Audi A3']);
  });

  it('erkennt "Kompatibel mit"', () => {
    const r = resolveCompatibility(p({ attributes: { 'Kompatibel mit': 'Opel Astra K' } }));
    expect(r.items).toEqual(['Opel Astra K']);
  });

  it('liefert nichts wenn nichts da ist', () => {
    expect(resolveCompatibility(p({ attributes: {} })).items).toEqual([]);
  });
});

describe('buildDescriptionBlocks — verlustfrei zusammensetzen', () => {
  it('rendert gar nichts wenn keine Quelle etwas hergibt', () => {
    expect(buildDescriptionBlocks(p({ attributes: { Farbe: 'Rot' } }))).toBe('');
  });

  it('rendert nur die Bloecke, deren Quelle gefuellt ist', () => {
    const html = buildDescriptionBlocks(p({ scope_of_delivery: ['1x Koffer'] }));
    expect(html).toContain('Lieferumfang');
    expect(html).not.toContain('Maße');
    expect(html).not.toContain('Passgenauigkeit');
  });

  it('rendert nie das Wort Unbekannt', () => {
    const html = buildDescriptionBlocks(p({
      scope_of_delivery: ['1x Koffer'],
      attributes: { 'Länge': 'Unbekannt', 'Passend für': 'Unbekannt' },
      weight: 16,
    }));
    expect(html).not.toMatch(/unbekannt/i);
  });

  it('maskiert HTML in den Werten (kein Einschleusen)', () => {
    const html = buildDescriptionBlocks(p({ scope_of_delivery: ['<script>alert(1)</script>'] }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('enthaelt keine aktiven Inhalte und keine festen Pixelbreiten (eBay-Regeln)', () => {
    const html = buildDescriptionBlocks(p({
      scope_of_delivery: ['1x Koffer'],
      weight: 16,
      attributes: { 'Passend für': 'VW Golf' },
    }));
    expect(html).not.toMatch(/<script|<iframe|<form|javascript:/i);
    expect(html).not.toMatch(/width:\s*\d+px/i);
  });
});

describe('buildMobileStyles — Handy-Layout', () => {
  it('liefert einen Umbruchpunkt fuer schmale Bildschirme', () => {
    const css = buildMobileStyles();
    expect(css).toContain('@media');
    expect(css).toMatch(/max-width:\s*\d+px/);
  });
});
