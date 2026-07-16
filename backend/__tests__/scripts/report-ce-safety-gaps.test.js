'use strict';

/**
 * Tests für backend/scripts/report-ce-safety-gaps.js (pure Helpers).
 *
 * Das Script lazy-required Firestore/product-store NUR in main() und main()
 * läuft nur via CLI (require.main-Guard) — der Require hier zieht also keinen
 * Firestore-Client hoch (Vorbild: repair-price-evidence-script.test.js).
 * checkUrlReachable wird mit injiziertem fetchImpl getestet — kein Netz.
 */

const {
  parseArgs,
  normalizeToken,
  normalizeCategoryText,
  CE_RULES,
  matchCeRules,
  collectCategoryTexts,
  mergedAttributes,
  classifyCeAttributeKey,
  findCeAttributeKeys,
  classifyHazmatToken,
  collectSafetyAttributes,
  evaluateProduct,
  isHttpUrl,
  classifySdsCheck,
  checkUrlReachable,
  csvEscape,
  toCsv,
  CSV_HEADER,
  productEans,
} = require('../../scripts/report-ce-safety-gaps');

describe('report-ce-safety-gaps — pure helpers', () => {
  describe('parseArgs', () => {
    it('defaults: tenant default, kein CSV-Pfad, SDS-Check an', () => {
      const args = parseArgs(['node', 'script.js']);
      expect(args.tenantId).toBe(process.env.TENANT_ID || 'default');
      expect(args.csvPath).toBeNull();
      expect(args.skipSdsCheck).toBe(false);
      expect(args.maxSdsChecks).toBe(200);
    });

    it('positionaler CSV-Pfad + Flags werden geparst', () => {
      const args = parseArgs(['node', 'script.js', '/tmp/out.csv', '--tenant', 'trendocean', '--skip-sds-check', '--max-sds-checks', '10', '--sds-timeout-ms', '5000']);
      expect(args.csvPath).toBe('/tmp/out.csv');
      expect(args.tenantId).toBe('trendocean');
      expect(args.skipSdsCheck).toBe(true);
      expect(args.maxSdsChecks).toBe(10);
      expect(args.sdsTimeoutMs).toBe(5000);
    });

    it('ungültige Zahlen-Flags werden ignoriert (Defaults bleiben)', () => {
      const args = parseArgs(['node', 'script.js', '--max-sds-checks', 'abc', '--sds-timeout-ms', '-1']);
      expect(args.maxSdsChecks).toBe(200);
      expect(args.sdsTimeoutMs).toBe(10000);
    });
  });

  describe('normalizeCategoryText / normalizeToken', () => {
    it('lowercase-ASCII, Umlaute/ß, Breadcrumb-Trenner → Space', () => {
      expect(normalizeCategoryText('Elektro & Werkzeug > LED-Strahler')).toBe('elektro werkzeug led strahler');
      expect(normalizeCategoryText('Sägen | Zubehör')).toBe('sagen zubehor');
      expect(normalizeCategoryText('Straßen-Beleuchtung')).toBe('strassen beleuchtung');
    });

    it('normalizeToken strippt Trenner und ist diakritik-tolerant', () => {
      expect(normalizeToken('CE-Kennzeichnung')).toBe('cekennzeichnung');
      expect(normalizeToken('Sicherheitsinfo (P-Sätze)')).toBe('sicherheitsinfopsatze');
      expect(normalizeToken('Prüfzeichen')).toBe('prufzeichen');
    });
  });

  describe('matchCeRules', () => {
    it('erkennt Elektro (LED/Strahler/Ladegeräte/Bluetooth)', () => {
      expect(matchCeRules('Beleuchtung > LED-Strahler').map((m) => m.id)).toEqual(['elektro']);
      expect(matchCeRules('Handy-Zubehör > Ladegeräte').map((m) => m.id)).toEqual(['elektro']);
      expect(matchCeRules('Handy-Zubehoer > Ladegeraete').map((m) => m.id)).toEqual(['elektro']);
      expect(matchCeRules('Audio > Bluetooth-Lautsprecher').map((m) => m.id)).toEqual(['elektro']);
    });

    it('erkennt Spielzeug mit Richtlinien-Hinweis 2009/48/EG', () => {
      const matches = matchCeRules('Spielzeug > Puppen & Zubehör');
      expect(matches.map((m) => m.id)).toEqual(['spielzeug']);
      expect(matches[0].directive).toContain('2009/48/EG');
    });

    it('erkennt PSA (Komposita wie Fahrradhelme), Gasgrill und Maschinen', () => {
      expect(matchCeRules('Sport > Radsport > Fahrradhelme').map((m) => m.id)).toEqual(['psa']);
      expect(matchCeRules('Garten > Grills > Gasgrills').map((m) => m.id)).toEqual(['gas-druck']);
      expect(matchCeRules('Werkzeug > Kettensägen').map((m) => m.id)).toEqual(['maschinen']);
      expect(matchCeRules('Haushalt > Küchenwaagen').map((m) => m.id)).toEqual(['messgeraete']);
    });

    it('KEIN falscher Alarm bei unverdächtigen Kategorien', () => {
      expect(matchCeRules('Haus & Garten > Deko > Vasen')).toEqual([]);
      expect(matchCeRules('Kleidung > Funktionsshirt')).toEqual([]);
      expect(matchCeRules('Möbel > Regale')).toEqual([]);
      expect(matchCeRules('')).toEqual([]);
    });

    it('matcht über MEHRERE Texte (z. B. eBay-Listing-Kategorie) und dedupliziert pro Regel', () => {
      const matches = matchCeRules(['Sonstiges', 'Elektronik > Netzteile', 'LED-Lampen']);
      expect(matches.map((m) => m.id)).toEqual(['elektro']);
      expect(matches).toHaveLength(1);
    });

    it('jede Regel trägt einen Richtlinien-Hinweis', () => {
      for (const rule of CE_RULES) {
        expect(rule.id).toBeTruthy();
        expect(rule.directive).toMatch(/\d{4}\/\d+/);
        expect(rule.patterns.length).toBeGreaterThan(0);
      }
    });
  });

  describe('collectCategoryTexts', () => {
    it('sammelt identification.category, details.category.path, categoryPath + extra, dedupliziert', () => {
      const product = {
        identification: { category: 'Elektronik > LED' },
        details: {
          category: { path: 'Elektronik > LED' },
          categoryPath: 'Beleuchtung > Strahler',
        },
      };
      expect(collectCategoryTexts(product, ['eBay: Leuchtmittel'])).toEqual([
        'Elektronik > LED',
        'Beleuchtung > Strahler',
        'eBay: Leuchtmittel',
      ]);
    });

    it('details.category als String wird unterstützt', () => {
      expect(collectCategoryTexts({ details: { category: 'Spielzeug' } })).toEqual(['Spielzeug']);
      expect(collectCategoryTexts({})).toEqual([]);
    });
  });

  describe('classifyCeAttributeKey / findCeAttributeKeys', () => {
    it('erkennt CE-/Kennzeichen-Keys (normalizeToken-Scan)', () => {
      for (const key of ['CE', 'ce', 'CE-Kennzeichnung', 'CE Kennzeichen', 'Zertifizierung', 'Zertifikate', 'Prüfzeichen', 'Pruefzeichen', 'Konformitätserklärung', 'EU-Konformität', 'Certification']) {
        expect(classifyCeAttributeKey(key)).toBe(true);
      }
    });

    it('flaggt normale Attribut-Keys NICHT', () => {
      for (const key of ['Farbe', 'Celsius', 'Material', 'Marke', 'Gewicht', '']) {
        expect(classifyCeAttributeKey(key)).toBe(false);
      }
    });

    it('findCeAttributeKeys ignoriert leere Werte', () => {
      const attrs = { 'CE-Kennzeichnung': 'Ja', Zertifizierung: '', Farbe: 'Rot', Prüfzeichen: ['GS'] };
      expect(findCeAttributeKeys(attrs)).toEqual(['CE-Kennzeichnung', 'Prüfzeichen']);
      expect(findCeAttributeKeys({})).toEqual([]);
    });
  });

  describe('classifyHazmatToken / collectSafetyAttributes', () => {
    it('mappt die GHS/CLP-Keys auf Sub-Felder', () => {
      expect(classifyHazmatToken(normalizeToken('Signalwort'))).toBe('signalwort');
      expect(classifyHazmatToken(normalizeToken('Gefahrenhinweise'))).toBe('hSaetze');
      expect(classifyHazmatToken(normalizeToken('Sicherheitsinfo (P-Sätze)'))).toBe('pSaetze');
      expect(classifyHazmatToken(normalizeToken('Sicherheitsdatenblatt'))).toBe('sds');
      expect(classifyHazmatToken(normalizeToken('Farbe'))).toBeNull();
    });

    it('vollständiger Satz → missing leer', () => {
      const safety = collectSafetyAttributes({
        Signalwort: 'Achtung',
        Gefahrenhinweise: 'H222',
        'Sicherheitsinfo (P-Sätze)': 'P210',
        Sicherheitsdatenblatt: 'https://example.com/sds.pdf',
      });
      expect(safety.present).toEqual(['signalwort', 'hSaetze', 'pSaetze', 'sds']);
      expect(safety.missing).toEqual([]);
      expect(safety.fields.sds).toBe('https://example.com/sds.pdf');
    });

    it('nur Signalwort vorhanden → die anderen 3 fehlen', () => {
      const safety = collectSafetyAttributes({ Signalwort: 'Gefahr', Farbe: 'Rot' });
      expect(safety.present).toEqual(['signalwort']);
      expect(safety.missing).toEqual(['hSaetze', 'pSaetze', 'sds']);
    });

    it('keine Safety-Attribute → present UND missing leer (nichts zu prüfen)', () => {
      const safety = collectSafetyAttributes({ Farbe: 'Rot' });
      expect(safety.present).toEqual([]);
      expect(safety.missing).toEqual([]);
    });
  });

  describe('evaluateProduct — Bucket-Entscheidung', () => {
    it('[1] pflichtverdächtig + LIVE + kein CE-Attribut', () => {
      const res = evaluateProduct({
        categoryTexts: ['Beleuchtung > LED-Strahler'],
        attributes: { Farbe: 'Schwarz' },
        hasLiveEbay: true,
        hasLiveKaufland: false,
      });
      expect(res.buckets).toEqual([1]);
      expect(res.live).toBe(true);
    });

    it('[2] pflichtverdächtig, kein CE-Attribut, KEIN Listing', () => {
      const res = evaluateProduct({
        categoryTexts: ['Spielzeug > Puppen'],
        attributes: {},
        hasLiveEbay: false,
        hasLiveKaufland: false,
      });
      expect(res.buckets).toEqual([2]);
    });

    it('[3] CE-Claim in Nicht-Pflicht-Kategorie (Plausibilität)', () => {
      const res = evaluateProduct({
        categoryTexts: ['Haus & Garten > Deko > Vasen'],
        attributes: { 'CE-Kennzeichnung': 'Ja' },
        hasLiveEbay: true,
        hasLiveKaufland: false,
      });
      expect(res.buckets).toEqual([3]);
      expect(res.ceKeys).toEqual(['CE-Kennzeichnung']);
    });

    it('[4] Safety-Attribute vorhanden — kombinierbar mit [1]', () => {
      const res = evaluateProduct({
        categoryTexts: ['Elektronik > Netzteile'],
        attributes: { Signalwort: 'Achtung' },
        hasLiveEbay: false,
        hasLiveKaufland: true,
      });
      expect(res.buckets).toEqual([1, 4]);
    });

    it('pflichtverdächtig MIT CE-Attribut → kein Bucket 1/2/3', () => {
      const res = evaluateProduct({
        categoryTexts: ['Beleuchtung > LED-Strahler'],
        attributes: { 'CE-Kennzeichnung': 'Ja' },
        hasLiveEbay: true,
        hasLiveKaufland: false,
      });
      expect(res.buckets).toEqual([]);
    });
  });

  describe('classifySdsCheck — price-evidence-Doktrin', () => {
    it('2xx/3xx = reachable', () => {
      expect(classifySdsCheck(200)).toBe('reachable');
      expect(classifySdsCheck(301)).toBe('reachable');
    });

    it('404/410 = unreachable (echtes Urteil gegen die URL)', () => {
      expect(classifySdsCheck(404)).toBe('unreachable');
      expect(classifySdsCheck(410)).toBe('unreachable');
    });

    it('0/403/429/5xx = infra_blocked ("konnten nicht prüfen")', () => {
      expect(classifySdsCheck(0)).toBe('infra_blocked');
      expect(classifySdsCheck(403)).toBe('infra_blocked');
      expect(classifySdsCheck(429)).toBe('infra_blocked');
      expect(classifySdsCheck(503)).toBe('infra_blocked');
    });
  });

  describe('checkUrlReachable (fetchImpl injiziert, kein Netz)', () => {
    it('HEAD 200 → reachable ohne GET', async () => {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push(opts.method);
        return { status: 200 };
      };
      const res = await checkUrlReachable('https://example.com/sds.pdf', { fetchImpl });
      expect(res).toEqual({ status: 'reachable', httpStatus: 200, method: 'HEAD' });
      expect(calls).toEqual(['HEAD']);
    });

    it('HEAD 405 → GET-Fallback entscheidet', async () => {
      const fetchImpl = async (url, opts) => ({ status: opts.method === 'HEAD' ? 405 : 200 });
      const res = await checkUrlReachable('https://example.com/sds.pdf', { fetchImpl });
      expect(res).toEqual({ status: 'reachable', httpStatus: 200, method: 'GET' });
    });

    it('HEAD wirft → GET 404 = unreachable', async () => {
      const fetchImpl = async (url, opts) => {
        if (opts.method === 'HEAD') throw new Error('boom');
        return { status: 404 };
      };
      const res = await checkUrlReachable('https://example.com/sds.pdf', { fetchImpl });
      expect(res).toEqual({ status: 'unreachable', httpStatus: 404, method: 'GET' });
    });

    it('beide Versuche werfen → infra_blocked (NIE ein Urteil erfinden)', async () => {
      const fetchImpl = async () => { throw new Error('offline'); };
      const res = await checkUrlReachable('https://example.com/sds.pdf', { fetchImpl });
      expect(res.status).toBe('infra_blocked');
    });
  });

  describe('isHttpUrl / productEans / mergedAttributes / CSV', () => {
    it('isHttpUrl akzeptiert nur http(s)', () => {
      expect(isHttpUrl('https://example.com/a.pdf')).toBe(true);
      expect(isHttpUrl('gs://bucket/a.pdf')).toBe(false);
      expect(isHttpUrl('vorhanden')).toBe(false);
      expect(isHttpUrl('')).toBe(false);
    });

    it('productEans sammelt kanonische Identifier + Barcodes (nur Digits, >=8)', () => {
      const eans = productEans({
        identification: { barcodes: ['4006381333931', 'kaputt'] },
        details: { identifiers: { ean: '4006381333931', upc: '036000291452' } },
      });
      expect(eans).toContain('4006381333931');
      expect(eans).toContain('036000291452');
      expect(eans).toHaveLength(2);
    });

    it('mergedAttributes legt attributes über attributes_extra', () => {
      const merged = mergedAttributes({
        attributes: { Farbe: 'Rot' },
        attributes_extra: { Farbe: 'Blau', Extra: 'x' },
      });
      expect(merged).toEqual({ Farbe: 'Rot', Extra: 'x' });
    });

    it('csvEscape quotet Kommas/Quotes/Newlines, toCsv nutzt den Header', () => {
      expect(csvEscape('a,b')).toBe('"a,b"');
      expect(csvEscape('sagt "hi"')).toBe('"sagt ""hi"""');
      expect(csvEscape('plain')).toBe('plain');
      const csv = toCsv([{ bucket: 1, sku: 'SKU-1', note: 'a,b' }]);
      const lines = csv.trim().split('\n');
      expect(lines[0]).toBe(CSV_HEADER.join(','));
      expect(lines[1]).toContain('"a,b"');
    });
  });
});
