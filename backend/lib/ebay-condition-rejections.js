'use strict';
/**
 * ebay-condition-rejections.js — gelernte Sperrliste: welchen Artikelzustand
 * lehnt eBay in welcher Kategorie ab, obwohl die Metadaten ihn anbieten?
 *
 * WARUM DAS NOETIG IST (gemessen 2026-08-10):
 *   eBays Metadaten-API `getItemConditionPolicies` fuehrt fuer Kategorie 185112
 *   (Mobile Klimageraete) den Zustand 2500 "Vom Verkaeufer generalueberholt".
 *   Die Angebots-API lehnt ihn dort ab — mit Fehler 21555 "Ungueltige
 *   Kategorie", der auf die KATEGORIE zeigt, obwohl der ZUSTAND das Problem
 *   ist. In den Kategorien 183994 und 78707 wird derselbe Zustand akzeptiert.
 *   Die Rohdaten der drei Kategorien sind Zeichen fuer Zeichen identisch — die
 *   Metadaten enthalten also KEIN Merkmal, an dem man das vorher erkennen
 *   koennte. Hintergrund ist das eBay-Generalueberholt-Programm: in Kategorien,
 *   die daran teilnehmen, wurde "Vom Verkaeufer generalueberholt" abgeschafft.
 *
 * Konsequenz: die einzige verlaessliche Quelle ist die Angebots-API selbst.
 * Deshalb wird jede bewiesene Ablehnung hier festgehalten und kuenftig aus der
 * Auswahl im Datenblatt entfernt.
 *
 * Nur ADDITIV: es werden ausschliesslich Ablehnungen gespeichert, die vorher
 * durch einen Gegentest belegt wurden. Nichts wird geraten.
 */

const OPS_COLLECTION = 'ops';
const DOC_ID = 'ebayConditionRejections';
const CACHE_TTL_MS = 5 * 60 * 1000;

/** eBay-Fehlercode "Ungueltige Kategorie" — wird auch bei Zustands-Konflikten geliefert. */
const MISLEADING_CATEGORY_ERROR_CODE = '21555';

let _cache = null;
let _cacheAt = 0;

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * Traegt einer der eBay-Fehler den Code 21555?
 * @param {Array} errors eBay-Fehlerliste ({code, shortMessage, longMessage})
 */
function isMisleadingCategoryError(errors) {
  const list = Array.isArray(errors) ? errors : [errors];
  return list.some((e) => safeString(e?.code || e?.errorCode) === MISLEADING_CATEGORY_ERROR_CODE);
}

function docRef() {
  // Lazy, damit das Modul ohne Firestore-Verbindung ladbar bleibt (Tests).
  const { firestore } = require('./firestore');
  return firestore.collection(OPS_COLLECTION).doc(DOC_ID);
}

/**
 * Alle bekannten Ablehnungen: { [categoryId]: { [conditionId]: {...} } }
 * Faellt bei jedem Fehler auf ein leeres Objekt zurueck — eine gestoerte
 * Sperrliste darf niemals die Auswahl blockieren.
 */
async function getRejections({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_TTL_MS) return _cache;
  try {
    const snap = await docRef().get();
    const data = snap.exists ? snap.data() || {} : {};
    _cache = data.byCategory && typeof data.byCategory === 'object' ? data.byCategory : {};
    _cacheAt = now;
  } catch (err) {
    console.warn(`[ebay-condition-rejections] Lesen fehlgeschlagen: ${err.message}`);
    _cache = _cache || {};
    _cacheAt = now;
  }
  return _cache;
}

/** Welche Zustaende sind in dieser Kategorie bekanntermassen abgelehnt? */
async function getRejectedConditionIds(categoryId) {
  const cat = safeString(categoryId);
  if (!cat) return [];
  const all = await getRejections();
  const entry = all[cat];
  return entry && typeof entry === 'object' ? Object.keys(entry) : [];
}

/**
 * Haelt eine BEWIESENE Ablehnung fest. Aufrufer muss vorher belegt haben, dass
 * dasselbe Angebot ohne diesen Zustand durchgeht.
 */
async function recordRejection({ categoryId, conditionId, errorCode = null, provenBy = null }) {
  const cat = safeString(categoryId);
  const cond = safeString(conditionId);
  if (!cat || !cond) return false;
  try {
    await docRef().set(
      {
        byCategory: {
          [cat]: {
            [cond]: {
              at: new Date().toISOString(),
              errorCode: errorCode || MISLEADING_CATEGORY_ERROR_CODE,
              provenBy: provenBy || 'verify-without-condition',
            },
          },
        },
      },
      { merge: true }
    );
    _cache = null; // beim naechsten Lesen frisch holen
    _cacheAt = 0;
    return true;
  } catch (err) {
    console.error(`[ebay-condition-rejections] Schreiben fehlgeschlagen: ${err.message}`);
    return false;
  }
}

/** Nur fuer Tests: Zwischenspeicher leeren. */
function _resetCache() {
  _cache = null;
  _cacheAt = 0;
}

module.exports = {
  MISLEADING_CATEGORY_ERROR_CODE,
  isMisleadingCategoryError,
  getRejections,
  getRejectedConditionIds,
  recordRejection,
  _resetCache,
};
