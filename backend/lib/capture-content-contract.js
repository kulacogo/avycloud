'use strict';

const { GPSR_FIELDS } = require('./chat-datasheet-contract');
const { normalizeHighlightsStrict } = require('./highlights-policy');

// Capture content contract v3, 2026-10-09. Both generation paths use this
// additive schema. GPSR field names stay owned by the shared datasheet contract.
const GPSR_CONTENT_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(GPSR_FIELDS.map(field => [field, { type: 'string' }])),
  description: 'Belegte Herstellerdaten und separat belegter EU-Verantwortlicher. Unbekannte Werte weglassen.',
};

function sanitizeCaptureGpsr(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(GPSR_FIELDS.filter(field => typeof value[field] === 'string' && value[field].trim())
    .map(field => [field, value[field].trim()]));
}

function buildCaptureRequirements(enrichment = {}, gpsrWebFallback = null) {
  const category = enrichment.category?.ebayBreadcrumb || '';
  const { rules } = normalizeHighlightsStrict({ identification: { category } }, []);
  const lines = [
    'ERFASSUNGSVERTRAG v3:',
    ...(rules ? [`Highlights: ${Math.max(5, rules.min)}-${Math.max(5, rules.max)} eigenstaendige belegte Vorteile, JEWEILS ${rules.minLen}-${rules.maxLen} Zeichen inklusive Leerzeichen.`,
      'Format: "Nutzen – konkrete Eigenschaft" (Leerzeichen um den Gedankenstrich). Laengen vor Ausgabe pruefen.'] : []),
    'Der erste Schreibversuch wird auf Vollstaendigkeit geprueft. Gemeldete Luecken vor Abschluss im selben Lauf recherchieren und korrigieren; maximal zwei Korrekturen. Nicht belegbare Angaben bleiben offen, niemals mit beliebigen Enum-Werten fuellen.',
    'Produktquellen teilen: product_source_urls enthaelt bis zu 6 tatsaechlich gelesene Produktseiten fuer das konkrete Modell. So kann die separate Preisrecherche bereits gefundene Seiten nutzen; keine URLs erfinden.',
    'GPSR im Feld gpsr: Herstelleradresse in Strasse, PLZ, Ort und Land trennen; vorhandene E-Mail/Website uebernehmen.',
    'EU-Verantwortlichen separat recherchieren und nur mit belegbarer Zuordnung zu Marke/Modell eintragen. Nicht erfinden; ohne Beleg Felder weglassen.',
    'Modell, Variante, Groesse, Farbe und Lieferumfang muessen den Fotos/Etiketten entsprechen. Fremde Varianten und Zubehoer nicht uebernehmen.',
  ];
  if (enrichment.priceResearchManaged) {
    lines.push('Preisrecherche laeuft bereits separat und wird vor dem Speichern uebernommen. In dieser Textphase keine weitere Preis- oder Sold-Recherche starten.');
  }
  if (enrichment.recommendedAspects?.length) {
    lines.push(`Empfohlene Kategorie-Merkmale ebenfalls recherchieren, soweit belegbar: ${enrichment.recommendedAspects.join(', ')}`);
  }
  for (const [label, data] of [['Registry', enrichment.gpsr?.data], ['Web', gpsrWebFallback]]) {
    const gpsr = sanitizeCaptureGpsr(data);
    if (Object.keys(gpsr).length) lines.push(`Vorliegende GPSR-Daten (${label}): ${JSON.stringify(gpsr)}`);
  }
  return lines.join('\n');
}

module.exports = { GPSR_CONTENT_SCHEMA, sanitizeCaptureGpsr, buildCaptureRequirements };
