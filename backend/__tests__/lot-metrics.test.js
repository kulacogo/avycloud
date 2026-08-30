'use strict';

/**
 * Los-Kennzahlen: Einheiten erfasst / Bestand / verkauft und Los-Wert.
 *
 * Die Zahlen in den Tests sind am 30.08.2026 gegen die Produktionsdatenbank
 * gemessen (read-only), nicht ausgedacht. Bei 6 von 7 Losen geht die Bilanz
 *
 *   erfasst - verkauft - sonstige Abgaenge == Bestand
 *
 * exakt auf. Wer diese Tests reissen sieht, hat entweder die Klassifikation
 * der Lager-Ereignisse veraendert oder die Bezugsmenge — beides aendert
 * unmittelbar den ausgewiesenen Einkaufspreis je Einheit.
 */

const {
  AUSREISSER_GRENZE,
  klassifiziereEreignis,
  aggregiereLosBewegungen,
  berechneLosKennzahlen,
} = require('../lib/lot-metrics');

const {
  baueKennzahlen,
  baueProduktIndex,
  createLotMetricsStore,
  leseAlles,
} = require('../lib/lot-metrics-store');

const ein = (delta, meta) => ({ type: 'stock_in', delta, meta: meta || {} });
const aus = (delta, meta) => ({ type: 'stock_out', delta, meta: meta || {} });

describe('klassifiziereEreignis', () => {
  it('zaehlt eine normale Einlagerung als Wareneingang', () => {
    expect(klassifiziereEreignis(ein(3, { flow: 'stow' }))).toEqual({ eimer: 'eingelagert', menge: 3 });
  });

  it('zaehlt den Datenblatt-Zugang ebenfalls als Wareneingang', () => {
    // Der ProductSheet-Pfad sendet weder lotCode noch requestId, ist aber ein
    // echter Bestandszugang.
    expect(klassifiziereEreignis(ein(2, { flow: 'product-sheet' }))).toEqual({
      eimer: 'eingelagert',
      menge: 2,
    });
  });

  it('zaehlt einen Pick als Verkauf', () => {
    expect(klassifiziereEreignis(aus(-1, { flow: 'pick', orderId: 'ebay__1' }))).toEqual({
      eimer: 'verkauft',
      menge: 1,
    });
  });

  it('zaehlt einen Abgang ohne Pick-Kennzeichen als sonstigen Abgang', () => {
    expect(klassifiziereEreignis(aus(-2, { flow: 'scrap' }))).toEqual({
      eimer: 'sonstigeAbgaenge',
      menge: 2,
    });
  });

  it('trennt Rueckbuchungen vom Wareneingang', () => {
    // Storno-Gutschrift, Retouren-Restock und Stow-back nach Fehl-Pick: die
    // Einheit war beim Einlagern schon gezaehlt, sie darf die Bezugsmenge nicht
    // ein zweites Mal vergroessern.
    expect(klassifiziereEreignis(ein(1, { orderId: 'ebay__7' })).eimer).toBe('rueckfuehrungen');
    expect(klassifiziereEreignis(ein(1, { returnId: 'r-1' })).eimer).toBe('rueckfuehrungen');
  });

  it('behandelt Inventur- und Reparatur-Zugaenge als Korrektur, nicht als Einkauf', () => {
    expect(klassifiziereEreignis(ein(4, { action: 'inventory-correction' }))).toEqual({
      eimer: 'korrekturen',
      menge: 4,
    });
    expect(klassifiziereEreignis(ein(1, { action: 'repair-double-decrement' }))).toEqual({
      eimer: 'korrekturen',
      menge: 1,
    });
  });

  it('uebernimmt das Vorzeichen einer Ledger-Korrektur', () => {
    const e = { type: 'adjust', delta: -5, meta: { kind: 'f1x-opening-correction' } };
    expect(klassifiziereEreignis(e)).toEqual({ eimer: 'korrekturen', menge: -5 });
  });

  it('verwirft Ereignisse ohne Mengenfeld delta', () => {
    // bin_assign_product fuehrt seine Zahl in `quantity`, bin_remove_product in
    // `removedQty`. Wer die mitzaehlt, mischt Bestands-SETZUNGEN unter die
    // Zugaenge.
    expect(klassifiziereEreignis({ type: 'bin_assign_product', quantity: 12 })).toBeNull();
    expect(klassifiziereEreignis({ type: 'bin_remove_product', removedQty: 4 })).toBeNull();
    expect(klassifiziereEreignis({ type: 'layout_delete' })).toBeNull();
  });

  it('nutzt bei order_decrement NIEMALS requestedQty', () => {
    // requestedQty ist die ANGEFORDERTE Menge: laeuft der Abgang bei Bestand 0
    // in den No-op, wird das Ereignis trotzdem geschrieben. Heute tragen diese
    // Ereignisse gar kein delta — dann darf gar nichts gezaehlt werden.
    expect(klassifiziereEreignis({ type: 'order_decrement', requestedQty: 3 })).toBeNull();
    // Sobald sie eines fuehren (offener Branch), zaehlt es als Verkauf mit.
    expect(klassifiziereEreignis({ type: 'order_decrement', delta: -2, requestedQty: 9 })).toEqual({
      eimer: 'verkauft',
      menge: 2,
    });
  });

  it('verwirft Ausreisser in BEIDE Richtungen', () => {
    // Gemessen: drei Zugaenge mit 13-stelligen Deltas (EAN ins Mengenfeld
    // gescannt) wurden spaeter mit ebenso absurden Abgaengen zurueckgenommen.
    // Filterte man nur den Zugang, bliebe die Gegenbuchung stehen und riss die
    // Bilanz um Billionen auf.
    expect(klassifiziereEreignis(ein(4251887419096, { flow: 'stow' }))).toEqual({
      eimer: null,
      menge: 0,
      ausreisser: true,
    });
    expect(klassifiziereEreignis(aus(-4251887419096, { flow: 'pick' })).ausreisser).toBe(true);
  });

  it('laesst die groesste gemessene echte Einlagerung passieren', () => {
    // 300 Stueck sind belegt; die Schranke darf sie nicht schlucken.
    expect(klassifiziereEreignis(ein(300, { flow: 'stow' }))).toEqual({ eimer: 'eingelagert', menge: 300 });
    expect(AUSREISSER_GRENZE).toBe(500);
  });
});

