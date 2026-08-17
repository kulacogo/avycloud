'use strict';

/**
 * "Tracking manuell" liess den Auftrag im alten Status haengen.
 *
 * Gefunden 2026-08-17. Die Route POST /api/orders/:id/tracking rief
 * transitionOrder({toStatus:'shipped'}) und sah den Rueckgabewert NIE an.
 * transitionOrder wirft bei einem unerlaubten Uebergang nicht — es gibt
 * {ok:false, error} zurueck. Erlaubt ist nur `packed → shipped`.
 *
 * Genau der Anwendungsfall des Knopfs (eine ausserhalb des Systems
 * verschickte Sendung nachtragen) trifft Auftraege in "Kommissionierung",
 * "Gepickt" oder "Verpacken". Fuer die passierte nichts: der Auftrag blieb
 * stehen, `_onOrderShipped` lief nicht, der Bestand wurde nicht abgebucht —
 * die Menge auf den Marktplaetzen blieb zu hoch (CLAUDE.md Punkt 11).
 */

const { markiereAlsVersendet } = require('../lib/order-ship-transition');

function fakeTransition(antworten) {
  const aufrufe = [];
  const fn = async (args) => {
    aufrufe.push(args);
    return antworten[aufrufe.length - 1];
  };
  fn.aufrufe = aufrufe;
  return fn;
}

const BASIS = {
  tenantId: 'default',
  orderId: 'AVY-2026-0042',
  actor: { uid: 'u1', email: 'lager@example.com' },
  note: 'Tracking manuell hinterlegt: 00340434',
};

describe('Manuell hinterlegtes Tracking setzt den Auftrag auf versendet', () => {
  it('erlaubter Uebergang: ein Aufruf, kein force', async () => {
    const transitionOrder = fakeTransition([{ ok: true }]);
    const res = await markiereAlsVersendet({ ...BASIS, transitionOrder });

    expect(res).toEqual({ ok: true, forced: false, error: null });
    expect(transitionOrder.aufrufe).toHaveLength(1);
    expect(transitionOrder.aufrufe[0].force).toBeUndefined();
  });

  it('abgelehnter Uebergang wird EINMAL erzwungen — genau der Vorfall', async () => {
    const transitionOrder = fakeTransition([
      { ok: false, error: 'Übergang von "Kommissionierung" zu "Versendet" ist nicht erlaubt.' },
      { ok: true },
    ]);
    const res = await markiereAlsVersendet({ ...BASIS, transitionOrder });

    expect(res.ok).toBe(true);
    expect(res.forced).toBe(true);
    expect(transitionOrder.aufrufe).toHaveLength(2);
    expect(transitionOrder.aufrufe[1].force).toBe(true);
  });

  it('bleibt es verboten, wird es GEMELDET statt verschluckt', async () => {
    // shipped→shipped bleibt auch mit force gesperrt (Doppel-Abzug).
    const transitionOrder = fakeTransition([
      { ok: false, error: 'nicht erlaubt' },
      { ok: false, error: 'FORCE_FORBIDDEN: shipped→shipped' },
    ]);
    const res = await markiereAlsVersendet({ ...BASIS, transitionOrder });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('shipped→shipped');
  });

  it('reicht Zeitstempel durch, wenn es welche gibt', async () => {
    const transitionOrder = fakeTransition([{ ok: true }]);
    const timestamps = { shippedAt: '2026-08-17T10:00:00.000Z' };
    await markiereAlsVersendet({ ...BASIS, transitionOrder, timestamps });

    expect(transitionOrder.aufrufe[0].timestamps).toEqual(timestamps);
  });

  it('haengt keine leeren Zeitstempel an', async () => {
    const transitionOrder = fakeTransition([{ ok: true }]);
    await markiereAlsVersendet({ ...BASIS, transitionOrder });

    expect('timestamps' in transitionOrder.aufrufe[0]).toBe(false);
  });
});

describe('Die Route wertet das Ergebnis aus', () => {
  const fs = require('fs');
  const path = require('path');
  const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'orders.js'), 'utf8');

  function trackingRoute() {
    const start = SOURCE.indexOf("router.post('/orders/:orderId/tracking'");
    expect(start).toBeGreaterThan(-1);
    const end = SOURCE.indexOf('\nrouter.', start + 20);
    return SOURCE.slice(start, end > start ? end : SOURCE.length);
  }

  it('nutzt die gemeinsame Regel', () => {
    expect(trackingRoute()).toMatch(/markiereAlsVersendet\s*\(/);
  });
});
