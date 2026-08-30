'use strict';

/**
 * Los-Kennzahlen: Einheiten erfasst / auf Bestand / verkauft und der Los-Wert.
 *
 * Betreiber-Vorgabe (30.08.2026): "die kalkulation fuer jedes los setzt
 * vorraus das die einheiten initial erfasst bzw eingelagert als berechnungs
 * grundlage dient".
 *
 * WARUM NICHT DER BESTAND: der heutige Bestand ist das, was vom Los uebrig
 * ist. Teilt man den Einkaufsbetrag durch ihn, steigt der Stueckpreis mit
 * jedem Verkauf, obwohl sich am Einkauf nichts geaendert hat — ein fast
 * leergekauftes Los bekaeme absurde Werte. Bezugsgroesse ist deshalb die
 * URSPRUENGLICH eingelagerte Menge.
 *
 * WARUM NICHT AUS DEN AUFTRAEGEN: die Collection 'orders' beginnt erst am
 * 09.07.2026 (Kontowechsel). Gemessen 30.08.2026: von 1.668 Auftraegen, zu
 * denen ein Pick gebucht ist, existieren nur 705 noch als Auftrag — 963
 * (58 %) wurden geloescht. Wer 'verkauft' aus 'orders' zaehlt, unterzaehlt
 * NL-0626 um rund 900 Einheiten, die Bezugsmenge wird zu klein und der
 * Stueckpreis entsprechend zu hoch (gemessen bei L-072643: 129,65 € statt
 * 17,47 €, Faktor 7,4). Einzige Quelle, die den ganzen Zeitraum abdeckt,
 * ist das Lager-Journal 'warehouseEvents'.
 *
 * DIE BILANZ, die jede Zeile erfuellen muss:
 *
 *   eingelagert + rueckfuehrungen + korrekturen
 *     - verkauft - sonstigeAbgaenge  ==  Bestand
 *
 * Gemessen 30.08.2026 ueber alle 7 Lose: sie geht bei 6 von 7 EXAKT auf
 * (Differenz 0). Nur NL-0626 bleibt mit -26 von 4.675 Einheiten (0,6 %)
 * offen — Rest der unten beschriebenen Ausreisser. Deshalb wird die
 * Differenz MITGELIEFERT und nicht versteckt: eine Zahl, die nicht aufgeht,
 * muss man sehen, sonst rechnet die Oberflaeche selbstbewusst falsch.
 *
 * Reine Funktionen ohne Firestore — vollstaendig unit-getestet
 * (backend/__tests__/lot-metrics.test.js).
 */

/**
 * Ausreisser-Schranke: Ereignisse mit |delta| ueber dieser Grenze zaehlen
 * NICHT mit und werden gemeldet.
 *
 * Nicht geschaetzt, sondern gemessen (30.08.2026, 2.324 stock_in-Ereignisse):
 * 2.319 liegen bei |delta| <= 300, der Median ist 1. Darueber liegen genau
 * fuenf, und alle fuenf sind derselbe Bedienfehler — eine Artikelnummer, die
 * ins Mengenfeld gescannt wurde:
 *
 *   delta 4.251.887.419.096   (13-stellig, = EAN)
 *   delta 4.251.369.370.174   (13-stellig, = EAN)
 *   delta 4.064.666.244.327   (13-stellig, = EAN)
 *   delta        35.958.988   (Ziffernteil der SKU-5135958988)
 *   delta               650   (Datenblatt-Eingabe, nie physisch da)
 *
 * Warum genau 500 und nicht hoeher: die 650 ist der Grenzfall. Nimmt man sie
 * mit (Schranke ab 1.000), waechst die offene Differenz bei NL-0626 von -26
 * auf +624 Einheiten — die Buchung hat also nie stattgefunden. Jede Schranke
 * zwischen 301 und 650 liefert dasselbe Ergebnis; 500 liegt in der Mitte.
 *
 * Die Schranke wirkt bewusst auf ALLE Ereignisarten. Die drei EAN-Buchungen
 * wurden spaeter mit ebenso absurden Abgaengen zurueckgenommen; filterte man
 * nur den Zugang, bliebe der Gegenbuchungs-Abgang stehen und riss die Bilanz
 * um Billionen auf.
 */
const AUSREISSER_GRENZE = 500;