describe('aggregiereLosBewegungen', () => {
  it('summiert je Los und meldet Ereignisse ohne Los-Bezug', () => {
    const ereignisse = [
      { ...ein(5, { flow: 'stow' }), sku: 'A' },
      { ...aus(-2, { flow: 'pick' }), sku: 'A' },
      { ...ein(3, { flow: 'stow' }), sku: 'B' },
      { ...aus(-1, { flow: 'pick' }), sku: 'GELOESCHT' },
    ];
    const zuordnung = (e) => ({ A: 'L-072612', B: 'L-072620' })[e.sku] || null;

    const { proLos, ohneLos } = aggregiereLosBewegungen(ereignisse, zuordnung);

    expect(proLos.get('L-072612')).toMatchObject({ eingelagert: 5, verkauft: 2 });
    expect(proLos.get('L-072620')).toMatchObject({ eingelagert: 3, verkauft: 0 });
    // 219 verwaiste Pick-Ereignisse zeigen in Produktion auf geloeschte
    // Produkte. Sie werden gezaehlt, nicht stillschweigend als 0 verbucht.
    expect(ohneLos).toBe(1);
  });

  it('zaehlt Ausreisser je Los, ohne die Menge zu uebernehmen', () => {
    const ereignisse = [{ ...ein(650, {}), sku: 'A' }, { ...ein(2, { flow: 'stow' }), sku: 'A' }];
    const { proLos, ausreisser } = aggregiereLosBewegungen(ereignisse, () => 'NL-0626');
    expect(proLos.get('NL-0626').eingelagert).toBe(2);
    expect(proLos.get('NL-0626').ausreisser).toBe(1);
    expect(ausreisser).toBe(1);
  });
});

