/**
 * cleanUndefined darf Firestore-Spezialwerte NICHT zerlegen (2026-08-26).
 *
 * Befund: cleanUndefined lief per Object.entries ueber JEDES Objekt — auch
 * ueber FieldValue.serverTimestamp()-Sentinels und Timestamp-Instanzen. Deren
 * innere Felder sind nicht enumerierbar → gespeichert wurde ein leeres {}.
 * Folge in Produktion: ALLE Spiegel-Docs in ebayListingsLive tragen
 * updatedAt/lastSeenAt/lastChangedAt/firstSeenAt als leere Map, die Listings-
 * Seite zeigt "Letzter Sync: —" und "Letztes Update —", obwohl der Sync
 * alle 15 Minuten sauber laeuft.
 *
 * Die echten Klassen werden VOR dem GCP-Patch aus dem realen Paket gezogen,
 * damit hier das reale Verhalten getestet wird — nicht ein Duck-Type-Stub.
 */

const realFirestorePkg = require('@google-cloud/firestore');
const RealFieldValue = realFirestorePkg.FieldValue;
const RealTimestamp = realFirestorePkg.Timestamp;

require('./api/_patchGcp');
require('./api/_patchLocalModules');

const { cleanUndefined } = require('../lib/ebay-direct');

describe('cleanUndefined — Firestore-Sentinels und Timestamps bleiben unangetastet', () => {
  it('entfernt undefined-Schluessel, behaelt null (bestehender Vertrag)', () => {
    expect(cleanUndefined({ a: undefined, b: 1, c: null })).toEqual({ b: 1, c: null });
  });

  it('FieldValue.serverTimestamp() ueberlebt IDENTISCH (kein leeres {})', () => {
    const sentinel = RealFieldValue.serverTimestamp();
    const out = cleanUndefined({ updatedAt: sentinel, dead: undefined });
    expect(out.updatedAt).toBe(sentinel);
    expect('dead' in out).toBe(false);
  });

  it('Timestamp-Instanz ueberlebt identisch', () => {
    const ts = RealTimestamp.fromMillis(1756166400000);
    const out = cleanUndefined({ firstSeenAt: ts });
    expect(out.firstSeenAt).toBe(ts);
  });

  it('Date-Instanz ueberlebt identisch', () => {
    const d = new Date('2026-08-26T00:00:00Z');
    const out = cleanUndefined({ at: d });
    expect(out.at).toBe(d);
  });

  it('verschachtelt: Sentinel ueberlebt, undefined wird weiter entfernt', () => {
    const sentinel = RealFieldValue.serverTimestamp();
    const out = cleanUndefined({ source: { ingestedAt: sentinel, actor: undefined, mode: 'trading_api' } });
    expect(out.source.ingestedAt).toBe(sentinel);
    expect('actor' in out.source).toBe(false);
    expect(out.source.mode).toBe('trading_api');
  });

  it('in Arrays: Sentinel ueberlebt', () => {
    const sentinel = RealFieldValue.serverTimestamp();
    const out = cleanUndefined({ list: [sentinel, undefined, 'x'] });
    expect(out.list[0]).toBe(sentinel);
    expect(out.list).toHaveLength(2);
  });
});