/** Ereignis-Arten, die eine Menge ueber das Feld `delta` fuehren. */
const MENGEN_ARTEN = new Set(['stock_in', 'stock_out', 'adjust', 'order_decrement']);

/**
 * `meta.action`-Marker, die einen `stock_in` als Korrektur ausweisen statt als
 * Wareneingang. Beide aendern den Bestand, sind aber kein Einkauf:
 *   inventory-correction   — Inventur-Differenz (routes/warehouse.js)
 *   repair-double-decrement — Reparatur eines Doppel-Abgangs (Script)
 */
const KORREKTUR_AKTIONEN = new Set(['inventory-correction', 'repair-double-decrement']);

function zahl(wert) {
  const n = Number(wert);
  return Number.isFinite(n) ? n : 0;
}

function runde2(wert) {
  return Math.round((zahl(wert) + Number.EPSILON) * 100) / 100;
}

function leereBewegung() {
  return {
    eingelagert: 0,
    rueckfuehrungen: 0,
    korrekturen: 0,
    verkauft: 0,
    sonstigeAbgaenge: 0,
    ereignisse: 0,
    ausreisser: 0,
  };
}

/**
 * Ordnet EIN Lager-Ereignis genau einem Eimer zu.
 *
 * Rueckgabe { eimer, menge } oder null, wenn das Ereignis keine Menge fuehrt
 * (Layout-/Bin-Ereignisse wie bin_assign_product tragen ihre Zahl in
 * `quantity`/`removedQty`, NICHT in `delta` — sie duerfen hier nie mitlaufen,
 * sonst mischen sich Bestands-SETZUNGEN unter die Zugaenge).
 *
 * `ausreisser` signalisiert der Aggregation, dass die Menge verworfen wurde.
 */
function klassifiziereEreignis(ereignis) {
  const e = ereignis || {};
  const art = String(e.type || '');
  if (!MENGEN_ARTEN.has(art)) return null;

  // `delta` ist die EINZIGE verlaessliche Mengenquelle. order_decrement fuehrt
  // daneben ein `requestedQty` — das ist die ANGEFORDERTE Menge: laeuft der
  // Abgang bei Bestand 0 in den No-op, wird das Ereignis trotzdem geschrieben
  // und `requestedQty` zaehlte eine Einheit, die nie abging.
  const delta = zahl(e.delta);
  if (delta === 0) return null;

  if (Math.abs(delta) > AUSREISSER_GRENZE) return { eimer: null, menge: 0, ausreisser: true };

  const meta = e.meta || {};
  const aktion = String(meta.action || '');

  if (art === 'stock_in') {
    if (KORREKTUR_AKTIONEN.has(aktion)) return { eimer: 'korrekturen', menge: delta };
    // Rueckbuchungen tragen immer einen Auftrags-/Retouren-Bezug: Storno-Gutschrift,
    // Retouren-Restock und der Stow-back nach Fehl-Pick. Physisch kommt dabei
    // nichts NEUES herein — die Einheit war beim Einlagern schon gezaehlt.
    if (meta.orderId || meta.returnId) return { eimer: 'rueckfuehrungen', menge: delta };
    return { eimer: 'eingelagert', menge: delta };
  }

  if (art === 'stock_out') {
    if (KORREKTUR_AKTIONEN.has(aktion)) return { eimer: 'korrekturen', menge: delta };
    if (meta.flow === 'pick') return { eimer: 'verkauft', menge: Math.abs(delta) };
    return { eimer: 'sonstigeAbgaenge', menge: Math.abs(delta) };
  }

  if (art === 'order_decrement') {
    // Versand-Abgang ohne physischen Pick. Heute tragen diese Ereignisse kein
    // `delta` (dann greift der Null-Ausstieg oben) — der Fix dafuer liegt auf
    // einem noch offenen Branch. Sobald sie eines fuehren, zaehlt es hier mit.
    return { eimer: 'verkauft', menge: Math.abs(delta) };
  }

  // adjust: Ledger-Korrektur mit VORZEICHEN (f1x-opening-correction u. a.).
  return { eimer: 'korrekturen', menge: delta };
}

/**
 * Summiert alle Lager-Ereignisse je Los.
 *
 * @param {Iterable<object>} ereignisse  Roh-Dokumente aus warehouseEvents.
 * @param {(ereignis: object) => string|null} losFuerEreignis
 *        Aufloesung Ereignis -> Los-Code. Bewusst als Funktion uebergeben:
 *        die Zuordnung laeuft ueber das Produkt (productId bzw. SKU) und ist
 *        damit Sache des Aufrufers, nicht dieser reinen Rechnung.
 * @returns {{ proLos: Map<string, object>, ohneLos: number, ausreisser: number }}
 */