describe('berechneLosKennzahlen', () => {
  it('rechnet L-072643 wie in Produktion gemessen', () => {
    // Gemessen 30.08.2026: 141 erfasst, 119 auf Bestand, 20 verkauft,
    // 2 sonstige Abgaenge, EK 2.463,30 € brutto.
    const kennzahlen = berechneLosKennzahlen(
      { ekBrutto: 2463.3 },
      { eingelagert: 141, rueckfuehrungen: 0, korrekturen: 0, verkauft: 20, sonstigeAbgaenge: 2, ausreisser: 0 },
      { bestand: 119, produkte: 64 }
    );

    expect(kennzahlen.einheitenErfasst).toBe(141);
    expect(kennzahlen.einheitenBestand).toBe(119);
    expect(kennzahlen.einheitenVerkauft).toBe(20);
    expect(kennzahlen.ekJeEinheitBrutto).toBe(17.47);
    expect(kennzahlen.stimmig).toBe(true);
    expect(kennzahlen.differenz).toBe(0);
  });

  it('teilt NICHT durch den Restbestand', () => {
    // Der Kern der Betreiber-Vorgabe. Ein fast leergekauftes Los: 100 erfasst,
    // 95 verkauft, 5 uebrig, 1.000 € Einkauf.
    // Richtig sind 10,00 € je Einheit — durch den Restbestand geteilt waeren es
    // 200,00 €, und jeder weitere Verkauf triebe den Wert noch hoeher.
    const kennzahlen = berechneLosKennzahlen(
      { ekBrutto: 1000 },
      { eingelagert: 100, rueckfuehrungen: 0, korrekturen: 0, verkauft: 95, sonstigeAbgaenge: 0, ausreisser: 0 },
      { bestand: 5 }
    );
    expect(kennzahlen.ekJeEinheitBrutto).toBe(10);
  });

  it('verrechnet Rueckfuehrungen gegen den Verkauf', () => {
    // Verkauft und zurueckgenommen: die Einheit liegt wieder im Bestand. Ohne
    // Verrechnung stuende sie in bestand UND in verkauft.
    const kennzahlen = berechneLosKennzahlen(
      { ekBrutto: 100 },
      { eingelagert: 10, rueckfuehrungen: 1, korrekturen: 0, verkauft: 3, sonstigeAbgaenge: 0, ausreisser: 0 },
      { bestand: 8 }
    );
    expect(kennzahlen.einheitenVerkauft).toBe(2);
    expect(kennzahlen.einheitenErfasst).toBe(10);
    expect(kennzahlen.stimmig).toBe(true);
  });

  it('zieht Ledger-Korrekturen von der Bezugsmenge ab', () => {
    // NL-0626 traegt netto -384 Einheiten aus der Eroeffnungs-Korrektur: Ware,
    // die nie da war, darf den Einkauf nicht auf mehr Einheiten verteilen.
    const kennzahlen = berechneLosKennzahlen(
      { ekBrutto: 1000 },
      { eingelagert: 100, rueckfuehrungen: 0, korrekturen: -20, verkauft: 30, sonstigeAbgaenge: 0, ausreisser: 0 },
      { bestand: 50 }
    );
    expect(kennzahlen.einheitenErfasst).toBe(80);
    expect(kennzahlen.ekJeEinheitBrutto).toBe(12.5);
    expect(kennzahlen.stimmig).toBe(true);
  });

  it('weist eine Bilanz aus, die nicht aufgeht, statt sie zu verstecken', () => {
    const kennzahlen = berechneLosKennzahlen(
      { ekBrutto: 100 },
      { eingelagert: 100, rueckfuehrungen: 0, korrekturen: 0, verkauft: 10, sonstigeAbgaenge: 0, ausreisser: 0 },
      { bestand: 64 }
    );
    expect(kennzahlen.differenz).toBe(26);
    expect(kennzahlen.stimmig).toBe(false);
  });

  it('gilt als unstimmig, sobald ein Ausreisser verworfen wurde', () => {
    const kennzahlen = berechneLosKennzahlen(
      { ekBrutto: 100 },
      { eingelagert: 10, rueckfuehrungen: 0, korrekturen: 0, verkauft: 0, sonstigeAbgaenge: 0, ausreisser: 1 },
      { bestand: 10 }
    );
    expect(kennzahlen.differenz).toBe(0);
    expect(kennzahlen.stimmig).toBe(false);
  });

  it('liefert ohne Einkaufsbetrag Mengen, aber keinen erfundenen Wert', () => {
    // NL-0826 ist genau dieser Fall: 31 Produkte, 146 Einheiten, ekBrutto null.
    const kennzahlen = berechneLosKennzahlen(
      { ekBrutto: null },
      { eingelagert: 146, rueckfuehrungen: 0, korrekturen: 0, verkauft: 0, sonstigeAbgaenge: 0, ausreisser: 0 },
      { bestand: 146 }
    );
    expect(kennzahlen.einheitenErfasst).toBe(146);
    expect(kennzahlen.ekJeEinheitBrutto).toBeNull();
    expect(kennzahlen.restwertBrutto).toBeNull();
  });

  it('erzeugt bei Bezugsmenge 0 kein Infinity und kein NaN', () => {
    const kennzahlen = berechneLosKennzahlen({ ekBrutto: 500 }, null, { bestand: 0 });
    expect(kennzahlen.einheitenErfasst).toBe(0);
    expect(kennzahlen.ekJeEinheitBrutto).toBeNull();
    expect(kennzahlen.restwertBrutto).toBeNull();
    expect(kennzahlen.abgangswertBrutto).toBeNull();
  });

  it('verteilt den Einkaufsbetrag ohne Rundungsdrift auf Rest und Abgang', () => {
    // 3 Einheiten zu 10 € liessen sich als 3,33 € je Stueck nicht sauber
    // aufteilen; die Werte kommen deshalb als ANTEIL am Einkaufsbetrag.
    const kennzahlen = berechneLosKennzahlen(
      { ekBrutto: 10 },
      { eingelagert: 3, rueckfuehrungen: 0, korrekturen: 0, verkauft: 1, sonstigeAbgaenge: 0, ausreisser: 0 },
      { bestand: 2 }
    );
    expect(kennzahlen.ekJeEinheitBrutto).toBe(3.33);
    expect(kennzahlen.restwertBrutto).toBe(6.67);
    expect(kennzahlen.abgangswertBrutto).toBe(3.33);
    expect(kennzahlen.restwertBrutto + kennzahlen.abgangswertBrutto).toBe(10);
  });
});

