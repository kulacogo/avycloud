'use strict';

/**
 * Grounding-Verbrauchszaehler.
 *
 * Seit der 3.7-flash-Politik (2026-08-26) rechnet Google Grounding auf der
 * 3er-Familie PRO AUSGEFUEHRTER SUCH-QUERY ab (5.000 frei/Monat, danach
 * 14 $/1.000) — ein Prompt kann mehrere Queries ausloesen. Damit das
 * Freikontingent ueberwachbar ist, zaehlt dieser Helper die
 * groundingMetadata.webSearchQueries jeder Antwort in external_api_calls
 * (service='gemini_grounding', Feld queryCount).
 *
 * WICHTIG: bewusst UNGESAMPELT ueber den external-api-tracker (Default-Rate 1.0)
 * statt ueber llm-telemetry (LLM_TELEMETRY_SAMPLE=0.1) — ein Quota-Zaehler, der
 * nur jede zehnte Suche sieht, ist eine Schaetzung, kein Zaehler.
 * Fire-and-forget, wirft NIE.
 */

function countWebSearchQueries(response) {
  try {
    const md = response?.candidates?.[0]?.groundingMetadata;
    const queries = md?.webSearchQueries;
    return Array.isArray(queries) ? queries.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Zaehlt die Such-Queries einer Gemini-Antwort. endpoint = Aufrufer-Kennung
 * (z. B. 'identify.grounding', 'chat.v2.phaseA'). Gibt die Anzahl zurueck,
 * damit Aufrufer sie zusaetzlich in eigene Traces schreiben koennen.
 */
function trackGroundingQueries(response, endpoint) {
  const n = countWebSearchQueries(response);
  if (n > 0) {
    try {
      // Lazy require: der Tracker zieht lib/firestore — das darf erst zur
      // Laufzeit passieren, nie beim Modul-Load (Tests patchen require.cache).
      const { trackExternalCall } = require('./external-api-tracker');
      trackExternalCall({
        service: 'gemini_grounding',
        endpoint: endpoint || null,
        success: true,
        latencyMs: 0,
        queryCount: n,
      });
    } catch {
      // fire-and-forget
    }
  }
  return n;
}

module.exports = { countWebSearchQueries, trackGroundingQueries };
