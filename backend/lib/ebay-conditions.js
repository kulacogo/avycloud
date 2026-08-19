'use strict';
/**
 * ebay-conditions.js — welche Artikelzustaende erlaubt eBay in welcher Kategorie?
 *
 * Der Artikelzustand ist bei eBay ein EIGENES Feld auf Item-Ebene
 * (<ConditionID>), unabhaengig von den Artikelmerkmalen (<ItemSpecifics>).
 *
 * Zwei Eigenheiten, die diese Datei noetig machen:
 *
 *   1. Die erlaubten Zustaende haengen an der Kategorie. Keine Kategorie
 *      erlaubt alle. In 72 % der Kategorien ist der Zustand Pflicht, in 1.889
 *      Kategorien gibt es gar keinen — dort darf ConditionID nicht gesendet
 *      werden.
 *   2. Auch der ANZEIGENAME haengt an der Kategorie. ConditionID 1000 heisst
 *      meistens "Neu", in 968 Bekleidungs-Kategorien "Neu mit Etikett", in 80
 *      "Neu mit Karton". Eine feste Liste im Datenblatt wuerde also luegen.
 *
 * Datenquelle: backend/ebay-data/condition-policies-de.json, erzeugt von
 * scripts/sync-ebay-condition-policies.js aus der eBay-Metadata-API
 * (getItemConditionPolicies). Der frueher uebliche Trading-Call
 * GetCategoryFeatures ist abgeschaltet (HTTP 410).
 *
 * FAIL-OPEN: Kennt die Tabelle eine Kategorie nicht, wird NICHT blockiert.
 * 81 Bestandsprodukte stehen in solchen Kategorien; sie duerfen nicht am
 * Einstellen gehindert werden, nur weil unsere Tabelle eine Luecke hat.
 */

const path = require('path');

/** Voreinstellung, wenn niemand etwas gewaehlt hat: Neu. */
const DEFAULT_CONDITION_ID = '1000';

/**
 * Rueckfall-Namen fuer den Fall, dass die Kategorie unbekannt ist. Das ist der
 * jeweils haeufigste Name der ID ueber alle Kategorien hinweg (Stand 2026-08-10).
 * Wird NUR benutzt, wenn kein kategoriegenauer Name ermittelbar ist.
 */
const GENERIC_CONDITION_NAMES = {
  1000: 'Neu',
  1500: 'Neu: Sonstige (siehe Artikelbeschreibung)',
  1750: 'Neu mit Fehlern',
  1900: 'Unbenutzt',
  2000: 'Zertifiziert generalüberholt',
  2500: 'Vom Verkäufer generalüberholt',
  2750: 'Neuwertig',
  2990: 'Gebraucht - Hervorragend',
  3000: 'Gebraucht',
  3010: 'Gebraucht - Akzeptabel',
  4000: 'Sehr gut',
  5000: 'Gut',
  6000: 'Akzeptabel',
  7000: 'Als Ersatzteil / defekt',
};

let _table = null;

/**
 * Laedt die Kategorie-Tabelle einmalig. Faellt die Datei aus (fehlt, kaputt),
 * bleibt die Tabelle leer — dann verhaelt sich das ganze Modul fail-open, statt
 * den Prozess zu reissen.
 */
function loadTable() {
  if (_table) return _table;
  try {
    // eslint-disable-next-line global-require
    const raw = require(path.join(__dirname, '..', 'ebay-data', 'condition-policies-de.json'));
    _table = {
      sets: Array.isArray(raw?.sets) ? raw.sets : [],
      cats: raw?.cats && typeof raw.cats === 'object' ? raw.cats : {},
      syncedAt: raw?.syncedAt || null,
    };
  } catch (err) {
    console.warn(`[ebay-conditions] Kategorie-Tabelle nicht ladbar: ${err.message}`);
    _table = { sets: [], cats: {}, syncedAt: null };
  }
  return _table;
}

function normalizeCategoryId(value) {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  return /^\d+$/.test(s) ? s : '';
}

function normalizeConditionId(value) {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  return /^\d+$/.test(s) ? s : '';
}

