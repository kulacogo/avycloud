'use strict';

const scope = require('../../lib/chat-scope');
const { gpsrIstThema } = require('../../lib/chat-gpsr-relevance');

describe('UX-36: anfragebezogener Arbeitsauftrag', () => {
  it('gibt explizitem Titelauftrag Vorrang vor negierten Hersteller-Wörtern', () => {
    expect(gpsrIstThema({ scope: 'title', message: 'Titel verbessern. KEINE Herstelleradressen im Titel.' })).toBe(false);
  });

  it.each([
    ['Verbessere nur den Titel', 'title'],
    ['Recherchiere den aktuellen Marktpreis', 'pricing'],
    ['Titel und Beschreibung verbessern, keine Preisrecherche', 'title,description'],
    ['Bitte den Titel kürzen, ohne Herstellerangaben zu recherchieren', 'title'],
    ['Ermittle den K-Typ', 'attributes'],
    ['Alles optimieren', 'datasheet'],
    ['Was bedeutet GPSR?', 'info'],
  ])('begrenzt eindeutigen Freitext: %s', (message, expected) => {
    expect(scope.resolveRequestScope({ message }).scope).toBe(expected);
  });

  it('macht unklare Änderungsaufträge sichtbar statt alles freizugeben', () => {
    expect(scope.resolveRequestScope({ message: 'Mach es besser' })).toMatchObject({ needsClarification: true });
  });

  it('partitioniert auch verschachtelte oder zusammengefasste fremde Felder', () => {
    const input = [{ summary: 'Alles verbessert', title: 'Ein Titel', identity: { name: 'Alias', brand: 'Fremd', mpn: 'X' }, pricing: { sellPrice: 99 }, gpsr: { manufacturer_name: 'Fremd' }, attributes: { Farbe: 'Rot' } }];
    const result = scope.filterChangesByScope(input, 'title');
    expect(result.changes).toEqual([{ summary: 'Alles verbessert', title: 'Ein Titel', identity: { name: 'Alias' } }]);
    expect(result.blocked).toEqual(expect.arrayContaining(['identity.brand', 'identity.mpn', 'pricing', 'gpsr', 'attributes']));
    expect(input[0].pricing.sellPrice).toBe(99);
  });

  it('erlaubt Preisfelder, aber keine übrigen Produktänderungen', () => {
    expect(scope.filterChangesByScope([{ title: 'Fremd', pricing: { amount: 5 }, categoryId: '9' }], 'pricing').changes)
      .toEqual([{ pricing: { amount: 5 } }]);
    expect(scope.filterChangesByScope([{ title: 'Fremd' }], 'info').changes).toEqual([]);
  });

  it('begrenzt Werkzeuge vor Ausführung, auch bei ungehorsamem Modell', () => {
    const names = ['fetch_url_content', 'search_ebay_catalog', 'search_manufacturer_site', 'get_required_aspects', 'suggest_product_images', 'generate_ai_images', 'update_product_datasheet'];
    const kept = scope.filterToolDeclarations(names.map(name => ({ name })), 'title').map(x => x.name);
    expect(kept).toEqual(['fetch_url_content', 'search_ebay_catalog', 'update_product_datasheet']);
    expect(scope.isToolAllowed('generate_ai_images', 'pricing')).toBe(false);
    expect(scope.isToolAllowed('search_manufacturer_site', 'gpsr')).toBe(true);
  });
});


it('preserves GPSR evidence status for authorized cards, including unverified warnings', () => {
  for (const outcome of ['verified', 'unverified', 'product_image']) {
    const proposal = { gpsr: { manufacturer_name: 'Test' }, gpsr_evidence_check: { outcome, url: 'https://example.invalid' } };
    expect(scope.filterChangesByScope([proposal], 'gpsr').changes).toEqual([proposal]);
    expect(scope.filterChangesByScope([proposal], 'title').changes).toEqual([]);
  }
});


it('keeps title-only prose and card summaries inside the requested task', () => {
  const result = scope.restrictChatResult({ message: 'Titel gut. Bitte auch Preis und Hersteller ändern.', datasheetChanges: [{ title: 'Sony Kopfhörer', summary: 'Preis und Hersteller verbessert' }] }, { scope: 'title' });
  expect(result.message).toBe('Titelvorschlag: Sony Kopfhörer');
  expect(result.datasheetChanges[0].summary).toBe('Titel optimieren');
});
