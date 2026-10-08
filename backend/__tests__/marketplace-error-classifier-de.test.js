'use strict';

/**
 * Vorfall 2026-10-08: eBay antwortet auf Site 77 (DE) und den Laendersites
 * DEUTSCH/ITALIENISCH/SPANISCH. Der dauerhaft scheiternde Revise fuer
 * 800540262903 („W34 L34" ist kein gueltiger Wert fuer Groesse) wurde als
 * `unknown` (retryable) eingestuft und deshalb alle 30 min von der
 * Reconciliation erneut gepusht — 1 + 4 Geschwister-Revises je Lauf,
 * ~240 Trading-Aufrufe am Tag fuer EIN Produkt, das sich so nie heilt.
 */

const { classifyMarketplaceError } = require('../lib/marketplace-error-classifier');

describe('classifyMarketplaceError — deutsche/italienische/spanische eBay-Texte', () => {
  it.each([
    '„W34 L34“ ist kein gültiger Wert für Größe. Wählen Sie einen Wert aus den verfügbaren Optionen aus.',
    '"W34 L34" non è un valore valido per Taglia. Seleziona un valore tra le opzioni disponibili.',
    '"W34 L34" no es un valor válido para Talla. Selecciona un valor de entre las opciones disponibles.',
    'Der Wert für das Artikelmerkmal Marke ist ungültig.',
  ])('stuft %p als listing_config (nicht retryable) ein', (msg) => {
    const out = classifyMarketplaceError(msg);
    expect(out.class).toBe('listing_config');
    expect(out.retryable).toBe(false);
  });

  it('deutsche Token-Fehler bleiben auth', () => {
    const out = classifyMarketplaceError('Die Validierung des Authentifizierungs-Tokens in der API-Anfrage ist fehlgeschlagen.');
    expect(out.class).toBe('auth');
  });
});
