'use strict';

/**
 * EZB-Referenzkurse fuer Marktplatz-Bestellungen in Fremdwaehrung.
 *
 * Anlass (2026-10-05): Kaufland.cz-Bestellung M53KUW5 ueber 534,14 CZK wurde als
 * 534,14 EUR gespeichert. Die Kaufland-API liefert keinen Wechselkurs; die
 * EZB-Datei eurofxref-hist-90d.xml (ohne Anmeldung) fuehrt CZK und PLN taeglich.
 * Gemessen am 05.10.2026: letzter Eintrag 2026-10-02 (Freitag) mit CZK 24,470 und
 * PLN 4,3775 — der 03.10. ist ein Samstag, dafuer gilt der Freitagskurs.
 */

const {
  parseEcbXml,
  pickRateForDate,
  convertToEur,
  pruneTable,
  createFxRateResolver,
  FALLBACK_RATES,
} = require('../lib/fx-rates');

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <gesmes:Sender><gesmes:name>European Central Bank</gesmes:name></gesmes:Sender>
  <Cube>
    <Cube time='2026-10-02'>
      <Cube currency='USD' rate='1.1712'/>
      <Cube currency='CZK' rate='24.470'/>
      <Cube currency='PLN' rate='4.3775'/>
    </Cube>
    <Cube time='2026-10-01'>
      <Cube currency='USD' rate='1.1700'/>
      <Cube currency='CZK' rate='24.410'/>
      <Cube currency='PLN' rate='4.3700'/>
    </Cube>
    <Cube time='2026-09-30'>
      <Cube currency='CZK' rate='24.350'/>
      <Cube currency='PLN' rate='4.3600'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

describe('parseEcbXml — die EZB-Datei lesen', () => {
  it('liefert je Tag eine Kurstabelle, Werte als Zahlen', () => {
    const table = parseEcbXml(XML);
    expect(Object.keys(table).sort()).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
    expect(table['2026-10-02'].CZK).toBe(24.47);
    expect(table['2026-10-02'].PLN).toBe(4.3775);
    expect(table['2026-10-02'].USD).toBe(1.1712);
    expect(table['2026-09-30'].USD).toBeUndefined();
  });

  it('wirft nicht bei Muell, sondern liefert eine leere Tabelle', () => {
    expect(parseEcbXml('')).toEqual({});
    expect(parseEcbXml(null)).toEqual({});
    expect(parseEcbXml('<html>Service Unavailable</html>')).toEqual({});
  });

  it('ignoriert Zeilen ohne gueltige Zahl', () => {
    const table = parseEcbXml(`<Cube><Cube time='2026-10-02'><Cube currency='CZK' rate='N/A'/><Cube currency='PLN' rate='4.3775'/></Cube></Cube>`);
    expect(table['2026-10-02'].CZK).toBeUndefined();
    expect(table['2026-10-02'].PLN).toBe(4.3775);
  });
});

describe('pickRateForDate — letzter veroeffentlichter Kurs vor dem Bestelldatum', () => {
  const table = parseEcbXml(XML);

  it('nimmt den Kurs des Tages, wenn er existiert', () => {
    expect(pickRateForDate(table, 'CZK', '2026-10-01')).toEqual({ rate: 24.41, rateDate: '2026-10-01' });
  });

  it('Samstag → Freitagskurs (M53KUW5 wurde am Samstag 03.10. bestellt)', () => {
    expect(pickRateForDate(table, 'CZK', '2026-10-03T15:09:12Z')).toEqual({ rate: 24.47, rateDate: '2026-10-02' });
  });

  it('Datum vor dem ersten Eintrag → null (nie den aeltesten Kurs raten)', () => {
    expect(pickRateForDate(table, 'CZK', '2026-09-01')).toBeNull();
  });

  it('unbekannte Waehrung → null; Waehrung ist case-insensitiv', () => {
    expect(pickRateForDate(table, 'HUF', '2026-10-02')).toBeNull();
    expect(pickRateForDate(table, 'czk', '2026-10-02')).toEqual({ rate: 24.47, rateDate: '2026-10-02' });
  });

  it('ungueltiges Datum → null', () => {
    expect(pickRateForDate(table, 'CZK', 'kein-datum')).toBeNull();
    expect(pickRateForDate(table, 'CZK', null)).toBeNull();
  });
});

