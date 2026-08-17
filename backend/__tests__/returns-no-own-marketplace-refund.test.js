'use strict';

/**
 * AvyCloud darf KEINE Erstattungen an eBay/Kaufland schicken.
 *
 * Betreiber-Anweisung 2026-08-17 (woertlich): "die erstattungen sind auf ebay
 * und kaufland automatisiert und wird getriggert sobald die retoure bei uns mit
 * sendungsverfolgung eintrifft. ... erstattungen brauchen wir darueber nicht zu
 * machen."
 *
 * Bis dahin gab es einen zweiten, unabhaengigen Erstattungsweg:
 *   Retouren-Dialog "Erstatten" → status='erstattet' → Hintergrundjob
 *   pushPendingMarketplaceRefunds (index.js, alle paar Minuten) →
 *   issueEbayRefund / issueKauflandRefund → ECHTES Geld an den Kunden.
 *
 * Da der Marktplatz beim Eintreffen der Retoure ohnehin automatisch erstattet,
 * ist das ein Pfad fuer DOPPELTE Erstattungen. Gemessen am Bestand: ein Fall
 * (Kaufland-Retoure vom 27.07.2026, 19,99 €) traegt bereits
 * marketplaceRefundStatus='issued'.
 *
 * Der Weg bleibt im Code (falls ein anderer Betreiber ihn je braucht), ist aber
 * hinter einen Schalter gelegt, der standardmaessig AUS ist.
 */

const path = require('path');

function ladeFrisch() {
  const p = require.resolve('../services/returns-engine');
  delete require.cache[p];
  return require('../services/returns-engine');
}

describe('Eigene Marktplatz-Erstattungen sind abgeschaltet', () => {
  const alt = process.env.MARKETPLACE_REFUND_PUSH;
  afterEach(() => {
    if (alt === undefined) delete process.env.MARKETPLACE_REFUND_PUSH;
    else process.env.MARKETPLACE_REFUND_PUSH = alt;
  });

  it('ist ohne Schalter AUS — Standard ist "nicht erstatten"', () => {
    delete process.env.MARKETPLACE_REFUND_PUSH;
    const { marketplaceRefundPushEnabled } = ladeFrisch();
    expect(marketplaceRefundPushEnabled()).toBe(false);
  });

  it('bleibt bei jedem anderen Wert als "on" AUS', () => {
    for (const wert of ['', 'off', 'false', '0', 'nein', 'true', '1', 'yes']) {
      process.env.MARKETPLACE_REFUND_PUSH = wert;
      const { marketplaceRefundPushEnabled } = ladeFrisch();
      expect(marketplaceRefundPushEnabled()).toBe(false);
    }
  });

  it('laesst sich nur mit dem ausdruecklichen Wert "on" einschalten', () => {
    process.env.MARKETPLACE_REFUND_PUSH = 'on';
    const { marketplaceRefundPushEnabled } = ladeFrisch();
    expect(marketplaceRefundPushEnabled()).toBe(true);
  });

  it('der Push-Lauf meldet sich als uebersprungen, statt zu erstatten', async () => {
    delete process.env.MARKETPLACE_REFUND_PUSH;
    const { runRefundPush } = ladeFrisch();
    const res = await runRefundPush({ tenantId: 'default' });
    expect(res.skipped).toBe(true);
    expect(res.processed).toBe(0);
    expect(res.success).toBe(0);
  });
});

describe('Der Hintergrundjob steht unter demselben Schalter', () => {
  const fs = require('fs');
  const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

  it('index.js startet den Erstattungs-Push nur bei aktivem Schalter', () => {
    const i = SOURCE.indexOf('refund-push');
    expect(i).toBeGreaterThan(-1);
    // Im Umfeld des Jobs muss der Schalter geprueft werden.
    const umfeld = SOURCE.slice(Math.max(0, i - 2000), i + 2000);
    expect(umfeld).toMatch(/marketplaceRefundPushEnabled\s*\(/);
  });
});
