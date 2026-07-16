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
