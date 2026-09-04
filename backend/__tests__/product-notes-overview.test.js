'use strict';

/**
 * Notizen-Uebersicht fuer den Produkttabellen-Filter (gelesen/ungelesen,
 * letzte Notiz). Rein die puren Bausteine — Firestore bleibt draussen.
 */

const {
  aggregateNotesOverview,
  mergeSeenIntoOverview,
  seenDocId,
  buildSeenUpdate,
} = require('../services/product-notes');

describe('aggregateNotesOverview', () => {
  it('liefert Anzahl und juengsten Notiz-Zeitstempel je Produkt', () => {
    const overview = aggregateNotesOverview([
      { productId: 'p1', createdAt: '2026-08-20T10:00:00.000Z' },
      { productId: 'p1', createdAt: '2026-08-26T09:00:00.000Z' },
      { productId: 'p2', createdAt: '2026-08-01T08:00:00.000Z' },
    ]);
    expect(overview).toEqual({
      p1: { count: 2, lastNoteAt: '2026-08-26T09:00:00.000Z', seenAt: null },
      p2: { count: 1, lastNoteAt: '2026-08-01T08:00:00.000Z', seenAt: null },
    });
  });

  it('ueberlebt Altbestand ohne createdAt und Muell-Zeilen', () => {
    const overview = aggregateNotesOverview([
      { productId: 'p1' },
      { productId: '' },
      null,
      { text: 'ohne productId' },
    ]);
    expect(overview).toEqual({ p1: { count: 1, lastNoteAt: null, seenAt: null } });
  });
});

describe('mergeSeenIntoOverview', () => {
  it('haengt den eigenen Gelesen-Stand an die passenden Produkte', () => {
    const overview = {
      p1: { count: 2, lastNoteAt: '2026-08-26T09:00:00.000Z', seenAt: null },
      p2: { count: 1, lastNoteAt: '2026-08-01T08:00:00.000Z', seenAt: null },
    };
    const merged = mergeSeenIntoOverview(overview, { p1: '2026-08-27T07:00:00.000Z', fremd: 'x' });
    expect(merged.p1.seenAt).toBe('2026-08-27T07:00:00.000Z');
    expect(merged.p2.seenAt).toBeNull();
    expect(Object.keys(merged)).toEqual(['p1', 'p2']);
  });

  it('leerer oder fehlender Gelesen-Stand aendert nichts', () => {
    const overview = { p1: { count: 1, lastNoteAt: null, seenAt: null } };
    expect(mergeSeenIntoOverview(overview, null).p1.seenAt).toBeNull();
  });
});

describe('seenDocId + buildSeenUpdate', () => {
  it('Doc-Id ist tenant-gebunden, Update ist ein merge-faehiger Map-Patch', () => {
    expect(seenDocId({ tenantId: 'default', userId: 'u1' })).toBe('default__u1');
    const update = buildSeenUpdate({
      tenantId: 'default',
      userId: 'u1',
      productId: ' p9 ',
      nowIso: '2026-08-29T10:00:00.000Z',
    });
    expect(update).toEqual({
      tenantId: 'default',
      userId: 'u1',
      seen: { p9: '2026-08-29T10:00:00.000Z' },
    });
  });

  it('wirft ohne userId oder productId (kein stiller Global-Stand)', () => {
    expect(() => buildSeenUpdate({ tenantId: 'default', userId: '', productId: 'p1', nowIso: 'x' })).toThrow();
    expect(() => buildSeenUpdate({ tenantId: 'default', userId: 'u1', productId: '  ', nowIso: 'x' })).toThrow();
  });
});
