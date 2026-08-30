'use strict';

/**
 * Laedt die Rohdaten fuer die Los-Kennzahlen und haelt sie kurz im Speicher.
 *
 * Zwei Voll-Scans (Groessenordnung 30.08.2026: 2.004 Produkte, 5.155
 * Lager-Ereignisse). Das ist bewusst EIN Scan fuer ALLE Lose statt einer
 * Abfrage je Los: `listLots({ withCounts })` macht heute schon eine
 * count()-Aggregation pro Los in 20er-Bloecken, und bei bis zu 200 Losen je
 * Monat waere ein zweiter Fan-out dieser Groesse nicht vertretbar.
 *
 * Bei Stoerungen bleibt der letzte bekannte gute Stand stehen (Muster aus
 * lib/catalog-index.js). Ein leeres Ergebnis waere hier schaedlicher als ein
 * leicht veralteter Stand: die Oberflaeche zeigte dann ueberall 0 Einheiten
 * und einen Los-Wert von 0 €, ohne dass etwas nach einem Fehler aussieht.
 *
 * KEIN tenantId-Filter, in beiden Scans, mit Absicht:
 *   - warehouseEvents traegt gar kein tenantId auf oberster Ebene (nur die
 *     'adjust'-Ereignisse tun es) — die Collection ist nicht tenant-filterbar.
 *   - products_v2 wird aus demselben Grund wie in `countProductsForLot`
 *     ungefiltert gelesen: Altbestaende tragen das Feld nicht garantiert, ein
 *     Filter wuerde sie still unterschlagen.
 * Unter der Single-Tenant-Realitaet (alle Produktivdaten tenantId='default')
 * ist das folgenlos; die Los-Codes selbst sind je Tenant getrennt.
 */

const { FieldPath } = require('@google-cloud/firestore');
const { aggregiereLosBewegungen, berechneLosKennzahlen } = require('./lot-metrics');

const DEFAULT_TTL_MS = Number(process.env.LOT_METRICS_TTL_MS || 5 * 60 * 1000);
const SEITEN_GROESSE = 1000;

/**
 * Liest eine Collection vollstaendig, seitenweise nach Dokument-ID.
 *
 * Nach der Dokument-ID und NICHT nach `createdAt`: die Ereignisse tragen
 * gemischte Typen in diesem Feld — `writeWarehouseEventTx` schreibt einen
 * Firestore-Timestamp, `lib/stock-ledger-correction.js` eine ISO-Zeichenkette.
 * Firestore sortiert Timestamp vor String, ein Seitenwechsel ueber `createdAt`
 * wuerde die String-Ereignisse in einen eigenen Block schieben und beim
 * Blaettern lautlos ueberspringen.
 */
async function leseAlles(query, { seitenGroesse = SEITEN_GROESSE } = {}) {
  const treffer = [];
  let letzte = null;
  for (;;) {
    let seite = query.orderBy(FieldPath.documentId()).limit(seitenGroesse);
    if (letzte) seite = seite.startAfter(letzte);
    // eslint-disable-next-line no-await-in-loop
    const snap = await seite.get();
    if (snap.empty) break;
    snap.docs.forEach((doc) => treffer.push({ id: doc.id, daten: doc.data() || {} }));
    if (snap.size < seitenGroesse) break;
    letzte = snap.docs[snap.docs.length - 1].id;
  }
  return treffer;
}

function text(wert) {
  return String(wert == null ? '' : wert).trim();
}

/**
 * Baut die Zuordnung Ereignis -> Los und die Bestandssummen je Los.
 *
 * Der Los-Bezug kommt aus `ops.sourceLot` des PRODUKTS, nicht aus
 * `meta.lotCode` des Ereignisses. Gruende, beide gemessen:
 *   - `meta.lotCode` gibt es erst seit dem 31.07.2026; fuer den gesamten
 *     Bestandsaufbau davor steht im Ereignis kein Los (395 von 2.324
 *     stock_in-Ereignissen tragen ihn ueberhaupt).
 *   - Der Datenblatt-Pfad sendet ihn nie, und beide Einlager-Ansichten senden
 *     nur einen Client-Schnappschuss — fehlt das Produkt in der geladenen
 *     Liste, fehlt der Code still.
 * Damit ist das Produkt die einzige durchgaengige Quelle. Die Kehrseite steht
 * im Ergebnis: `assign-initial-lot.js` hat am 31.07.2026 alle damals
 * existierenden Produkte pauschal auf NL-0626 gesetzt, dieses Los ist also ein
 * Sammeltopf und kein einzelner Einkauf.
 */
