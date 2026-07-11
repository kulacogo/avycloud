/**
 * Smoke-Test für backend/scripts/repair-price-evidence.js (pure Helpers).
 *
 * Das Script lazy-required Firestore/product-store NUR in main() und main()
 * läuft nur via CLI (require.main-Guard) — der Require hier zieht also keinen
 * Firestore-Client hoch. Getestet wird die Repair-Logik, die bei --apply
 * pro Produkt angewendet wird: nicht-candidate-Quellen raus, ohne Rest
 * sources=[] + price_confidence max 0.3, amount unangetastet.
 */

const {
  parseArgs,
  auditPricingSources,
  applyRepairToPricing,
  domainOf,
  CONFIRM_TOKEN,
} = require('../scripts/repair-price-evidence');

describe('repair-price-evidence script — pure helpers', () => {
  describe('parseArgs', () => {
    it('default: audit-only, tenant default, kein limit', () => {
      const args = parseArgs(['node', 'script.js']);
      expect(args.apply).toBe(false);
      expect(args.tenantId).toBe(process.env.TENANT_ID || 'default');
      expect(args.limit).toBeNull();
    });

    it('--apply --confirm --limit --tenant werden geparst', () => {
      const args = parseArgs(['node', 'script.js', '--apply', '--confirm', CONFIRM_TOKEN, '--limit', '25', '--tenant', 'trendocean']);
      expect(args.apply).toBe(true);
      expect(args.confirm).toBe(CONFIRM_TOKEN);
      expect(args.limit).toBe(25);
      expect(args.tenantId).toBe('trendocean');
    });

    it('ungültiges --limit wird ignoriert', () => {
      expect(parseArgs(['node', 'script.js', '--limit', 'abc']).limit).toBeNull();
      expect(parseArgs(['node', 'script.js', '--limit', '-3']).limit).toBeNull();
    });
  });

  describe('auditPricingSources', () => {
    it('klassifiziert gemischte Quellen nach Kind', () => {
      const audit = auditPricingSources({
        lowest_price: {
          amount: 105.99,
          sources: [
            { url: 'https://www.ebay.de/itm/234567890123', price: 105.99 },
            { url: 'https://www.ebay.de/sch/i.html?_nkw=test', price: 59.79 },
            { url: 'https://encrypted-tbn0.gstatic.com/shopping?q=tbn:abc' },
            { url: 'ui' },
          ],
        },
      });
      expect(audit.total).toBe(4);
      expect(audit.byKind).toEqual({ candidate: 1, search: 1, image: 1, invalid: 1 });
    });

    it('keine Quellen → null', () => {
      expect(auditPricingSources(null)).toBeNull();
      expect(auditPricingSources({})).toBeNull();
      expect(auditPricingSources({ lowest_price: { amount: 5, sources: [] } })).toBeNull();
    });
  });

  describe('applyRepairToPricing', () => {
    it('entfernt Müll-Quellen, behält Kandidaten, Confidence bleibt', () => {
      const pricing = {
        lowest_price: {
          amount: 105.99,
          currency: 'EUR',
          sources: [
            { name: 'Angebot', url: 'https://www.ebay.de/itm/234567890123', price: 105.99 },
            { name: 'Suche', url: 'https://www.ebay.de/sch/i.html?_nkw=test', price: 59.79 },
          ],
        },
        price_confidence: 0.8,
      };
      const res = applyRepairToPricing(pricing);
      expect(res.changed).toBe(true);
      expect(res.removed).toBe(1);
      expect(res.kept).toBe(1);
      expect(res.next.lowest_price.sources).toHaveLength(1);
      expect(res.next.lowest_price.sources[0].url).toBe('https://www.ebay.de/itm/234567890123');
      expect(res.next.price_confidence).toBe(0.8);
      expect(res.next.lowest_price.amount).toBe(105.99);
      // Eingabe nicht mutiert
      expect(pricing.lowest_price.sources).toHaveLength(2);
    });

    it('bleibt keine Quelle übrig → sources=[] UND price_confidence max 0.3, amount unangetastet', () => {
      const pricing = {
        lowest_price: {
          amount: 61.99,
          currency: 'EUR',
          sources: [
            { url: 'https://www.ebay.de/sch/i.html?_nkw=test', price: 59.79 },
            { url: 'https://encrypted-tbn0.gstatic.com/shopping?q=tbn:abc' },
          ],
        },
        price_confidence: 0.9,
      };
      const res = applyRepairToPricing(pricing);
      expect(res.changed).toBe(true);
      expect(res.kept).toBe(0);
      expect(res.confidenceCapped).toBe(true);
      expect(res.next.lowest_price.sources).toEqual([]);
      expect(res.next.price_confidence).toBe(0.3);
      expect(res.next.lowest_price.amount).toBe(61.99);
    });

    it('niedrige Confidence wird NICHT angehoben', () => {
      const res = applyRepairToPricing({
        lowest_price: { amount: 5, sources: [{ url: 'ui' }] },
        price_confidence: 0.1,
      });
      expect(res.next.price_confidence).toBe(0.1);
      expect(res.confidenceCapped).toBe(false);
    });

    it('idempotent: nur Kandidaten → changed:false, Objekt unverändert', () => {
      const pricing = {
        lowest_price: {
          amount: 105.99,
          sources: [{ url: 'https://www.ebay.de/itm/234567890123', price: 105.99 }],
        },
        price_confidence: 0.8,
      };
      const res = applyRepairToPricing(pricing);
      expect(res.changed).toBe(false);
      expect(res.next).toBe(pricing);
    });
  });

  describe('domainOf', () => {
    it('strippt www und liefert Fallback für Nicht-URLs', () => {
      expect(domainOf('https://www.ebay.de/sch/i.html')).toBe('ebay.de');
      expect(domainOf('ui')).toBe('(keine-url)');
    });
  });
});
