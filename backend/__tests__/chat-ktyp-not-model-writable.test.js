'use strict';

/**
 * Der K-Typ ist kein Feld, das ein Sprachmodell befüllen darf.
 *
 * Vorfall 2026-08-17: Auf die Bitte "K-Typ ermitteln" lieferte der Assistent
 * HSN/TSN-Paare und legte sie in einem selbst erfundenen Merkmal ab.
 *
 * Der K-Typ ist eine ZAHLEN-Kennung aus eBays Fahrzeugliste (MVL). Er wird
 * NACHGESCHLAGEN, nie geschätzt — ein geratener K-Typ behauptet gegenüber
 * Käufern Passgenauigkeit für Fahrzeuge, die nie geprüft wurden.
 * HSN/TSN wiederum sind der Beleg für den Nachschlag, kein Datenblattfeld.
 *
 * Beides gehört deshalb nicht in die Merkmale, die das Modell schreiben darf.
 *
 * WICHTIG — die Sperre gilt NUR für den Chat-Schreibweg: dieselben Schlüssel
 * müssen weiterhin gespeichert, gelesen und an eBay gesendet werden können,
 * sonst löscht der nächste Speichervorgang jeden echten K-Typ im Bestand.
 */

const {
  isChatWriteBlockedAttributeKey,
  isBlockedAttributeKey,
  canonicalizeAttributesStrict,
} = require('../lib/attribute-policy');

describe('K-Typ und Schluesselnummern sind fuer das Modell gesperrt', () => {
  it('sperrt den K-Typ in allen Schreibweisen', () => {
    for (const key of ['K-Typ', 'ktyp', 'k typ', 'K_Typ', 'ktype', 'K-Type']) {
      expect(isChatWriteBlockedAttributeKey(key)).toBe(true);
    }
  });

  it('sperrt die Schluesselnummern-Belege', () => {
    for (const key of ['HSN', 'TSN', 'HSN/TSN', 'hsn tsn', 'KBA-Nummer', 'Schlüsselnummer']) {
      expect(isChatWriteBlockedAttributeKey(key)).toBe(true);
    }
  });

  it('laesst echte Fahrzeug-Merkmale durch', () => {
    for (const key of [
      'Fahrzeugmarke',
      'Baureihe',
      'Einbauposition',
      'Vergleichsnummer',
      'Herstellernummer',
      'Steckertyp',
      'Produkttyp',
    ]) {
      expect(isChatWriteBlockedAttributeKey(key)).toBe(false);
    }
  });
});

describe('Die Sperre bleibt auf den Chat begrenzt', () => {
  it('aendert die allgemeine Blockliste NICHT', () => {
    // Sonst wuerde llm-rulebook beim naechsten Speichern jeden echten
    // K-Typ aus dem Bestand entfernen.
    expect(isBlockedAttributeKey('K-Typ')).toBe(false);
  });

  it('haelt einen echten K-Typ beim Kanonisieren am Leben', () => {
    const res = canonicalizeAttributesStrict({ 'K-Typ': '7331|7332', Fahrzeugmarke: 'VW' });
    expect(res.attributes['K-Typ']).toBe('7331|7332');
  });
});

describe('Der V2-Bereiniger wirft geratene K-Typen weg', () => {
  const { sanitizeDatasheetChangeV2 } = require('../services/product-chat-v2')._testables;

  it('verwirft ein K-Typ-Merkmal aus der Modell-Antwort', () => {
    const { change } = sanitizeDatasheetChangeV2({
      summary: 'Fahrzeugdaten ergaenzt',
      attributes: [
        { key: 'K-Typ', value: '0588/BDM' },
        { key: 'Fahrzeugmarke', value: 'VW' },
      ],
    });

    expect(change.attributes).toEqual({ Fahrzeugmarke: 'VW' });
  });

  it('verwirft ein HSN/TSN-Merkmal aus der Modell-Antwort', () => {
    const { change } = sanitizeDatasheetChangeV2({
      summary: 'Schluesselnummern',
      attributes: [
        { key: 'HSN/TSN', value: '0588/BDM' },
        { key: 'Einbauposition', value: 'Vorne' },
      ],
    });

    expect(change.attributes).toEqual({ Einbauposition: 'Vorne' });
  });

  it('laesst die Karte ganz weg, wenn nur Gesperrtes drinsteht', () => {
    const { change } = sanitizeDatasheetChangeV2({
      summary: 'K-Typ',
      attributes: [{ key: 'K-Typ', value: '0588/BDM' }],
    });

    expect(change.attributes).toBeUndefined();
  });
});
