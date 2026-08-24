'use strict';

/**
 * duplicate-judge.js — das KI-Urteil in der Duplikat-Suche der Erfassung.
 *
 * Rollenverteilung (nicht verhandelbar, Lehre aus Incident 2026-07-08):
 * `lib/product-match.js` findet Kandidaten DETERMINISTISCH. Dieser Dienst darf
 * einen vorgelegten Kandidaten nur BESTAETIGEN oder VERWERFEN. Er darf nie
 * bestimmen, WELCHES Produkt ueberhaupt in Frage kommt — sonst ist der
 * Suchraum wieder die ganze Datenbank, und eine Halluzination trifft ein
 * beliebiges fremdes Datenblatt (damals: drei ATE-Produkte auf einem).
 *
 * Fehlerrichtung: im Zweifel KEIN Treffer. Ein verpasstes Duplikat kostet ein
 * zusaetzliches Datenblatt, das ein Mensch zusammenfuehren kann. Ein falscher
 * Treffer ueberschreibt ein fremdes, womoeglich handgepflegtes Datenblatt.
 */

const DEFAULT_MIN_CONFIDENCE = 0.85;
const MAX_IMAGES = 3;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['same', 'different', 'unsure'] },
    candidate_id: { type: 'string', nullable: true },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['verdict', 'confidence'],
};

function minConfidence() {
  const raw = Number(process.env.DEDUP_JUDGE_MIN_CONFIDENCE);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_MIN_CONFIDENCE;
}

function beschreibeKandidat(kandidat) {
  const e = kandidat?.entry || {};
  const felder = [
    `id: ${kandidat.id}`,
    e.brand ? `Marke: ${e.brand}` : null,
    e.name ? `Bezeichnung: ${e.name}` : null,
    e.mpnNorm ? `Herstellernummer: ${e.mpnNorm}` : null,
    Array.isArray(kandidat.reasons) && kandidat.reasons.length ? `Fundgrund: ${kandidat.reasons.join(', ')}` : null,
  ].filter(Boolean);
  return `- ${felder.join(' | ')}`;
}

function buildPrompt(fresh, candidates) {
  const f = fresh?.identification || {};
  const mpn = fresh?.details?.identifiers?.mpn || '';
  return [
    'Du pruefst, ob ein frisch erfasstes Produkt bereits im Bestand existiert.',
    '',
    'FRISCH ERFASST (die Fotos zeigen genau dieses Produkt):',
    `- Marke: ${f.brand || 'unbekannt'}`,
    `- Bezeichnung: ${f.name || 'unbekannt'}`,
    mpn ? `- Herstellernummer: ${mpn}` : '- Herstellernummer: keine',
    '',
    'KANDIDATEN AUS DEM BESTAND:',
    ...candidates.map(beschreibeKandidat),
    '',
    'Frage: Ist das frisch erfasste Produkt DERSELBE Artikel wie einer der Kandidaten?',
    '',
    'Regeln:',
    '- "same" nur bei demselben Artikel desselben Herstellers in derselben Ausfuehrung.',
    '- Verschiedene Groesse, Farbe, Menge, Variante oder Modelljahr sind NICHT derselbe Artikel.',
    '- candidate_id MUSS eine der oben aufgefuehrten ids sein. Erfinde niemals eine id.',
    '- Im Zweifel "unsure". Ein falsches "same" ueberschreibt fremde Produktdaten.',
  ].join('\n');
}

function parseAntwort(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {object} args
 * @param {object} args.fresh       frisch identifiziertes Produkt
 * @param {Array}  args.candidates  Ergebnis aus selectCandidates()
 * @param {Array}  args.images      optional [{buffer, mimetype}] der Erfassung
 * @returns {Promise<{matchId: string|null, verdict: string, confidence: number, reason: string|null, error?: string}>}
 */
async function judgeDuplicate({ fresh, candidates = [], images = [] } = {}) {
  const unentschieden = (extra = {}) => ({
    matchId: null, verdict: 'unsure', confidence: 0, reason: null, ...extra,
  });

  // Ohne Kandidaten gibt es nichts zu bestaetigen — und kein Geld auszugeben.
  if (!Array.isArray(candidates) || candidates.length === 0) return unentschieden();

  const erlaubteIds = new Set(candidates.map((k) => String(k.id)));

  const parts = [{ text: buildPrompt(fresh, candidates) }];
  for (const img of (images || []).slice(0, MAX_IMAGES)) {
    if (!img?.buffer) continue;
    parts.push({
      inline_data: {
        mime_type: img.mimetype || 'image/jpeg',
        data: img.buffer.toString('base64'),
      },
    });
  }

  let antwort;
  try {
    const { callGeminiStructured } = require('../lib/gemini-structured');
    antwort = parseAntwort(await callGeminiStructured({
      parts,
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 2048,
    }));
  } catch (err) {
    console.warn('[duplicate-judge] KI-Urteil fehlgeschlagen, lege neu an:', err?.message || err);
    return unentschieden({ error: String(err?.message || err) });
  }

  if (!antwort) return unentschieden({ error: 'Antwort nicht lesbar' });

  const verdict = String(antwort.verdict || 'unsure');
  const confidence = Number(antwort.confidence);
  const candidateId = antwort.candidate_id == null ? null : String(antwort.candidate_id);
  const reason = antwort.reason ? String(antwort.reason).slice(0, 400) : null;

  if (verdict !== 'same') {
    return { matchId: null, verdict: verdict === 'different' ? 'different' : 'unsure', confidence: Number.isFinite(confidence) ? confidence : 0, reason };
  }

  // Die KI darf nur aus der vorgelegten Liste waehlen. Eine erfundene id ist
  // keine Bestaetigung, sondern genau der Vektor aus Juli 2026.
  if (!candidateId || !erlaubteIds.has(candidateId)) {
    console.warn(`[duplicate-judge] Urteil nennt unbekannte id "${candidateId}" — verworfen.`);
    return unentschieden({ reason, error: 'candidate_id nicht in der Vorlage' });
  }

  if (!Number.isFinite(confidence) || confidence < minConfidence()) {
    return { matchId: null, verdict: 'unsure', confidence: Number.isFinite(confidence) ? confidence : 0, reason };
  }

  return { matchId: candidateId, verdict: 'same', confidence, reason };
}

module.exports = { judgeDuplicate, buildPrompt, RESPONSE_SCHEMA };