/**
 * Welche Zustaende erlaubt diese Kategorie?
 *
 * @param {string|number} categoryId
 * @returns {{known: boolean, required: boolean, conditions: Array<{id: string, name: string}>}}
 *   `known:false` bedeutet: die Kategorie steht nicht in der Tabelle. Dann ist
 *   `conditions` leer und der Aufrufer darf NICHT auf "verboten" schliessen.
 */
function getConditionsForCategory(categoryId) {
  const empty = { known: false, required: false, conditions: [] };
  const catId = normalizeCategoryId(categoryId);
  if (!catId) return empty;

  const table = loadTable();
  const entry = table.cats[catId];
  if (!Array.isArray(entry)) return empty;

  const [setIdx, requiredFlag] = entry;
  const set = table.sets[setIdx];
  if (!Array.isArray(set)) return { known: true, required: Boolean(requiredFlag), conditions: [] };

  return {
    known: true,
    required: Boolean(requiredFlag),
    conditions: set
      .map(([id, name]) => ({ id: String(id), name: String(name || '') }))
      .filter((c) => c.id),
  };
}

/**
 * Darf dieser Zustand in dieser Kategorie verwendet werden?
 *
 * Fail-open in drei Faellen: kein Zustand gewaehlt, Kategorie unbekannt,
 * Kategorie fuehrt gar keine Zustaende. In allen drei Faellen soll der
 * Aufrufer nicht blockieren.
 */
function isConditionAllowed(categoryId, conditionId) {
  const condId = normalizeConditionId(conditionId);
  if (!condId) return true;

  const { known, conditions } = getConditionsForCategory(categoryId);
  if (!known || !conditions.length) return true;

  return conditions.some((c) => c.id === condId);
}

/**
 * Der Anzeigename eines Zustands — kategoriegenau, sonst der gaengige Name.
 * Unbekannte ID ergibt eine leere Zeichenkette (nie "undefined" im Text).
 */
function resolveConditionName(categoryId, conditionId) {
  const condId = normalizeConditionId(conditionId);
  if (!condId) return '';

  const { conditions } = getConditionsForCategory(categoryId);
  const hit = conditions.find((c) => c.id === condId);
  if (hit && hit.name) return hit.name;

  return GENERIC_CONDITION_NAMES[condId] || '';
}

/** Wann wurde die Tabelle zuletzt von eBay geholt? Fuer Veralterungs-Hinweise. */
function getTableSyncedAt() {
  return loadTable().syncedAt;
}

/**
 * Zustaende, die dieses Konto NICHT setzen darf.
 *
 * Gemessen 20.08.2026 ueber einen Vollabruf der eBay-Metadata-API (alle 14.917
 * Kategorien): die vier Refurbished-Zustaende kommen KEIN EINZIGES Mal vor —
 * auch nicht in Kategorien wie Handys oder Laptops, wo Refurbished ueblich ist.
 * eBay gibt sie nur an Haendler heraus, die fuer das Refurbished-Programm
 * freigeschaltet sind.
 *
 * Sie stehen deshalb nicht mehr in der Rueckfall-AUSWAHL. Die NAMEN bleiben
 * vollstaendig (GENERIC_CONDITION_NAMES), damit resolveConditionName() auch
 * Altbestaende beschriften kann, in denen so ein Wert noch steht.
 *
 * Sobald das Konto freigeschaltet ist, liefert der Katalog-Abgleich die
 * Zustaende automatisch — diese Liste betrifft nur den Rueckfall fuer
 * Kategorien, die gar nicht im Katalog stehen.
 */
const NICHT_FREIGESCHALTETE_CONDITION_IDS = new Set(['2000', '2010', '2020', '2030']);

/** Rueckfall-Auswahl fuer Kategorien ohne Katalog-Eintrag. */
function getGenericConditionOptions() {
  return Object.entries(GENERIC_CONDITION_NAMES)
    .filter(([id]) => !NICHT_FREIGESCHALTETE_CONDITION_IDS.has(String(id)))
    .map(([id, name]) => ({ id: String(id), name }));
}

module.exports = {
  getGenericConditionOptions,
  NICHT_FREIGESCHALTETE_CONDITION_IDS,
  DEFAULT_CONDITION_ID,
  GENERIC_CONDITION_NAMES,
  getConditionsForCategory,
  isConditionAllowed,
  resolveConditionName,
  getTableSyncedAt,
};
