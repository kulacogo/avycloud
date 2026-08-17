'use strict';

/**
 * Der Chat recherchiert HSN/TSN — und wirft die Recherche weg.
 *
 * Vorfall 2026-08-17 (Airbag-Steuergeraet, SKU-7093518261): Der Bediener bat um
 * den K-Typ. Der Assistent recherchierte korrekt die Schluesselnummern
 * ("0588/BDM", "0588/BDQ", "0588/BNL") — und legte sie im frei erfundenen
 * Merkmal "Vergleichsnummer" ab. Das Pflichtfeld "K-Typ" blieb leer.
 *
 * Drei Ursachen greifen ineinander:
 *
 * 1. HSN/TSN sind KEIN K-Typ. Ein K-Typ ist eine ZAHLEN-Kennung aus eBays
 *    Fahrzeugliste (MVL). HSN/TSN ist der BELEG, aus dem die Anreicherung die
 *    K-Typen NACHSCHLAEGT — ausdruecklich ohne Raten.
 *
 * 2. Die Anreicherung startet PARALLEL zur Modell-Antwort (routes/identify.js
 *    startChatKTypEnrichment). Sie sieht die soeben recherchierten Nummern also
 *    grundsaetzlich nie — sie liest nur, was schon im Produkt stand.
 *
 * 3. Der Leser fuer eigene Produktdaten verlangt die WOERTER "HSN" und "TSN"
 *    um die Ziffern herum. Die uebliche Schreibweise "0588/BDM" faellt durch.
 *
 * Ergebnis: gute Recherche, falsches Feld, leeres Pflichtfeld.
 *
 * Diese Tests decken den neuen Weg ab: Beleg aus der Chat-Antwort ernten →
 * gegen die MVL nachschlagen → nur bei echtem Treffer den K-Typ setzen.
 */

const {
  extractHsnTsnFromEvidenceText,
  enrichKTypFromHsnTsnEvidence,
  collectHsnTsnFromChatResult,
} = require('../lib/ktype-enrichment');

/** Winziger MVL-Ersatz: nur die Form, die die Anreicherung wirklich liest. */
function fakeMvl(mapping) {
  const byHsnTsn = new Map();
  Object.entries(mapping).forEach(([pair, ids]) => byHsnTsn.set(pair, new Set(ids)));
  return { ok: true, byHsnTsn, jsonlPath: '/test/mvl.jsonl' };
}

function fitmentProduct(extra = {}) {
  return {
    id: 'p1',
    // 33596 = eBay "Airbags & Teile" (Fitment-Kategorie).
    details: { categoryId: '33596', attributes: {}, ...extra },
    identification: { name: 'Airbag Steuergeraet' },
  };
}

describe('HSN/TSN aus der Chat-Recherche ernten', () => {
  it('liest die uebliche Schraegstrich-Schreibweise', () => {
    const text = 'Passende Schluesselnummern (HSN/TSN): 0588/BDM, 0588/BDQ und 0588/BNL.';
    expect(extractHsnTsnFromEvidenceText(text).sort()).toEqual(['0588|BDM', '0588|BDQ', '0588|BNL']);
  });

  it('liest die ausgeschriebene Form', () => {
    const text = 'Laut KBA: HSN 0588, TSN BDM.';
    expect(extractHsnTsnFromEvidenceText(text)).toEqual(['0588|BDM']);
  });

  it('liest die Tabellenform mit Leerzeichen', () => {
    const text = 'Schluesselnummer 0588 BDM (VW Golf VI)';
    expect(extractHsnTsnFromEvidenceText(text)).toEqual(['0588|BDM']);
  });

  it('erntet NICHTS ohne Schluesselnummern-Kontext', () => {
    // Sonst wuerde jede Teilenummer im Format 1234/ABC als Fahrzeug gelten.
    expect(extractHsnTsnFromEvidenceText('Vergleichsnummer: 1234/ABC, OE 5678/XYZ')).toEqual([]);
  });

  it('vertraegt leere Eingaben', () => {
    expect(extractHsnTsnFromEvidenceText('')).toEqual([]);
    expect(extractHsnTsnFromEvidenceText(null)).toEqual([]);
  });
});

