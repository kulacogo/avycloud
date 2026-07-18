/**
 * Meta-Echo-Erkennung für die finale Chat-V3-Antwort (Incident 2026-07-16).
 *
 * gemini-3.1-pro beantwortete den letzten functionResponse-Turn mit englischem
 * Task-Abschluss-Gerede ("have successfully completed the task. No further tool
 * calls are required.") — das wurde 1:1 als Chat-Antwort an den User geliefert.
 * isMetaEchoAnswer erkennt solche Antworten, synthesizeAnswerFromChanges baut
 * den deutschen Ersatz aus den change.summary-Feldern.
 */

const { _testables } = require('../../services/product-chat-v3');

const { isMetaEchoAnswer, synthesizeAnswerFromChanges } = _testables;

describe('isMetaEchoAnswer', () => {
  it.each([
    ['have successfully completed the task. No further tool calls are required.'],
    ['I have now completed the task.'],
    ['Task is complete. No further action needed.'],
    ['Ich rufe jetzt update_product_datasheet auf.'],
    ['I will now call the function to update the datasheet.'],
    [''],
    ['   '],
  ])('Meta/leer: %j → true', (text) => {
    expect(isMetaEchoAnswer(text)).toBe(true);
  });

  it('echte kurze deutsche Antwort → false', () => {
    expect(
      isMetaEchoAnswer('Ich habe den Titel optimiert und die Marke BOSCH bestätigt. Die Änderungen stehen zur Übernahme bereit.')
    ).toBe(false);
  });

  it('lange echte Antwort (>600 Zeichen) → IMMER false, auch mit Meta-Phrase darin', () => {
    const long = `Die Recherche ist abgeschlossen (task complete). ${'Die Bremsscheibe passt auf Opel Astra J und Chevrolet Trax, geprüft über die Herstellerseite. '.repeat(10)}`;
    expect(long.length).toBeGreaterThan(600);
    expect(isMetaEchoAnswer(long)).toBe(false);
  });

  it('non-string → true (defensiv)', () => {
    expect(isMetaEchoAnswer(null)).toBe(true);
    expect(isMetaEchoAnswer(undefined)).toBe(true);
  });
});

describe('synthesizeAnswerFromChanges', () => {
  it('keine Changes → leerer String', () => {
    expect(synthesizeAnswerFromChanges([])).toBe('');
    expect(synthesizeAnswerFromChanges(null)).toBe('');
    expect(synthesizeAnswerFromChanges([{ title: 'x' }])).toBe('');
  });

  it('genau eine summary → wird direkt zurückgegeben', () => {
    expect(synthesizeAnswerFromChanges([{ summary: 'Titel SEO-optimiert (79 Zeichen).' }]))
      .toBe('Titel SEO-optimiert (79 Zeichen).');
  });

  it('mehrere summaries → deutsche Aufzählung', () => {
    const out = synthesizeAnswerFromChanges([
      { summary: 'Titel optimiert.' },
      { summary: 'GPSR-Herstellerdaten ergänzt.' },
      { notitle: true },
    ]);
    expect(out).toContain('Ich habe folgende Änderungen vorbereitet:');
    expect(out).toContain('- Titel optimiert.');
    expect(out).toContain('- GPSR-Herstellerdaten ergänzt.');
  });
});

describe('summarizeChangeForCard — keine leeren "Änderung aus Chat"-Karten mehr', () => {
  const { summarizeChangeForCard, ownExecutor } = _testables;

  it('baut konkrete Zusammenfassung aus Marke/Kategorie/Preis', () => {
    const s = summarizeChangeForCard({
      identity: { brand: 'Decathlon', category: 'Spielzeug > Spielzeug für draußen' },
      pricing: { amount: 109.99, currency: 'EUR' },
    });
    expect(s).toContain('Marke: Decathlon');
    expect(s).toContain('Kategorie: Spielzeug');
    expect(s).toContain('Preis: 109.99 EUR');
  });

  it('ownExecutor ergänzt fehlende summary automatisch', () => {
    const state = { datasheetChanges: [] };
    ownExecutor('update_product_datasheet', { identity: { brand: 'Bosch' }, pricing: { amount: 12, currency: 'EUR' } }, state);
    expect(state.datasheetChanges).toHaveLength(1);
    expect(state.datasheetChanges[0].summary).toContain('Marke: Bosch');
  });

  it('vorhandene summary bleibt unangetastet', () => {
    const state = { datasheetChanges: [] };
    ownExecutor('update_product_datasheet', { summary: 'Eigene Summary', identity: { brand: 'Bosch' } }, state);
    expect(state.datasheetChanges[0].summary).toBe('Eigene Summary');
  });
});