describe('baueProduktIndex', () => {
  it('findet das Los ueber Dokument-ID, id-Feld und SKU', () => {
    // `event.productId` ist `productData.id || productRef.id` — das gespeicherte
    // id-Feld gewinnt gegen die Dokument-ID. Beide Wege muessen treffen.
    const { losFuerEreignis, bestand, anzahl } = baueProduktIndex([
      {
        id: 'doc-1',
        daten: { id: 'eigene-id-1', ops: { sourceLot: 'L-072612' }, inventory: { quantity: 4 }, identification: { sku: 'SKU-1' } },
      },
      { id: 'doc-2', daten: { ops: { sourceLot: 'L-072612' }, inventory: { quantity: 6 } } },
      { id: 'doc-3', daten: { inventory: { quantity: 99 } } },
    ]);

    expect(losFuerEreignis({ productId: 'doc-1' })).toBe('L-072612');
    expect(losFuerEreignis({ productId: 'eigene-id-1' })).toBe('L-072612');
    expect(losFuerEreignis({ sku: 'SKU-1' })).toBe('L-072612');
    expect(losFuerEreignis({ productId: 'doc-3' })).toBeNull();
    expect(bestand.get('L-072612')).toBe(10);
    expect(anzahl.get('L-072612')).toBe(2);
    // Ein Produkt ohne Los darf keinen Bestand beisteuern.
    expect(bestand.get(undefined)).toBeUndefined();
  });
});

describe('baueKennzahlen', () => {
  it('rechnet Lose, Produkte und Ereignisse zu einer stimmigen Zeile zusammen', () => {
    const ergebnis = baueKennzahlen({
      lose: [{ code: 'L-072693', ekBrutto: 2326.45 }],
      produkte: [{ id: 'p1', daten: { ops: { sourceLot: 'L-072693' }, inventory: { quantity: 72 }, identification: { sku: 'S1' } } }],
      ereignisse: [
        { type: 'stock_in', delta: 111, productId: 'p1', meta: { flow: 'stow' } },
        { type: 'stock_out', delta: -37, productId: 'p1', meta: { flow: 'pick' } },
        { type: 'stock_out', delta: -2, productId: 'p1', meta: {} },
      ],
    });

    const k = ergebnis.proLos.get('L-072693');
    // Gemessene Produktionswerte fuer L-072693.
    expect(k.einheitenErfasst).toBe(111);
    expect(k.einheitenBestand).toBe(72);
    expect(k.einheitenVerkauft).toBe(37);
    expect(k.ekJeEinheitBrutto).toBe(20.96);
    expect(k.stimmig).toBe(true);
    expect(ergebnis.ereignisseOhneLos).toBe(0);
  });

  it('liefert fuer ein Los ohne jede Bewegung Nullwerte statt undefined', () => {
    const ergebnis = baueKennzahlen({ lose: [{ code: 'NL-0926', ekBrutto: 100 }], produkte: [], ereignisse: [] });
    const k = ergebnis.proLos.get('NL-0926');
    expect(k.einheitenErfasst).toBe(0);
    expect(k.einheitenBestand).toBe(0);
    expect(k.einheitenVerkauft).toBe(0);
    expect(k.ekJeEinheitBrutto).toBeNull();
  });
});