describe('convertToEur — Cent-genau', () => {
  it('534,14 CZK zu 24,470 sind 21,83 €', () => {
    expect(convertToEur(534.14, 24.47)).toBe(21.83);
  });

  it('rundet kaufmaennisch auf Cent', () => {
    expect(convertToEur(100, 4.3775)).toBe(22.84); // 22.8441…
    expect(convertToEur(0, 24.47)).toBe(0);
  });

  it('ungueltiger Kurs oder Betrag → null statt NaN', () => {
    expect(convertToEur(10, 0)).toBeNull();
    expect(convertToEur(10, -1)).toBeNull();
    expect(convertToEur('abc', 24.47)).toBeNull();
    expect(convertToEur(10, null)).toBeNull();
  });
});

describe('pruneTable — die Firestore-Kopie waechst nicht ins Unendliche', () => {
  it('behaelt nur die juengsten N Tage', () => {
    const table = {};
    for (let i = 0; i < 10; i += 1) table[`2026-01-${String(i + 1).padStart(2, '0')}`] = { CZK: 25 };
    const pruned = pruneTable(table, 3);
    expect(Object.keys(pruned).sort()).toEqual(['2026-01-08', '2026-01-09', '2026-01-10']);
  });
});

describe('createFxRateResolver — Kurs holen, cachen, Notkurs', () => {
  function makeStore(initial = null) {
    const state = { saved: [], table: initial };
    return {
      state,
      load: vi.fn(async () => state.table),
      save: vi.fn(async (table) => { state.saved.push(table); state.table = table; }),
    };
  }
  function okFetch(xml = XML) {
    return vi.fn(async () => ({ ok: true, status: 200, text: async () => xml }));
  }

  it('EUR braucht keinen Kurs', async () => {
    const fetchImpl = okFetch();
    const r = createFxRateResolver({ fetchImpl, store: makeStore() });
    const res = await r.getEurRate({ currency: 'EUR', date: '2026-10-03' });
    expect(res).toEqual({ currency: 'EUR', rate: 1, rateDate: null, source: 'identity', pending: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('holt die EZB-Datei, speichert sie und liefert den Freitagskurs fuer den Samstag', async () => {
    const fetchImpl = okFetch();
    const store = makeStore();
    const r = createFxRateResolver({ fetchImpl, store, now: () => new Date('2026-10-05T10:00:00Z') });
    const res = await r.getEurRate({ currency: 'CZK', date: '2026-10-03T15:09:12Z' });
    expect(res).toEqual({ currency: 'CZK', rate: 24.47, rateDate: '2026-10-02', source: 'ecb', pending: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('eurofxref-hist-90d.xml');
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.state.table['2026-10-02'].CZK).toBe(24.47);
  });

  it('zweiter Aufruf kommt aus dem Speicher — kein zweiter Netzaufruf', async () => {
    const fetchImpl = okFetch();
    const r = createFxRateResolver({ fetchImpl, store: makeStore(), now: () => new Date('2026-10-05T10:00:00Z') });
    await r.getEurRate({ currency: 'CZK', date: '2026-10-02' });
    await r.getEurRate({ currency: 'PLN', date: '2026-10-01' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gleichzeitige Aufrufe teilen sich EINEN Netzaufruf', async () => {
    const fetchImpl = okFetch();
    const r = createFxRateResolver({ fetchImpl, store: makeStore(), now: () => new Date('2026-10-05T10:00:00Z') });
    const [a, b, c] = await Promise.all([
      r.getEurRate({ currency: 'CZK', date: '2026-10-02' }),
      r.getEurRate({ currency: 'CZK', date: '2026-10-02' }),
      r.getEurRate({ currency: 'PLN', date: '2026-10-02' }),
    ]);
    expect(a.rate).toBe(24.47);
    expect(b.rate).toBe(24.47);
    expect(c.rate).toBe(4.3775);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('eine vorhandene Firestore-Kopie erspart den Netzaufruf', async () => {
    const fetchImpl = okFetch();
    const store = makeStore(parseEcbXml(XML));
    const r = createFxRateResolver({ fetchImpl, store, now: () => new Date('2026-10-02T18:00:00Z') });
    const res = await r.getEurRate({ currency: 'PLN', date: '2026-10-02' });
    expect(res.rate).toBe(4.3775);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Datum NACH dem letzten bekannten Kurs → frisch laden, aber hoechstens alle 6 Stunden', async () => {
    const fetchImpl = okFetch();
    const store = makeStore(parseEcbXml(XML)); // endet 2026-10-02
    let clock = new Date('2026-10-05T10:00:00Z');
    const r = createFxRateResolver({ fetchImpl, store, now: () => clock });
    await r.getEurRate({ currency: 'CZK', date: '2026-10-05' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // Montag, Kurs noch nicht da → nachsehen
    await r.getEurRate({ currency: 'CZK', date: '2026-10-05' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // innerhalb von 6 h nicht nochmal
    clock = new Date('2026-10-05T17:00:00Z');
    await r.getEurRate({ currency: 'CZK', date: '2026-10-05' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('EZB nicht erreichbar → Notkurs, als pending markiert, Intake blockiert nie', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ENOTFOUND www.ecb.europa.eu'); });
    const r = createFxRateResolver({ fetchImpl, store: makeStore(), now: () => new Date('2026-10-05T10:00:00Z') });
    const res = await r.getEurRate({ currency: 'CZK', date: '2026-10-03' });
    expect(res.source).toBe('static_fallback');
    expect(res.pending).toBe(true);
    expect(res.rate).toBe(FALLBACK_RATES.rates.CZK);
    expect(res.rateDate).toBe(FALLBACK_RATES.asOf);
  });

  it('EZB antwortet mit HTTP 503 → Notkurs', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, text: async () => 'busy' }));
    const r = createFxRateResolver({ fetchImpl, store: makeStore(), now: () => new Date('2026-10-05T10:00:00Z') });
    const res = await r.getEurRate({ currency: 'PLN', date: '2026-10-03' });
    expect(res.source).toBe('static_fallback');
    expect(res.pending).toBe(true);
  });

  it('Waehrung ohne Notkurs → source none, rate null, pending', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
    const r = createFxRateResolver({ fetchImpl, store: makeStore(), now: () => new Date('2026-10-05T10:00:00Z') });
    const res = await r.getEurRate({ currency: 'HUF', date: '2026-10-03' });
    expect(res).toEqual({ currency: 'HUF', rate: null, rateDate: null, source: 'none', pending: true });
  });

  it('Datum aelter als die 90-Tage-Datei → volle Historie, ohne sie in Firestore zu schreiben', async () => {
    const fullXml = XML.replace("<Cube time='2026-09-30'>", "<Cube time='2026-03-02'>");
    const fetchImpl = vi.fn(async (url) => ({
      ok: true,
      status: 200,
      text: async () => (String(url).includes('hist-90d') ? XML : fullXml),
    }));
    const store = makeStore();
    const r = createFxRateResolver({ fetchImpl, store, now: () => new Date('2026-10-05T10:00:00Z') });
    const res = await r.getEurRate({ currency: 'CZK', date: '2026-03-03' });
    expect(res).toEqual({ currency: 'CZK', rate: 24.35, rateDate: '2026-03-02', source: 'ecb', pending: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1][0])).toContain('eurofxref-hist.xml');
    // Die 90-Tage-Kopie wurde gespeichert, die volle Historie nicht (Dokumentgroesse).
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.state.table['2026-03-02']).toBeUndefined();
  });

  it('ein kaputter Speicher bremst nicht — Laden und Schreiben sind best-effort', async () => {
    const store = {
      load: vi.fn(async () => { throw new Error('PERMISSION_DENIED'); }),
      save: vi.fn(async () => { throw new Error('PERMISSION_DENIED'); }),
    };
    const r = createFxRateResolver({ fetchImpl: okFetch(), store, now: () => new Date('2026-10-05T10:00:00Z') });
    const res = await r.getEurRate({ currency: 'CZK', date: '2026-10-02' });
    expect(res.rate).toBe(24.47);
    expect(res.source).toBe('ecb');
  });
});