function aggregiereLosBewegungen(ereignisse, losFuerEreignis) {
  const proLos = new Map();
  let ohneLos = 0;
  let ausreisser = 0;

  for (const ereignis of ereignisse || []) {
    const treffer = klassifiziereEreignis(ereignis);
    if (!treffer) continue;

    const code = typeof losFuerEreignis === 'function' ? losFuerEreignis(ereignis) : null;
    if (!code) {
      // Ereignis eines geloeschten oder losfreien Produkts. Wird gezaehlt und
      // gemeldet — stillschweigend als 0 zu behandeln waere genau die Luege,
      // die diese Bilanz aufdecken soll.
      ohneLos += 1;
      continue;
    }

    const bewegung = proLos.get(code) || leereBewegung();
    bewegung.ereignisse += 1;
    if (treffer.ausreisser) {
      bewegung.ausreisser += 1;
      ausreisser += 1;
    } else {
      bewegung[treffer.eimer] += treffer.menge;
    }
    proLos.set(code, bewegung);
  }

  return { proLos, ohneLos, ausreisser };
}

/**
 * Rechnet die Kennzahlen EINES Loses aus.
 *
 * @param {{ ekBrutto?: number|null }} los
 * @param {object|null} bewegung   Ergebnis aus aggregiereLosBewegungen
 * @param {{ bestand: number, produkte?: number }} bestandsdaten
 *        `bestand` = Summe inventory.quantity der Produkte dieses Loses.
 */
function berechneLosKennzahlen(los, bewegung, bestandsdaten = {}) {
  const b = bewegung || leereBewegung();
  const bestand = Math.max(0, zahl(bestandsdaten.bestand));

  // Bezugsmenge: was ins Los eingekauft wurde, bereinigt um Ledger-Korrekturen.
  // Rueckfuehrungen zaehlen NICHT mit — die Einheit steckt schon in
  // `eingelagert`; sie noch einmal zu zaehlen wuerde den Stueckpreis druecken.
  const basis = b.eingelagert + b.korrekturen;

  // Netto-Verkauf: eine verkaufte und danach zurueckgenommene Einheit liegt
  // wieder im Bestand. Ohne die Verrechnung stuende sie in `bestand` UND in
  // `verkauft` und die Bilanz ginge um genau diese Menge daneben.
  const verkauftNetto = b.verkauft - b.rueckfuehrungen;

  const probe = basis - verkauftNetto - b.sonstigeAbgaenge;
  const differenz = probe - bestand;

  const ekBrutto = zahl(los && los.ekBrutto);
  const hatPreis = ekBrutto > 0 && basis > 0;

  // Werte als ANTEIL am Einkaufsbetrag statt Bestand x gerundeter Stueckpreis:
  // so summieren sich Rest- und Abgangswert exakt auf den EK und driften nicht
  // um die Rundung des Stueckpreises auseinander.
  const anteil = (menge) => (hatPreis ? runde2((ekBrutto * menge) / basis) : null);

  return {
    einheitenErfasst: basis,
    einheitenBestand: bestand,
    einheitenVerkauft: verkauftNetto,
    einheitenEingelagert: b.eingelagert,
    rueckfuehrungen: b.rueckfuehrungen,
    korrekturen: b.korrekturen,
    sonstigeAbgaenge: b.sonstigeAbgaenge,
    produkte: bestandsdaten.produkte === undefined ? null : zahl(bestandsdaten.produkte),

    ekJeEinheitBrutto: hatPreis ? runde2(ekBrutto / basis) : null,
    restwertBrutto: anteil(bestand),
    abgangswertBrutto: anteil(Math.max(0, verkauftNetto)),

    // Selbstauskunft ueber die Verlaesslichkeit dieser Zeile.
    differenz,
    stimmig: differenz === 0 && b.ausreisser === 0,
    ausreisser: b.ausreisser,
  };
}

module.exports = {
  AUSREISSER_GRENZE,
  KORREKTUR_AKTIONEN,
  klassifiziereEreignis,
  aggregiereLosBewegungen,
  berechneLosKennzahlen,
};
