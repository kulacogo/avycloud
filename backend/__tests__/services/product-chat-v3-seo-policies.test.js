'use strict';

// SEO-Policies im "Alles optimieren"-Pfad (V3): kategorie-bewusste Titel-/
// Beschreibungs-/Preis-Regeln im System-Prompt + deterministische Durchsetzung
// (Titel ≤80 + Sonderzeichen, Preis-Gap-Füllung). Incident 2026-07-18: V3 hatte
// KEINE SEO-Regeln → Motors-Titel mit Fahrzeugmodell, dünne Beschreibung, kein
// Verkaufspreis.

const path = require('path');
const { _testables } = require(path.join(__dirname, '..', '..', 'services', 'product-chat-v3.js'));
const { buildSeoRulesBlock, buildSystemPromptV3, enforceSeoPoliciesV3, sanitizeDatasheetChangeV3 } = _testables;

function motorsProduct(extra = {}) {
  return {
    id: 'p1',
    identification: { name: 'Mopar Bremsscheibe', brand: 'MOPAR', category: 'Auto & Motorrad: Teile > Autoteile & Zubehör > Bremsen & Bremsenteile > Bremsscheiben' },
    details: { categoryId: '9800', ...extra },
  };
}

describe('buildSeoRulesBlock — kategorie-bewusste SEO-Regeln', () => {
  it('Motors: Fahrzeugmodell-Verbot + OEM-Muster im Prompt', () => {
    const block = buildSeoRulesBlock(motorsProduct());
    expect(block).toContain('KATEGORIE dieses Produkts: motors');
    expect(block).toContain('KEINE Fahrzeugmodelle');
    expect(block).toContain('OEM');
    expect(block).toMatch(/max 80 Zeichen/i);
  });

  it('Beschreibung: ~200 Wörter Fließtext + Keyword-Dichte im Prompt', () => {
    const block = buildSeoRulesBlock(motorsProduct());
    expect(block).toMatch(/180.?240 Wörter/);
    expect(block).toContain('FLIESSTEXT');
    expect(block).toMatch(/Keyword-Dichte 5.?7/);
  });

  it('Preis: sellPrice-Pflicht wenn fehlend im Prompt', () => {
    const block = buildSeoRulesBlock(motorsProduct());
    expect(block).toContain('pricing.sellPrice');
    expect(block).toMatch(/fehlt.*0/i);
  });

  it('Nicht-Motors (Fashion): kein Fahrzeugmodell-Verbot, aber Fashion-Muster', () => {
    const p = { identification: { category: 'Kleidung & Accessoires > Damenmode' }, details: { categoryId: '11450' } };
    const block = buildSeoRulesBlock(p);
    expect(block).toContain('KATEGORIE dieses Produkts: fashion');
    expect(block).not.toContain('KEINE Fahrzeugmodelle');
  });

  it('buildSystemPromptV3 enthält den SEO-Block', () => {
    const prompt = buildSystemPromptV3(motorsProduct());
    expect(prompt).toContain('SEO-TITEL');
    expect(prompt).toContain('KEINE Fahrzeugmodelle');
  });
});

describe('enforceSeoPoliciesV3 — deterministische Durchsetzung', () => {
  it('kürzt Titel > 80 Zeichen auf ≤ 80', () => {
    const longTitle = 'Mopar Bremsscheibe Hinterachse 375mm 68237065AA innenbelüftet beschichtet OEM Qualität Premium';
    const changes = [{ title: longTitle }];
    enforceSeoPoliciesV3(changes, motorsProduct());
    expect(changes[0].title.length).toBeLessThanOrEqual(80);
  });

  it('füllt sellPrice aus Marktpreis, wenn Produkt keinen Verkaufspreis hat', () => {
    const changes = [{ pricing: { amount: 499 } }];
    enforceSeoPoliciesV3(changes, motorsProduct({ pricing: {} }));
    expect(changes[0].pricing.sellPrice).toBe(499);
  });

  it('überschreibt bestehenden sellPrice NIE', () => {
    const changes = [{ pricing: { amount: 499 } }];
    enforceSeoPoliciesV3(changes, motorsProduct({ pricing: { sellPrice: 350 } }));
    expect(changes[0].pricing.sellPrice).toBeUndefined();
  });

  it('setzt keinen sellPrice ohne Marktpreis-Signal', () => {
    const changes = [{ pricing: { currency: 'EUR' } }];
    enforceSeoPoliciesV3(changes, motorsProduct({ pricing: {} }));
    expect(changes[0].pricing.sellPrice).toBeUndefined();
  });
});

describe('sanitizeDatasheetChangeV3 — pricing.sellPrice überlebt', () => {
  it('lässt sellPrice (Zahl) durch', () => {
    const out = sanitizeDatasheetChangeV3({ summary: 's', pricing: { amount: 499, sellPrice: 480, currency: 'EUR' } });
    expect(out.pricing.sellPrice).toBe(480);
    expect(out.pricing.amount).toBe(499);
  });
  it('parst sellPrice als String mit Komma', () => {
    const out = sanitizeDatasheetChangeV3({ summary: 's', pricing: { sellPrice: '12,50' } });
    expect(out.pricing.sellPrice).toBe(12.5);
  });
});
