'use strict';

// Muster seit Chat-Grounding-Start 2026-08-04: Preisquellen aus der Google-
// Recherche scheitern an der Beleg-Verifikation (3 Läufe, 5 verworfene
// Quellen). Ursache: Grounding liefert opake Redirect-URLs
// (vertexaisearch.cloud.google.com/grounding-api-redirect/…) — der Prüfer
// kann weder Domain klassifizieren noch die Zielseite sauber laden, und im
// Datenblatt stünde eine Google-URL statt der echten Quelle. Dieser Helper
// löst Redirects VOR der Weitergabe auf (max 3 Hops, Timeout, fail-open auf
// die Original-URL).

const { resolveGroundingRedirects } = require('../../lib/grounding-redirect-resolve');

const REDIRECT_URL = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123';
const TARGET_URL = 'https://www.idealo.de/preisvergleich/OffersOfProduct/12345.html';

function fetchFake(map) {
  return async (url) => {
    const entry = map[url];
    if (!entry) throw new Error(`unexpected fetch: ${url}`);
    return {
      status: entry.status,
      headers: { get: (name) => (name.toLowerCase() === 'location' ? entry.location || null : null) },
    };
  };
}

describe('resolveGroundingRedirects', () => {
  it('löst eine Grounding-Redirect-URL auf ihre Ziel-URL auf', async () => {
    const out = await resolveGroundingRedirects([REDIRECT_URL], {
      fetchImpl: fetchFake({ [REDIRECT_URL]: { status: 302, location: TARGET_URL } }),
    });
    expect(out).toEqual([TARGET_URL]);
  });

  it('lässt normale URLs unangetastet (kein Netz-Call)', async () => {
    let called = false;
    const out = await resolveGroundingRedirects([TARGET_URL], {
      fetchImpl: async () => { called = true; throw new Error('nope'); },
    });
    expect(out).toEqual([TARGET_URL]);
    expect(called).toBe(false);
  });

  it('folgt Redirect-Ketten bis maximal 3 Hops', async () => {
    const hop1 = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/hop1';
    const hop2 = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/hop2';
    const out = await resolveGroundingRedirects([hop1], {
      fetchImpl: fetchFake({
        [hop1]: { status: 302, location: hop2 },
        [hop2]: { status: 301, location: TARGET_URL },
      }),
    });
    expect(out).toEqual([TARGET_URL]);
  });

  it('fail-open: bei Fetch-Fehler bleibt die Original-URL erhalten', async () => {
    const out = await resolveGroundingRedirects([REDIRECT_URL], {
      fetchImpl: async () => { throw new Error('timeout'); },
    });
    expect(out).toEqual([REDIRECT_URL]);
  });

  it('fail-open: 200 ohne Location behält die Original-URL', async () => {
    const out = await resolveGroundingRedirects([REDIRECT_URL], {
      fetchImpl: fetchFake({ [REDIRECT_URL]: { status: 200, location: null } }),
    });
    expect(out).toEqual([REDIRECT_URL]);
  });
});