describe('Beleg gegen die MVL nachschlagen', () => {
  it('setzt den K-Typ NUR bei echtem MVL-Treffer', async () => {
    const product = fitmentProduct();
    const res = await enrichKTypFromHsnTsnEvidence(product, ['0588|BDM', '0588|BDQ'], {
      mvl: fakeMvl({ '0588|BDM': [7331, 7332], '0588|BDQ': [7332, 9001] }),
    });

    expect(res.ok).toBe(true);
    expect(product.details.attributes['K-Typ']).toBe('7331|7332|9001');
  });

  it('erfindet nichts, wenn die MVL den Beleg nicht kennt', async () => {
    const product = fitmentProduct();
    const res = await enrichKTypFromHsnTsnEvidence(product, ['0588|BDM'], { mvl: fakeMvl({}) });

    expect(res.ok).toBe(false);
    expect(product.details.attributes['K-Typ']).toBeUndefined();
  });

  it('ruehrt einen vorhandenen K-Typ nicht an', async () => {
    const product = fitmentProduct({ attributes: { 'K-Typ': '1234' } });
    const res = await enrichKTypFromHsnTsnEvidence(product, ['0588|BDM'], {
      mvl: fakeMvl({ '0588|BDM': [7331] }),
    });

    expect(res.ok).toBe(false);
    expect(product.details.attributes['K-Typ']).toBe('1234');
  });

  it('laeuft nur in Fahrzeug-Kategorien', async () => {
    const product = { id: 'p2', details: { categoryId: '11450', attributes: {} } }; // Bekleidung
    const res = await enrichKTypFromHsnTsnEvidence(product, ['0588|BDM'], {
      mvl: fakeMvl({ '0588|BDM': [7331] }),
    });

    expect(res.ok).toBe(false);
    expect(product.details.attributes['K-Typ']).toBeUndefined();
  });

  it('vertraegt einen leeren Beleg', async () => {
    const product = fitmentProduct();
    const res = await enrichKTypFromHsnTsnEvidence(product, [], { mvl: fakeMvl({}) });
    expect(res.ok).toBe(false);
  });
});

describe('Beleg aus der kompletten Chat-Antwort einsammeln', () => {
  it('liest die Antwort-Prosa', () => {
    const chatResult = {
      message: 'Fuer dieses Steuergeraet gelten die HSN/TSN 0588/BDM und 0588/BDQ.',
    };
    expect(collectHsnTsnFromChatResult(chatResult).sort()).toEqual(['0588|BDM', '0588|BDQ']);
  });

  it('liest auch das falsch befuellte Merkmal — genau der Vorfall', () => {
    // Das Modell legte die Schluesselnummern unter "Vergleichsnummer" ab.
    // Die Werte sind trotzdem korrekt; der Beleg darf nicht verloren gehen.
    const chatResult = {
      message: 'Ich habe die Schluesselnummern recherchiert.',
      datasheetChanges: [
        { attributes: { Vergleichsnummer: 'HSN/TSN 0588/BDM, 0588/BNL' } },
      ],
    };
    expect(collectHsnTsnFromChatResult(chatResult).sort()).toEqual(['0588|BDM', '0588|BNL']);
  });

  it('versteht auch die V3-Form (Merkmale als Liste)', () => {
    const chatResult = {
      datasheetChanges: [
        { attributes: [{ key: 'KBA-Nummer', value: '0588/BDM' }] },
      ],
    };
    expect(collectHsnTsnFromChatResult(chatResult)).toEqual(['0588|BDM']);
  });

  it('liefert nichts, wenn nichts da ist', () => {
    expect(collectHsnTsnFromChatResult(null)).toEqual([]);
    expect(collectHsnTsnFromChatResult({ message: 'Keine Angaben gefunden.' })).toEqual([]);
  });
});
