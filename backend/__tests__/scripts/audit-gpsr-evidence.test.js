'use strict';

/**
 * Smoke-Tests fuer backend/scripts/audit-gpsr-evidence.js (pure Helpers).
 *
 * Das Script lazy-required Firestore/product-store NUR in main() und main()
 * laeuft nur via CLI (require.main-Guard) — der Require hier zieht also
 * keinen Firestore-Client hoch (lib/gpsr-evidence lazy-laedt Firestore erst
 * beim Cache-Zugriff). Getestet werden Scope-/Auswahl-/Apply-Bausteine, die
 * das Script pro Marke bzw. pro Produkt anwendet.
 *
 * Vitest globals: true — describe/it/expect/vi sind global.
 */

const {
  parseArgs,
  pickBrand,
  productSku,
  productEan,
  buildLiveSets,
  isLiveProduct,
  isSellableProduct,
  gpsrCompletenessScore,
  pickRepresentativeGpsr,
  gpsrCoreKey,
  findFakeContacts,
  buildProductApply,
  makeRateLimitedFetch,
  CONFIRM_TOKEN,
} = require('../../scripts/audit-gpsr-evidence');

describe('audit-gpsr-evidence script — pure helpers', () => {
  describe('parseArgs', () => {
    it('default: kein Modus, audit-only, tenant default', () => {
      const args = parseArgs(['node', 'script.js']);
      expect(args.mode).toBeNull();
      expect(args.apply).toBe(false);
      expect(args.tenantId).toBe(process.env.TENANT_ID || 'default');
      expect(args.limit).toBeNull();
      expect(args.noCache).toBe(false);
    });

    it('Modi + Optionen werden geparst', () => {
      const args = parseArgs([
        'node', 'script.js', '--live-only', '--limit', '25',
        '--apply', '--confirm', CONFIRM_TOKEN, '--tenant', 'trendocean',
        '--out', '/tmp/reports', '--no-cache',
      ]);
      expect(args.mode).toBe('live-only');
      expect(args.limit).toBe(25);
      expect(args.apply).toBe(true);
      expect(args.confirm).toBe(CONFIRM_TOKEN);
      expect(args.tenantId).toBe('trendocean');
      expect(args.outDir).toBe('/tmp/reports');
      expect(args.noCache).toBe(true);
    });

    it('--sellable und --all setzen den Modus', () => {
      expect(parseArgs(['node', 's', '--sellable']).mode).toBe('sellable');
      expect(parseArgs(['node', 's', '--all']).mode).toBe('all');
    });

    it('--brand ohne Modus impliziert --all fuer diese Marke', () => {
      const args = parseArgs(['node', 's', '--brand', 'Bosch']);
      expect(args.brand).toBe('Bosch');
      expect(args.mode).toBe('all');
    });

    it('ungueltiges --limit wird ignoriert', () => {
      expect(parseArgs(['node', 's', '--all', '--limit', 'abc']).limit).toBeNull();
      expect(parseArgs(['node', 's', '--all', '--limit', '-3']).limit).toBeNull();
    });
  });

  describe('pickBrand / productSku / productEan / isSellableProduct', () => {
    it('liest identification zuerst, details als Fallback', () => {
      expect(pickBrand({ identification: { brand: 'Bosch' }, details: { brand: 'Alt' } })).toBe('Bosch');
      expect(pickBrand({ details: { brand: 'Makita' } })).toBe('Makita');
      expect(pickBrand({})).toBe('');
      expect(productSku({ identification: { sku: 'SKU-1' } })).toBe('SKU-1');
      expect(productSku({ details: { identifiers: { sku: 'SKU-2' } } })).toBe('SKU-2');
      expect(productEan({ identification: { ean: '4001234567890' } })).toBe('4001234567890');
    });

    it('sellable = inventory.quantity > 0', () => {
      expect(isSellableProduct({ inventory: { quantity: 3 } })).toBe(true);
      expect(isSellableProduct({ inventory: { quantity: 0 } })).toBe(false);
      expect(isSellableProduct({})).toBe(false);
    });
  });

  describe('buildLiveSets / isLiveProduct', () => {
    const ebayDocs = [
      { active: true, sku: 'SKU-EBAY' },
      { active: false, sku: 'SKU-EBAY-ENDED' },
      { active: true }, // ohne SKU → ignoriert
    ];
    const kauflandDocs = [
      { active: true, id_offer: 'SKU-KL', ean: '4009876543210', status: 'AVAILABLE' },
      { active: true, id_offer: 'SKU-STALE', status: 'STALE' },      // Tombstone
      { active: true, id_offer: 'SKU-NF', status: 'NOT_FOUND' },     // Tombstone
      { active: false, id_offer: 'SKU-KL-OFF', status: 'AVAILABLE' },
    ];

    it('sammelt aktive eBay-SKUs + Kaufland-SKUs/EANs, ohne Tombstones/inaktive', () => {
      const sets = buildLiveSets(ebayDocs, kauflandDocs);
      expect(sets.skus.has('SKU-EBAY')).toBe(true);
      expect(sets.skus.has('SKU-KL')).toBe(true);
      expect(sets.eans.has('4009876543210')).toBe(true);
      expect(sets.skus.has('SKU-EBAY-ENDED')).toBe(false);
      expect(sets.skus.has('SKU-STALE')).toBe(false);
      expect(sets.skus.has('SKU-NF')).toBe(false);
      expect(sets.skus.has('SKU-KL-OFF')).toBe(false);
    });

    it('isLiveProduct matcht per SKU oder EAN', () => {
      const sets = buildLiveSets(ebayDocs, kauflandDocs);
      expect(isLiveProduct({ identification: { sku: 'SKU-EBAY' } }, sets)).toBe(true);
      expect(isLiveProduct({ identification: { sku: 'X', ean: '4009876543210' } }, sets)).toBe(true);
      expect(isLiveProduct({ identification: { sku: 'SKU-OFFLINE' } }, sets)).toBe(false);
    });
  });

  describe('pickRepresentativeGpsr', () => {
    it('waehlt den vollstaendigsten Record mit manufacturer_name', () => {
      const rep = pickRepresentativeGpsr([
        { sku: 'A', gpsr: { manufacturer_name: 'Bosch' } },
        {
          sku: 'B',
          gpsr: {
            manufacturer_name: 'Bosch GmbH',
            manufacturer_address: 'Carl-Wery-Str. 34, 81739 München',
            url: 'https://www.bosch.de',
            email: 'info@bosch.de',
          },
        },
        { sku: 'C', gpsr: { manufacturer_address: 'ohne Name — nicht waehlbar' } },
      ]);
      expect(rep.sku).toBe('B');
      expect(rep.gpsr.url).toBe('https://www.bosch.de');
      expect(rep.score).toBeGreaterThan(gpsrCompletenessScore({ manufacturer_name: 'Bosch' }));
    });

    it('kein Record mit manufacturer_name → null', () => {
      expect(pickRepresentativeGpsr([{ sku: 'A', gpsr: { email: 'x@y.de' } }])).toBeNull();
      expect(pickRepresentativeGpsr([])).toBeNull();
    });
  });

  describe('gpsrCoreKey', () => {
    it('diakritik-/ß-/interpunktions-tolerant, Adresse unterscheidet', () => {
      const a = gpsrCoreKey({ manufacturer_name: 'Müller GmbH', manufacturer_address: 'Hauptstraße 1, 80331 München' });
      const b = gpsrCoreKey({ manufacturer_name: 'MÜLLER   GmbH.', manufacturer_address: 'Hauptstrasse 1 — 80331 Munchen' });
      expect(a).toBe(b);
      const c = gpsrCoreKey({ manufacturer_name: 'Müller GmbH', manufacturer_address: 'Andere Str. 9' });
      expect(a).not.toBe(c);
    });
  });

  describe('findFakeContacts', () => {
    it('flaggt den Audit-Fall +496105456789 (456789-Sequenz) auf beiden Phone-Keys', () => {
      const findings = findFakeContacts(
        { manufacturer_phone: '+496105456789', phone: '123456789' },
        { brand: 'Apple' }
      );
      const fields = findings.map((f) => f.field);
      expect(fields).toContain('manufacturer_phone');
      expect(fields).toContain('phone');
      expect(findings.every((f) => f.reason === 'fake_phone_pattern')).toBe(true);
    });

    it('persoenliche Freemail als Hersteller-Kontakt → suspect_email', () => {
      const findings = findFakeContacts({ email: 'okopp@gmail.com' }, { brand: 'Bosch' });
      expect(findings).toHaveLength(1);
      expect(findings[0].field).toBe('email');
      expect(findings[0].reason).toBe('suspect_email:personal_freemail');
    });

    it('echte Nummer + Hersteller-Domain-Mail → keine Funde', () => {
      const findings = findFakeContacts(
        { manufacturer_phone: '+49 89 80094450', email: 'service@bosch.de', url: 'https://www.bosch.de' },
        { brand: 'Bosch' }
      );
      expect(findings).toEqual([]);
    });

    it('nutzt fallbackUrl wenn der Produkt-Record keine url traegt', () => {
      // fremde Firmen-Domain relativ zur Hersteller-URL → suspect
      const findings = findFakeContacts(
        { email: 'info@andere-firma.de' },
        { brand: 'Bosch', fallbackUrl: 'https://www.bosch.de' }
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].reason).toBe('suspect_email:foreign_domain');
    });
  });

  describe('buildProductApply', () => {
    const verifiedVerdict = {
      status: 'verified',
      evidenceUrl: 'https://www.bosch.de/impressum',
      checkedAt: '2026-07-16T10:00:00.000Z',
      brand: 'Bosch',
      fallbackUrl: 'https://www.bosch.de',
      stampEvidence: true,
    };

    it('stempelt evidence {status,url,checked_at} und laesst Name/Adresse unangetastet', () => {
      const data = {
        details: {
          gpsr: {
            manufacturer_name: 'Bosch GmbH',
            manufacturer_address: 'Carl-Wery-Str. 34, 81739 München',
          },
        },
      };
      const res = buildProductApply(data, verifiedVerdict);
      expect(res.changed).toBe(true);
      expect(res.evidenceSet).toBe(true);
      expect(res.gpsr.evidence).toEqual({
        status: 'verified',
        url: 'https://www.bosch.de/impressum',
        checked_at: '2026-07-16T10:00:00.000Z',
      });
      expect(res.gpsr.manufacturer_name).toBe('Bosch GmbH');
      expect(res.gpsr.manufacturer_address).toBe('Carl-Wery-Str. 34, 81739 München');
      // Eingabe nicht mutiert
      expect(data.details.gpsr.evidence).toBeUndefined();
    });

    it('idempotent: gleicher status+url bereits gestempelt, keine Fakes → changed:false', () => {
      const data = {
        details: {
          gpsr: {
            manufacturer_name: 'Bosch GmbH',
            evidence: { status: 'verified', url: 'https://www.bosch.de/impressum', checked_at: '2026-07-01T00:00:00.000Z' },
          },
        },
      };
      const res = buildProductApply(data, verifiedVerdict);
      expect(res.changed).toBe(false);
      expect(res.evidenceSet).toBe(false);
      expect(res.nulled).toEqual([]);
    });

    it('nullt Fake-Telefon + suspecte E-Mail und weist sie aus', () => {
      const data = {
        details: {
          gpsr: {
            manufacturer_name: 'Bosch GmbH',
            manufacturer_phone: '+496105456789',
            email: 'okopp@gmail.com',
          },
        },
      };
      const res = buildProductApply(data, verifiedVerdict);
      expect(res.changed).toBe(true);
      expect(res.gpsr.manufacturer_phone).toBeNull();
      expect(res.gpsr.email).toBeNull();
      expect(res.nulled.map((n) => n.field).sort()).toEqual(['email', 'manufacturer_phone']);
      // Eingabe nicht mutiert
      expect(data.details.gpsr.manufacturer_phone).toBe('+496105456789');
    });

    it('unverifiable setzt den ops-Marker', () => {
      const res = buildProductApply(
        { details: { gpsr: { manufacturer_name: 'X' } } },
        { ...verifiedVerdict, status: 'unverifiable', evidenceUrl: null }
      );
      expect(res.markerSet).toBe(true);
      expect(res.nextMarker).toBe('unverifiable');
      expect(res.gpsr.evidence.status).toBe('unverifiable');
      expect(res.gpsr.evidence.url).toBeNull();
    });

    it('heilt einen veralteten unverifiable-Marker bei verified', () => {
      const res = buildProductApply(
        {
          details: { gpsr: { manufacturer_name: 'Bosch GmbH' } },
          ops: { data_quality: { gpsr_evidence: 'unverifiable' } },
        },
        verifiedVerdict
      );
      expect(res.markerSet).toBe(true);
      expect(res.nextMarker).toBe('verified');
    });

    it('infra_blocked (stampEvidence:false): kein Stempel, kein Marker — Fake-Nullung laeuft trotzdem', () => {
      const res = buildProductApply(
        { details: { gpsr: { manufacturer_name: 'X', manufacturer_phone: '000000000000' } } },
        { status: 'infra_blocked', evidenceUrl: null, checkedAt: '2026-07-16T10:00:00.000Z', brand: 'X', stampEvidence: false }
      );
      expect(res.evidenceSet).toBe(false);
      expect(res.markerSet).toBe(false);
      expect(res.gpsr.evidence).toBeUndefined();
      expect(res.gpsr.manufacturer_phone).toBeNull();
      expect(res.changed).toBe(true);
    });

    it('Produkt ohne details.gpsr bekommt trotzdem den Beleg-Stempel', () => {
      const res = buildProductApply({}, verifiedVerdict);
      expect(res.changed).toBe(true);
      expect(res.gpsr.evidence.status).toBe('verified');
    });
  });

  describe('makeRateLimitedFetch', () => {
    it('reserviert Zeit-Slots: 3 Abrufe bei 50/s dauern >= 2 Intervalle', async () => {
      const calls = [];
      const base = vi.fn(async (url, opts) => {
        calls.push(url);
        return { ok: true, status: 200, url, opts };
      });
      const limited = makeRateLimitedFetch(base, 50); // 20ms Intervall
      const t0 = Date.now();
      await limited('u1', { timeoutMs: 1 });
      await limited('u2', { timeoutMs: 1 });
      await limited('u3', { timeoutMs: 1 });
      const elapsed = Date.now() - t0;
      expect(calls).toEqual(['u1', 'u2', 'u3']);
      expect(base).toHaveBeenCalledTimes(3);
      // 2 gebremste Abrufe à >=20ms (Toleranz fuer Timer-Jitter)
      expect(elapsed).toBeGreaterThanOrEqual(35);
      // Optionen werden durchgereicht
      expect(base.mock.calls[0][1]).toEqual({ timeoutMs: 1 });
    });

    it('erster Abruf laeuft ungebremst durch', async () => {
      const base = vi.fn(async () => ({ ok: true }));
      const limited = makeRateLimitedFetch(base, 2);
      const t0 = Date.now();
      await limited('only');
      expect(Date.now() - t0).toBeLessThan(100);
    });
  });
});
