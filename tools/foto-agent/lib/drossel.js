'use strict';

/**
 * drossel.js — Selbstbegrenzung gegen das gemeinsame Anfrage-Kontingent.
 *
 * `identifyLimiter` (backend/lib/rate-limit.js) laesst 30 Anfragen je 15
 * Minuten zu. Der Zaehler laeuft VOR der Anmeldung und damit pro IP-Adresse —
 * der Agent teilt sie sich mit jedem Mitarbeiter im selben Netz. Ein
 * ungebremster Stapellauf wuerde also den Erfassen-Assistenten der Kollegen
 * sperren ("Too many requests. Try again in 15 minutes.").
 *
 * Deshalb nimmt der Agent bewusst nur einen Teil und laesst den Rest frei.
 */

const FENSTER_MS = 15 * 60 * 1000;
// 12 von 30: der Agent laeuft unbeaufsichtigt, ein Mensch der davorsteht nicht.
const DEFAULT_KONTINGENT = 12;

/**
 * Wie lange muss vor dem naechsten Aufruf gewartet werden?
 * @returns {number} Millisekunden (0 = sofort)
 */
function berechnePause({ letzteAufrufe = [], jetzt = Date.now(), maxProFenster = DEFAULT_KONTINGENT, fensterMs = FENSTER_MS } = {}) {
  const imFenster = letzteAufrufe
    .filter((t) => Number.isFinite(t) && jetzt - t < fensterMs)
    .sort((a, b) => a - b);

  if (imFenster.length < maxProFenster) return 0;

  // Der aelteste zaehlende Aufruf faellt heraus, sobald das Fenster ueber ihn
  // hinweggelaufen ist.
  const aeltester = imFenster[imFenster.length - maxProFenster];
  return Math.max(0, fensterMs - (jetzt - aeltester));
}

module.exports = { berechnePause, DEFAULT_KONTINGENT, FENSTER_MS };
