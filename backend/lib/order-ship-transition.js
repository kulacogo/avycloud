'use strict';

/**
 * "Ware ist raus" — den Auftrag zuverlässig auf versendet setzen.
 *
 * Gefunden 2026-08-17: Der Knopf "Tracking manuell" speicherte die Nummer,
 * legte eine Sendung an, schob sie zum Marktplatz — und rief dann
 * `transitionOrder({toStatus:'shipped'})` OHNE den Rückgabewert anzusehen.
 *
 * `transitionOrder` wirft bei einem unerlaubten Übergang nicht, es gibt
 * `{ok:false, error}` zurück. Erlaubt ist aber nur `packed → shipped`. Genau
 * der Fall, für den der Knopf existiert — eine außerhalb des Systems
 * verschickte Sendung nachtragen — trifft Aufträge in "Kommissionierung",
 * "Gepickt" oder "Verpacken". Für die passierte: nichts. Der Auftrag blieb im
 * alten Status hängen, obwohl die Ware unterwegs war.
 *
 * Schlimmer als die falsche Anzeige ist die Folge: ohne den Übergang läuft
 * `_onOrderShipped` nicht, der Bestand wird nicht abgebucht und die Menge auf
 * den Marktplätzen bleibt zu hoch — das Muster aus CLAUDE.md Punkt 11.
 *
 * Deshalb: bei Ablehnung EINMAL mit `force: true` wiederholen. Der Mensch
 * bezeugt hier ausdrücklich, dass die Ware raus ist — das ist der dokumentierte
 * Zweck von force ("manual override"), und die Marktplatz-Intakes nutzen ihn
 * genauso. Die wirklich gefährlichen Sprünge bleiben gesperrt:
 * FORCE_FORBIDDEN_TRANSITIONS blockt `shipped→shipped` (Doppel-Abzug) auch
 * mit force. Doppel-Abzug nach einem Pick verhindert zusätzlich der
 * `stockDecrementedAt`-Marker (CLAUDE.md Punkt 13).
 *
 * Was danach immer noch scheitert, wird GEMELDET statt verschluckt.
 */

/**
 * @param {object} deps
 * @param {Function} deps.transitionOrder  Die echte Zustandsmaschine.
 * @param {string} deps.tenantId
 * @param {string} deps.orderId
 * @param {object} deps.actor
 * @param {string} deps.note
 * @param {object} [deps.timestamps]
 * @returns {Promise<{ok: boolean, forced: boolean, error: string|null}>}
 */
async function markiereAlsVersendet({
  transitionOrder,
  tenantId,
  orderId,
  actor,
  note,
  timestamps = undefined,
}) {
  const basis = { tenantId, orderId, toStatus: 'shipped', actor, note };
  if (timestamps) basis.timestamps = timestamps;

  const ersterVersuch = await transitionOrder(basis);
  if (ersterVersuch && ersterVersuch.ok !== false) {
    return { ok: true, forced: false, error: null };
  }

  const zweiterVersuch = await transitionOrder({ ...basis, force: true });
  if (zweiterVersuch && zweiterVersuch.ok !== false) {
    return { ok: true, forced: true, error: null };
  }

  return {
    ok: false,
    forced: true,
    error: (zweiterVersuch && zweiterVersuch.error) || (ersterVersuch && ersterVersuch.error) || 'unbekannt',
  };
}

module.exports = { markiereAlsVersendet };