describe('leseAlles', () => {
  /**
   * Minimaler Query-Doppelgaenger. Jede Methode gibt eine neue, vollstaendige
   * Query zurueck — `startAfter` wird im Code NACH `limit` aufgerufen und muss
   * die Seitengroesse behalten.
   */
  function fakeQuery(alleIds, protokoll = []) {
    const machen = (start, n) => ({
      orderBy: () => machen(start, n),
      limit: (x) => machen(start, x),
      startAfter: (letzte) => machen(letzte, n),
      get: async () => {
        protokoll.push({ start, n });
        const ab = start ? alleIds.indexOf(start) + 1 : 0;
        const teil = alleIds.slice(ab, ab + n);
        return {
          empty: teil.length === 0,
          size: teil.length,
          docs: teil.map((id) => ({ id, data: () => ({ id }) })),
        };
      },
    });
    return machen(null, null);
  }

  it('blaettert ueber alle Seiten hinweg vollstaendig', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `d${i}`);
    const treffer = await leseAlles(fakeQuery(ids), { seitenGroesse: 3 });
    expect(treffer.map((t) => t.id)).toEqual(ids);
  });

  it('hoert auf, sobald eine Seite nicht mehr voll ist', async () => {
    const protokoll = [];
    await leseAlles(fakeQuery(['a', 'b'], protokoll), { seitenGroesse: 3 });
    // Eine einzige Abfrage — keine ueberfluessige Leerrunde hinterher.
    expect(protokoll.length).toBe(1);
  });
});

describe('createLotMetricsStore', () => {
  const lose = [{ code: 'L-072612', ekBrutto: 100 }];
  const rohdaten = (menge) => ({
    produkte: [{ id: 'p1', daten: { ops: { sourceLot: 'L-072612' }, inventory: { quantity: menge } } }],
    ereignisse: [{ type: 'stock_in', delta: menge, productId: 'p1', meta: { flow: 'stow' } }],
  });

  it('liest innerhalb der Haltezeit nur einmal', async () => {
    let aufrufe = 0;
    let uhr = 1000;
    const store = createLotMetricsStore({
      laden: async () => { aufrufe += 1; return rohdaten(10); },
      ttlMs: 5000,
      jetzt: () => uhr,
    });

    await store.kennzahlen(lose);
    await store.kennzahlen(lose);
    expect(aufrufe).toBe(1);

    uhr += 6000;
    await store.kennzahlen(lose);
    expect(aufrufe).toBe(2);
  });

  it('buendelt gleichzeitige Anfragen zu EINEM Ladevorgang', async () => {
    let aufrufe = 0;
    const store = createLotMetricsStore({
      laden: async () => { aufrufe += 1; return rohdaten(10); },
    });
    await Promise.all([store.kennzahlen(lose), store.kennzahlen(lose), store.kennzahlen(lose)]);
    expect(aufrufe).toBe(1);
  });

  it('behaelt bei einer Stoerung den letzten guten Stand', async () => {
    let uhr = 1000;
    let kaputt = false;
    const store = createLotMetricsStore({
      laden: async () => {
        if (kaputt) throw new Error('DEADLINE_EXCEEDED (simuliert)');
        return rohdaten(10);
      },
      ttlMs: 1000,
      jetzt: () => uhr,
    });

    const erst = await store.kennzahlen(lose);
    expect(erst.proLos.get('L-072612').einheitenErfasst).toBe(10);

    kaputt = true;
    uhr += 2000;
    const danach = await store.kennzahlen(lose);
    // Lieber ein paar Minuten alt als ueberall 0 Einheiten und 0 € — das saehe
    // aus wie ein leeres Lager statt wie eine Stoerung.
    expect(danach.proLos.get('L-072612').einheitenErfasst).toBe(10);
  });

  it('wirft beim allerersten Fehler, statt 0 Einheiten zu behaupten', async () => {
    const store = createLotMetricsStore({
      laden: async () => { throw new Error('keine Verbindung'); },
    });
    // Die Route faengt das und meldet metricsError — die Oberflaeche sagt dann
    // "nicht verfuegbar" statt stumm leere Spalten zu zeigen.
    await expect(store.kennzahlen(lose)).rejects.toThrow('keine Verbindung');
  });

  it('laedt nach invalidieren() neu', async () => {
    let aufrufe = 0;
    const store = createLotMetricsStore({
      laden: async () => { aufrufe += 1; return rohdaten(10); },
      ttlMs: 60000,
    });
    await store.kennzahlen(lose);
    store.invalidieren();
    await store.kennzahlen(lose);
    expect(aufrufe).toBe(2);
  });
});
