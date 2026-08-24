'use strict';

/**
 * duplicate-search.js — "Gibt es dieses Produkt schon?" beim Erfassen.
 *
 * Bis 2026-08-18 verglich die Erfassung ausschliesslich Barcodes
 * (`findProductByStrictIdentifier`). Ohne lesbaren Barcode entstand IMMER ein
 * neues Datenblatt mit neuer SKU — gemessen 64 Paare "gleiches Produkt zweimal
 * erfasst", 30 davon mit Bestand.
 *
 * Drei Stufen, nur die letzte ist KI:
 *   1. confirmed    — Marke + Herstellernummer stimmen ueberein (deterministisch)
 *   2. candidates   — Modellnummer / Namensueberlappung (deterministisch)
 *   3. judged       — die KI bestaetigt oder verwirft einen dieser Kandidaten
 *
 * Der Barcode-Vergleich bleibt davor bestehen und wird hier NICHT ersetzt.
 */

const { findConfirmedMatch, selectCandidates, namensAehnlichkeit } = require('../lib/product-match');

// Unterhalb dieser Namens-Aehnlichkeit wird ein Treffer auf Marke +
// Herstellernummer NICHT blind uebernommen, sondern der KI vorgelegt.
//
// Grund: die Herstellernummer ist im Bestand nicht durchgaengig sauber. In
// derselben Datenbank standen schon Telefonnummern als EAN-8 (Incident
// 2026-07-08, SONAX 08431530). Traegt ein Produkt eine Serien- statt einer
// Artikelnummer, waere ein blindes Reuse ein Treffer auf ein fremdes
// Datenblatt. Ein LEERER Name ist dabei kein Widerspruch — dann bleibt die
// Nummer der Beleg.
//
// Der Wert ist gemessen, nicht geschaetzt (2026-08-18, Zeichen-Bigramme):
// gleiche Produkte lagen bei 0,667 bis 0,848, verschiedene bei 0,267 bis 0,400.
// 0,5 liegt in der Luecke. Fehlerrichtung: ein zu Unrecht gemeldeter
// Widerspruch kostet nur einen KI-Aufruf, ein uebersehener trifft ein fremdes
// Datenblatt.
const MIN_NAMENS_AEHNLICHKEIT = 0.5;

const MODES = new Set(['off', 'shadow', 'on']);

function dedupSearchMode() {
  const raw = String(process.env.DEDUP_SEARCH || 'on').trim().toLowerCase();
  return MODES.has(raw) ? raw : 'on';
}

/**
 * @param {object} args
 * @param {object} args.fresh    frisch identifiziertes Produkt
 * @param {Array}  args.images   optional [{buffer, mimetype}] fuer das KI-Urteil
 * @param {object} args.index    Katalog-Index (Testbarkeit; default: prozessweit)
 * @param {Function} args.judge  KI-Urteil (Testbarkeit; default: duplicate-judge)
 * @returns {Promise<{matchId: string|null, stage: string, shadowMatchId?: string|null, ...}>}
 */
async function searchExistingProduct({ fresh, images = [], index = null, judge = null } = {}) {
  const mode = dedupSearchMode();
  if (mode === 'off') {
    return { matchId: null, stage: 'disabled', shadowMatchId: null };
  }

  const ausgeben = (treffer, stage, extra = {}) => ({
    // Im Beobachtungsmodus wird entschieden, aber nichts ausgeliefert.
    matchId: mode === 'shadow' ? null : treffer,
    shadowMatchId: treffer,
    stage,
    ...extra,
  });

  try {
    const katalog = index || require('../lib/catalog-index').getSharedCatalogIndex();
    const eintraege = await katalog.entries();

    const sicher = findConfirmedMatch(fresh, eintraege);
    const sicherEintrag = sicher ? eintraege.find((e) => e.id === sicher.id) : null;

    if (sicher && !namenWidersprechen(fresh, sicherEintrag)) {
      console.log(`[dedup-search] sicherer Treffer ueber ${sicher.reason}: ${sicher.id}`);
      return ausgeben(sicher.id, 'confirmed', { reason: sicher.reason });
    }

    // Gleiche Nummer, klar anderer Artikel? Dann nicht verwerfen, sondern
    // pruefen lassen — der Kandidat ist ja durchaus plausibel.
    const kandidaten = sicher && sicherEintrag
      ? [{ id: sicher.id, score: 1, reasons: ['mpn_name_konflikt'], entry: sicherEintrag }]
      : selectCandidates(fresh, eintraege);
    if (!kandidaten.length) {
      return { matchId: null, shadowMatchId: null, stage: 'no_candidates' };
    }

    const urteilen = judge || require('./duplicate-judge').judgeDuplicate;
    const urteil = await urteilen({ fresh, candidates: kandidaten, images });

    if (!urteil?.matchId) {
      return {
        matchId: null,
        shadowMatchId: null,
        stage: 'rejected',
        verdict: urteil?.verdict || 'unsure',
        candidateIds: kandidaten.map((k) => k.id),
      };
    }

    console.log(`[dedup-search] KI bestaetigt Treffer ${urteil.matchId} (${urteil.confidence})`);
    return ausgeben(urteil.matchId, 'judged', {
      verdict: urteil.verdict,
      confidence: urteil.confidence,
      reason: urteil.reason || null,
    });
  } catch (err) {
    // Die Suche darf die Erfassung nie abreissen — im Fehlerfall wird angelegt,
    // also exakt das Verhalten von vorher.
    console.warn('[dedup-search] fehlgeschlagen, lege regulaer an:', err?.message || err);
    return { matchId: null, shadowMatchId: null, stage: 'error', error: String(err?.message || err) };
  }
}

/**
 * Widersprechen sich die Bezeichnungen so deutlich, dass die uebereinstimmende
 * Herstellernummer allein nicht mehr traegt?
 */
function namenWidersprechen(fresh, treffer) {
  if (!treffer) return false;
  const frischerName = fresh?.identification?.name || '';
  // Ohne verwertbaren Namen auf einer Seite gibt es keinen Widerspruch —
  // dann bleibt die Herstellernummer der Beleg.
  if (!frischerName.trim() || !String(treffer.name || '').trim()) return false;
  return namensAehnlichkeit(frischerName, treffer.name) < MIN_NAMENS_AEHNLICHKEIT;
}

module.exports = { searchExistingProduct, dedupSearchMode };