function baueProduktIndex(produkte) {
  const losVonDocId = new Map();
  const losVonIdFeld = new Map();
  const losVonSku = new Map();
  const bestand = new Map();
  const anzahl = new Map();

  for (const { id, daten } of produkte) {
    const code = text(daten?.ops?.sourceLot);
    if (!code) continue;

    losVonDocId.set(id, code);
    // `event.productId` ist `productData.id || productRef.id` — das im Dokument
    // GESPEICHERTE id-Feld gewinnt gegen die Dokument-ID. Beide Wege muessen
    // deshalb im Index stehen, sonst laeuft der Join ins Leere.
    const idFeld = text(daten?.id);
    if (idFeld) losVonIdFeld.set(idFeld, code);

    const sku = text(daten?.identification?.sku) || text(daten?.details?.identifiers?.sku);
    if (sku) losVonSku.set(sku, code);

    const menge = Number(daten?.inventory?.quantity);
    bestand.set(code, (bestand.get(code) || 0) + (Number.isFinite(menge) ? menge : 0));
    anzahl.set(code, (anzahl.get(code) || 0) + 1);
  }

  const losFuerEreignis = (ereignis) => {
    const pid = text(ereignis?.productId);
    return (
      losVonDocId.get(pid) ||
      losVonIdFeld.get(pid) ||
      losVonSku.get(text(ereignis?.sku)) ||
      null
    );
  };

  return { losFuerEreignis, bestand, anzahl };
}

/**
 * Rechnet die Kennzahlen aus bereits geladenen Rohdaten.
 * Rein und ohne Firestore — der testbare Kern des Ladepfads.
 */
function baueKennzahlen({ lose = [], produkte = [], ereignisse = [] } = {}) {
  const { losFuerEreignis, bestand, anzahl } = baueProduktIndex(produkte);
  const { proLos, ohneLos, ausreisser } = aggregiereLosBewegungen(ereignisse, losFuerEreignis);

  const proCode = new Map();
  for (const los of lose) {
    const code = text(los?.code);
    if (!code) continue;
    proCode.set(
      code,
      berechneLosKennzahlen(los, proLos.get(code), {
        bestand: bestand.get(code) || 0,
        produkte: anzahl.get(code) || 0,
      })
    );
  }

  return {
    proLos: proCode,
    ereignisseOhneLos: ohneLos,
    ausreisser,
    produkteGelesen: produkte.length,
    ereignisseGelesen: ereignisse.length,
  };
}

/**
 * Produktionslader. Getrennt vom Rechenkern, damit Tests ohne Firestore laufen.
 */
async function ladeRohdaten(firestore, produktCollection) {
  const [produkte, ereignisse] = await Promise.all([
    leseAlles(
      firestore
        .collection(produktCollection)
        .select('id', 'ops.sourceLot', 'inventory.quantity', 'identification.sku', 'details.identifiers.sku')
    ),
    leseAlles(firestore.collection('warehouseEvents').select('type', 'delta', 'productId', 'sku', 'meta')),
  ]);
  return {
    produkte,
    ereignisse: ereignisse.map((e) => e.daten),
  };
}

/**
 * Erzeugt den zwischengespeicherten Kennzahlen-Dienst.
 * `laden` liefert { produkte, ereignisse } — in Tests ein Stub.
 */
function createLotMetricsStore({ laden, ttlMs = DEFAULT_TTL_MS, jetzt = Date.now } = {}) {
  let stand = null;
  let geladenAm = 0;
  let laufend = null;

  async function frisch() {
    const roh = await laden();
    stand = roh;
    geladenAm = jetzt();
    return stand;
  }

  async function rohdaten() {
    if (stand && jetzt() - geladenAm < ttlMs) return stand;
    if (laufend) return laufend;

    laufend = frisch()
      .catch((err) => {
        console.warn('[lot-metrics] Nachladen fehlgeschlagen:', err?.message || err);
        // Letzten guten Stand behalten. Beim allerersten Fehler gibt es keinen —
        // dann wirft der Aufrufer lieber, als 0 Einheiten zu behaupten.
        if (stand) {
          geladenAm = jetzt();
          return stand;
        }
        throw err;
      })
      .finally(() => {
        laufend = null;
      });

    return laufend;
  }

  return {
    async kennzahlen(lose) {
      const roh = await rohdaten();
      return baueKennzahlen({ lose, produkte: roh.produkte, ereignisse: roh.ereignisse });
    },
    invalidieren() {
      geladenAm = 0;
    },
  };
}

let standardStore = null;

/** Prozessweiter Store gegen die echte Datenbank. */
function getLotMetricsStore() {
  if (!standardStore) {
    const { firestore, PRODUCTS_COLLECTION } = require('./firestore');
    standardStore = createLotMetricsStore({
      laden: () => ladeRohdaten(firestore, PRODUCTS_COLLECTION),
    });
  }
  return standardStore;
}

module.exports = {
  DEFAULT_TTL_MS,
  leseAlles,
  baueProduktIndex,
  baueKennzahlen,
  ladeRohdaten,
  createLotMetricsStore,
  getLotMetricsStore,
};
