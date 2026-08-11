'use strict';

/**
 * Übersetzt SendCloud-Fehlerantworten in einen Satz, der sagt, WAS zu tun ist
 * und WER es beheben kann.
 *
 * Hintergrund: der Label-Pfad reichte die rohe API-Antwort ins Modal durch —
 * inklusive JSON-Klammern und `pointer: non_field_errors`. Daraus konnte der
 * Operator weder das betroffene Produkt noch den Ort der Behebung ablesen und
 * versuchte es mehrfach mit demselben Produkt (Auftrag 10-14999-44761,
 * 2026-08-07: DHL Europaket ohne Abrechnungsnummer im DHL-Vertrag).
 *
 * Grundsatz: NICHTS verschlucken. Unbekannte Fehler kommen unverändert zurück,
 * damit eine neue Fehlerart nie hinter einer freundlichen Floskel verschwindet.
 */

// Muster → Erklärung. `detail` von SendCloud ist englisch und stabil formuliert.
const RULES = [
  {
    test: /add the billing number for this product/i,
    build: ({ shippingOptionCode }) =>
      `Für dieses DHL-Produkt${shippingOptionCode ? ` (${shippingOptionCode})` : ''} fehlt die Abrechnungsnummer im DHL-Vertrag. ` +
      'Das ist eine Einstellung bei SendCloud, nicht in avycloud: SendCloud → Einstellungen → Versanddienstleister → DHL → ' +
      'Abrechnungsnummer für dieses Produkt hinterlegen. Bis dahin ein anderes Versandprodukt wählen (z. B. DPD Classic Europa).',
  },
  {
    // SendCloud/DPD melden das beim Announce einer Auslandssendung — die
    // Original-Antwort kommt hier ausnahmsweise auf Deutsch, die englische
    // Variante ist ebenfalls belegt. Erst der Absender-Datensatz trägt die
    // Nummer; eine Inline-Adresse hat gar kein Steuerfeld (Incident
    // 2026-08-10, Aufträge 18-14989-91354/IT + 08-15012-44206/NL).
    test: /USt-?IdNr|Umsatzsteuer-?Identifikationsnummer|\bVAT (number|ID)\b/i,
    build: () =>
      'SendCloud verlangt für Auslandssendungen die USt-IdNr. des Absenders. Sie hängt am ' +
      'gespeicherten Absender-Datensatz, nicht am Konto: SendCloud → Einstellungen → Adressen → ' +
      'Absenderadresse → USt-IdNr. eintragen. Danach greift sie ohne Deploy (Zugangsdaten-Cache ≤60s).',
  },
  {
    test: /valid zip code/i,
    build: () =>
      'SendCloud lehnt die PLZ ab. Bitte PLZ und Stadt im Auftrag unter „Kunde → Bearbeiten" prüfen — ' +
      'erfahrungsgemäß sind die beiden Felder vertauscht.',
  },
  {
    test: /valid (phone|telephone)/i,
    build: () => 'SendCloud lehnt die Telefonnummer ab. Bitte im Auftrag unter „Kunde → Bearbeiten" korrigieren oder leeren.',
  },
];

function _details(rawBody) {
  try {
    const json = JSON.parse(rawBody);
    const errors = Array.isArray(json?.errors) ? json.errors : [];
    return errors.map((e) => String(e?.detail || e?.message || '')).filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * Wie translateSendCloudError, meldet aber zusätzlich, OB eine Regel gegriffen
 * hat. Der Aufrufer kann dann generische Zusätze ("Guthaben prüfen") weglassen,
 * wenn die Ursache bereits genau benannt ist — die pauschale Aufzählung schickt
 * den Operator sonst auf die falsche Fährte.
 *
 * @param {string} rawBody Antwort-Body von SendCloud (JSON oder beliebiger Text)
 * @param {{shippingOptionCode?: string}} ctx
 * @returns {{matched: boolean, message: string}}
 */
function explainSendCloudError(rawBody, ctx = {}) {
  const body = String(rawBody ?? '');
  const details = _details(body);
  const haystack = details.length ? details.join(' ') : body;

  for (const rule of RULES) {
    if (rule.test.test(haystack)) return { matched: true, message: rule.build(ctx) };
  }
  // Unbekannt → Originaltext, damit nie Information verloren geht.
  return { matched: false, message: details.length ? details.join(' ') : body };
}

/**
 * @param {string} rawBody Antwort-Body von SendCloud (JSON oder beliebiger Text)
 * @param {{shippingOptionCode?: string}} ctx
 * @returns {string} Erklärung auf Deutsch, sonst der Originaltext
 */
function translateSendCloudError(rawBody, ctx = {}) {
  return explainSendCloudError(rawBody, ctx).message;
}

module.exports = { translateSendCloudError, explainSendCloudError, RULES };
