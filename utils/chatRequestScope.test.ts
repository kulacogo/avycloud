import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { previewChatRequestScope, shouldParseUnstructuredEdits } from './chatRequestScope.ts';
const require = createRequire(import.meta.url);
const catalog = require('../backend/lib/chat-request-scope-catalog.json');
const { resolveRequestScope } = require('../backend/lib/chat-scope');

describe('visible chat request scope', () => {
  for (const [message, scope, label] of [
    ['Titel verbessern', undefined, 'Nur Titel'],
    ['Preisrecherche', undefined, 'Nur Preis'],
    ['Nur Titel verbessern, Marke nicht ändern', undefined, 'Nur Titel'],
    ['Preisrecherche für Marke Bosch', undefined, 'Nur Preis'],
    ['Bitte Titel anhand der Produktbeschreibung verbessern', undefined, 'Nur Titel'],
    ['Preis Marke Bosch verbessern', undefined, 'Arbeitsumfang klären'],
    ['Titel mit Marke und Modell verbessern', undefined, 'Nur Titel'],
    ['Titel verbessern, lass den Preis unverändert', undefined, 'Nur Titel'],
    ['Nicht den Preis, sondern nur den Titel verbessern', undefined, 'Nur Titel'],
    ['Titel und Beschreibung verbessern, ohne Preisrecherche', undefined, 'Nur Titel + Beschreibung'],
    ['KEINE Herstelleradressen im Titel', 'title', 'Nur Titel'],
    ['Alles optimieren', 'title,pricing,datasheet', 'Alles optimieren'],
    ['Was bedeutet GPSR?', undefined, 'Antwort · keine Änderungen'],
    ['Mach es besser', undefined, 'Arbeitsumfang klären'],
  ]) it(`shows the same scope as the API: ${message}`, () => {
    const preview = previewChatRequestScope(message!, scope, catalog);
    assert.equal(preview.label, label);
    assert.deepEqual(preview, resolveRequestScope({ scope, message }));
  });
  it('does not turn rejected JSON prose into an apply card', () => {
    assert.equal(shouldParseUnstructuredEdits({ enforced: true }), false);
    assert.equal(shouldParseUnstructuredEdits(), true);
  });
});