describe('consolidateDatasheetChangesV3 — eine Karte pro Turn', () => {
  const { consolidateDatasheetChangesV3 } = _testables;

  it('einzelne Karte bleibt unverändert', () => {
    const one = [{ summary: 'x', title: 'T' }];
    expect(consolidateDatasheetChangesV3(one)).toEqual(one);
    expect(consolidateDatasheetChangesV3([])).toEqual([]);
  });

  it('überlappende Karten: last-wins pro Feld, identity gemergt', () => {
    const out = consolidateDatasheetChangesV3([
      { summary: 'Erste Karte', identity: { brand: 'Alt', category: 'A > B' }, pricing: { amount: 99, currency: 'EUR' } },
      { summary: 'Zweite Karte', title: 'Neuer Titel', identity: { brand: 'Decathlon' }, pricing: { amount: 109.99, currency: 'EUR' } },
    ]);
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c.title).toBe('Neuer Titel');
    expect(c.identity).toEqual({ brand: 'Decathlon', category: 'A > B' });
    expect(c.pricing.amount).toBe(109.99);
    expect(c.summary).toContain('Erste Karte');
    expect(c.summary).toContain('Zweite Karte');
  });

  it('Attribute: last-wins pro normalisiertem Key, value_type bleibt erhalten', () => {
    const out = consolidateDatasheetChangesV3([
      { attributes: [{ key: 'Farbe', value: 'Rot' }, { key: 'Material', value: 'Holz', value_type: 'STRING' }] },
      { attributes: [{ key: 'farbe', value: 'Blau' }] },
    ]);
    expect(out).toHaveLength(1);
    const attrs = out[0].attributes;
    expect(attrs).toHaveLength(2);
    expect(attrs.find((a) => a.key.toLowerCase() === 'farbe').value).toBe('Blau');
    expect(attrs.find((a) => a.key === 'Material').value_type).toBe('STRING');
  });

  it('Confidence konservativ (Minimum), notes/warnings unique gemergt', () => {
    const out = consolidateDatasheetChangesV3([
      { confidence: 0.9, notes: { warnings: ['W1'] } },
      { confidence: 0.6, notes: { warnings: ['W1', 'W2'], unsure: ['U1'] } },
    ]);
    const c = out[0];
    expect(c.confidence).toBe(0.6);
    expect(c.notes.warnings).toEqual(['W1', 'W2']);
    expect(c.notes.unsure).toEqual(['U1']);
  });

  it('ohne Summaries wird eine konkrete Zusammenfassung synthetisiert', () => {
    const out = consolidateDatasheetChangesV3([
      { identity: { brand: 'Bosch' } },
      { pricing: { amount: 12, currency: 'EUR' } },
    ]);
    expect(out[0].summary).toContain('Marke: Bosch');
  });
});

describe('Write-Call-Härtung (Incident 2026-07-16: changes=0 bei sawWrite=true)', () => {
  const { ownExecutor, sanitizeDatasheetChangeV3 } = _testables;

  it('Map-Shape-Attribute werden akzeptiert (statt still verworfen)', () => {
    const out = sanitizeDatasheetChangeV3({ attributes: { Farbe: 'Rot', Material: 'Holz' } });
    expect(out.attributes).toEqual([
      { key: 'Farbe', value: 'Rot' },
      { key: 'Material', value: 'Holz' },
    ]);
  });

  it('description-Alias wird auf short_description gefaltet; short_description gewinnt', () => {
    expect(sanitizeDatasheetChangeV3({ description: 'Nur Alias-Text.' }).short_description).toBe('Nur Alias-Text.');
    const both = sanitizeDatasheetChangeV3({ short_description: 'Kanonisch.', description: 'Alias.' });
    expect(both.short_description).toBe('Kanonisch.');
  });

  it('Array-Attribute mit name statt key werden akzeptiert', () => {
    const out = sanitizeDatasheetChangeV3({ attributes: [{ name: 'Farbe', value: 'Blau' }] });
    expect(out.attributes).toEqual([{ key: 'Farbe', value: 'Blau' }]);
  });

  it('ownExecutor meldet ok:false + Schema-Hinweis, wenn ALLES verworfen wurde (kein Fake-Erfolg mehr)', async () => {
    const state = { datasheetChanges: [] };
    const res = await ownExecutor('update_product_datasheet', { unbekanntes_feld: 'x', preis: '12 EUR' }, state);
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('EMPTY_AFTER_SANITIZE');
    expect(res.error.message).toContain('attributes als ARRAY');
    expect(state.datasheetChanges).toHaveLength(0);
  });

  it('ownExecutor mit validem Inhalt bleibt ok:true', async () => {
    const state = { datasheetChanges: [] };
    const res = await ownExecutor('update_product_datasheet', { identity: { brand: 'HIKENTURE' } }, state);
    expect(res.ok).toBe(true);
    expect(state.datasheetChanges).toHaveLength(1);
  });
});

describe('Konsolidierung — Reichhaltigkeit gewinnt (Incident: 2-Satz-Beschreibung)', () => {
  const { consolidateDatasheetChangesV3 } = _testables;

  it('magerer späterer Recap überschreibt die reiche Beschreibung NICHT', () => {
    const rich = 'Die Bosch Bremsscheibe für die Hinterachse bietet Erstausrüsterqualität. '.repeat(6);
    const out = consolidateDatasheetChangesV3([
      { short_description: rich, key_features: ['A', 'B', 'C', 'D', 'E'] },
      { short_description: 'Kurzer Recap in zwei Sätzen. Fertig.', key_features: ['A', 'B'] },
    ]);
    expect(out[0].short_description).toBe(rich);
    expect(out[0].key_features).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('eine LÄNGERE spätere Beschreibung gewinnt weiterhin (echte Verbesserung)', () => {
    const better = 'Deutlich ausführlichere zweite Fassung mit allen recherchierten Details. '.repeat(4);
    const out = consolidateDatasheetChangesV3([
      { short_description: 'Erste kurze Fassung.' },
      { short_description: better },
    ]);
    expect(out[0].short_description).toBe(better);
  });
});
