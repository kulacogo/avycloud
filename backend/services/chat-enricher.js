'use strict';

/**
 * chat-enricher.js — enrich a product's FULL datasheet using the same research-
 * grounded chat pipeline the assistant uses (runProductChatV3), then apply ALL
 * proposals via applyChatChangesToProduct.
 *
 * This is the parity path the user asked for: the bulk veredler reaches chat
 * quality on EVERYTHING (title, price, gpsr, attributes, description, weight) so
 * the chat is rarely needed afterwards. Content only — never inventory/sku/storage,
 * never category, never marketplace publish. Returns proposals applied to a CLONE
 * (caller persists via saveProductV2). runProductChatV3 is injectable for tests.
 *
 * GPSR-BELEG-VALIDIERUNG (AUDIT 2026-07-16): Die Chat-Pipelines durften GPSR-/
 * Hersteller-Felder aendern OHNE jede Validierung — exakt das Muster des
 * Preis-Halluzinations-Incidents 2026-07-11 (okopp@apple.com als Apple-Kontakt,
 * Telefon "+496105456789"). validateGpsrDatasheetChanges prueft VOR dem Apply
 * jede gpsr-Aenderung via lib/gpsr-evidence.js verifyGpsrRecord:
 *   - unverifiable ODER Fake-Muster (Fake-Telefon/suspekte E-Mail im Vorschlag)
 *     → Aenderung wird aus den Change-Cards ENTFERNT + Warnhinweis
 *   - infra_blocked → durchlassen mit Flag (Netz-Probleme blocken keinen Chat),
 *     der Datensatz gilt aber als unbestaetigt
 *   - verified/partial → durchlassen, evidence-Metadaten landen im Datenblatt
 * Der Bulk-Pfad (hier, KEIN Human-Review) validiert fail-CLOSED: stirbt der
 * Validator selbst, wird die gpsr-Aenderung verworfen statt blind angewendet.
 * Die Chat-Route (routes/identify.js validateChatGpsr) nutzt dieselbe Funktion
 * fail-OPEN (Chat darf nie am Validator sterben — Human sieht die Warnung).
 */

const { applyChatChangesToProduct } = require('../lib/apply-chat-changes');

const FULL_ENRICH_MESSAGE = [
  'Reichere das KOMPLETTE Datenblatt dieses Produkts auf eBay-/Kaufland-Listing-Standard an.',
  'Recherchiere fehlende ODER falsche Daten aktiv (googleSearch, urlContext, lookup_gtin, search_ebay_catalog, search_amazon_product, search_manufacturer_site, fetch_url_content) und KORRIGIERE sie. Cross-referenziere mindestens 2 Quellen.',
  'Fülle/korrigiere: Titel (MARKE ZUERST, 70–80 Zeichen), Beschreibung, Key-Features, ALLE eBay-Pflicht-Merkmale (Maße/Material/Farbe/Anwendung — verifiziert!), GPSR (Hersteller bzw. EU-Verantwortlicher), Gewicht, Preis (mit Quellen-URL).',
  'Ändere NICHT die Kategorie. Erfinde nichts — nur belegte Fakten; bei Unsicherheit confidence < 0.7 und Feld weglassen.',
  'Gib alle Änderungen über update_product_datasheet zurück, inkl. Quellen.',
].join('\n');

// GPSR-relevante Felder in einer Chat-Change-Card (change.gpsr.*) — nur
// Aenderungen an diesen Feldern loesen die Beleg-Pruefung aus.
const GPSR_PREFIX_RE = /^(manufacturer_|eu_responsible_)/;
const GPSR_EXACT_FIELDS = new Set(['email', 'url', 'entity_country', 'country_code', 'phone']);

function _safeStr(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

/**
 * Extrahiert die GPSR-relevanten, non-empty Vorschlags-Felder einer Change-Card.
 * "Unbekannt"/Platzhalter zaehlen nicht (gleiches isBad-Muster wie
 * apply-chat-changes).
 */
function _pickGpsrProposal(gpsrChange) {
  const out = {};
  for (const [k, v] of Object.entries(gpsrChange && typeof gpsrChange === 'object' ? gpsrChange : {})) {
    const key = _safeStr(k);
    if (!key) continue;
    if (!(GPSR_PREFIX_RE.test(key) || GPSR_EXACT_FIELDS.has(key))) continue;
    const s = _safeStr(v);
    if (!s || /^unbekannt$/i.test(s) || s === '-' || s === '--' || /^n\/?a$/i.test(s)) continue;
    out[key] = s;
  }
  return out;
}

// Hat die Card nach dem Strip der gpsr-Aenderung noch anwendbaren Inhalt?
const APPLYABLE_CHANGE_KEYS = [
  'title', 'identity', 'short_description', 'key_features',
  'attributes', 'pricing', 'weight_grams', 'notes',
];
function _hasOtherPayload(change) {
  return APPLYABLE_CHANGE_KEYS.some((k) => change && change[k] != null);
}

/**
 * Validiert gpsr-Aenderungen in Chat-datasheetChanges gegen echte Seiten
 * (lib/gpsr-evidence.js verifyGpsrRecord). Mutiert die Cards in place
 * (Strip/Flag) und liefert die bereinigte Liste zurueck.
 *
 * @param {object} params
 * @param {object} params.product — aktuelles Produkt (Kontext fuer den Merge)
 * @param {Array}  params.changes — datasheetChanges der Chat-Pipeline
 * @param {Function} [params.fetchImpl] — Injection fuer Tests (Signatur wie
 *   fetchPageForVerification)
 * @param {number} [params.timeoutMs]
 * @param {number} [params.maxPages]
 * @param {'open'|'closed'} [params.failMode='closed'] — Verhalten bei
 *   VALIDATOR-Fehler: 'closed' (Bulk, kein Review → gpsr-Aenderung verwerfen)
 *   oder 'open' (Chat-Route, Human sieht Warnung → durchlassen).
 * @returns {Promise<{ changes: Array, notes: string[], removed: number,
 *   infraFlagged: boolean, verifiedEvidence: object|null }>}
 */
async function validateGpsrDatasheetChanges({ product, changes, fetchImpl, timeoutMs, maxPages, failMode = 'closed', imageContextAvailable = false } = {}) {
  const list = Array.isArray(changes) ? changes : [];
  const notes = new Set();
  const kept = [];
  let removed = 0;
  let infraFlagged = false;
  let imageFlagged = false;
  let verifiedEvidence = null;

  const dropGpsrFrom = (change) => {
    removed += 1;
    delete change.gpsr;
    if (_hasOtherPayload(change)) kept.push(change);
  };

  for (const change of list) {
    if (!change || typeof change !== 'object' || !change.gpsr || typeof change.gpsr !== 'object') {
      kept.push(change);
      continue;
    }
    // Provenienz-Marker konsumieren + aus der Card strippen, damit er nie als
    // roher gpsr-Key persistiert oder an verifyGpsrRecord geht. Vertrauen NUR,
    // wenn dem Modell in diesem Turn tatsächlich Produktbilder gesendet wurden.
    const imageSourced = imageContextAvailable && _safeStr(change.gpsr.source) === 'product_image';
    if ('source' in change.gpsr) delete change.gpsr.source;

    const incoming = _pickGpsrProposal(change.gpsr);
    if (!Object.keys(incoming).length) {
      kept.push(change);
      continue;
    }

    let verification;
    try {
      const { verifyGpsrRecord } = require('../lib/gpsr-evidence');
      const existing = product && product.details && product.details.gpsr
        && typeof product.details.gpsr === 'object' ? product.details.gpsr : {};
      // Der NEUE Stand (existing + Vorschlag) wird verifiziert — das ist
      // exakt das, was ein Apply persistieren wuerde.
      const proposed = { ...existing, ...incoming };
      delete proposed.evidence;
      verification = await verifyGpsrRecord({
        brand: product && product.identification ? product.identification.brand : undefined,
        gpsr: proposed,
        fetchImpl,
        timeoutMs,
        maxPages,
      });
    } catch (err) {
      if (failMode === 'open') {
        notes.add('Die GPSR-/Hersteller-Angaben konnten nicht geprüft werden — bitte vor Übernahme manuell verifizieren.');
        kept.push(change);
      } else {
        notes.add(`GPSR-Prüfung fehlgeschlagen (${err && err.message ? err.message : err}) — Hersteller-Änderung sicherheitshalber verworfen.`);
        dropGpsrFrom(change);
      }
      continue;
    }

    const issues = Array.isArray(verification.issues) ? verification.issues : [];
    // Fake-Gates zaehlen nur, wenn das geflaggte Feld Teil des VORSCHLAGS ist —
    // Altlasten im bestehenden Datenblatt blocken keine fremden Aenderungen.
    const fakePhoneInProposal = issues.includes('fake_phone_pattern')
      && !!(incoming.manufacturer_phone || incoming.phone);
    const suspectEmailInProposal = issues.some((i) => String(i).startsWith('suspect_email:'))
      && !!incoming.email;

    if (fakePhoneInProposal || suspectEmailInProposal) {
      notes.add('Eine vorgeschlagene Hersteller-Kontaktangabe sieht nach einem Platzhalter/Halluzinations-Muster aus (Telefon/E-Mail) — die GPSR-Änderung wurde verworfen.');
      dropGpsrFrom(change);
      continue;
    }

    if (verification.status === 'unverifiable') {
      // Vom Etikett abgelesene Daten (source=product_image) sind Ground Truth
      // vom EIGENEN Produkt. "unverifiable" heißt hier nur "kein Web-Impressum
      // gefunden" (no_candidate_urls) — das darf sie NICHT verwerfen, solange
      // kein aktiver Web-Widerspruch vorliegt und die Fake-Gates oben grün sind.
      // Widerlegt dagegen die Hersteller-EIGENE Seite die Angabe, gewinnt die
      // Seite (dann kein no_candidate_urls-Issue) → weiterhin verwerfen.
      const noWebCheck = issues.includes('no_candidate_urls') || issues.includes('no_gpsr_data');
      if (imageSourced && noWebCheck) {
        imageFlagged = true;
        change.gpsr_evidence_check = {
          outcome: 'product_image',
          checked_at: new Date().toISOString(),
          note: 'aus Produktbild abgelesen — kein Web-Impressum-Beleg, bitte sichten',
        };
        notes.add('Die Hersteller-/GPSR-Angaben wurden vom Produktbild (Etikett) abgelesen und übernommen — es gibt keinen Web-Impressum-Beleg, bitte kurz sichten.');
        kept.push(change);
        continue;
      }
      notes.add('Die vorgeschlagenen Hersteller-/GPSR-Angaben konnten auf keiner Hersteller-Seite belegt werden — die Änderung wurde als UNBELEGT verworfen. Bitte manuell verifizieren.');
      dropGpsrFrom(change);
      continue;
    }

    if (verification.status === 'infra_blocked') {
      // Netz-/Infrastruktur-Problem: kein Urteil moeglich — NICHT blocken,
      // aber ehrlich flaggen (Preis-Doktrin: infra != unbelegt).
      infraFlagged = true;
      change.gpsr_evidence_check = {
        outcome: 'fetch_infrastructure_failure',
        checked_at: new Date().toISOString(),
        issues: issues.slice(0, 10),
      };
      notes.add('Die GPSR-Quellen konnten technisch nicht geprüft werden (Seitenabruf fehlgeschlagen) — die Hersteller-Angaben gelten als unbestätigt.');
      kept.push(change);
      continue;
    }

    // verified | partial → durchlassen + Beleg dokumentieren.
    const ev = verification.evidence || {};
    change.gpsr_evidence_check = {
      outcome: verification.status,
      url: ev.url || null,
      checked_at: ev.checked_at || new Date().toISOString(),
      method: ev.method || null,
    };
    verifiedEvidence = {
      status: verification.status,
      url: ev.url || null,
      checked_at: ev.checked_at || new Date().toISOString(),
      method: ev.method || null,
    };
    kept.push(change);
  }

  return {
    changes: kept,
    notes: Array.from(notes),
    removed,
    infraFlagged,
    imageFlagged,
    verifiedEvidence,
  };
}

async function enrichViaChatV3(product, opts = {}) {
  const deps = opts.deps || {};
  const runChat = deps.runProductChatV3 || require('./product-chat-v3').runProductChatV3;

  let result;
  try {
    result = await runChat({
      product,
      message: FULL_ENRICH_MESSAGE,
      tenantId: opts.tenantId || null,
      userId: opts.userId || 'bulk-veredler',
    });
  } catch (e) {
    return { product, changed: [], datasheetChanges: [], evidence: [], confidence: null, model: null, error: (e && e.message) || String(e) };
  }

  let datasheetChanges = Array.isArray(result && result.datasheetChanges) ? result.datasheetChanges : [];

  // GPSR-Beleg-Validierung VOR dem Apply — Bulk hat kein Human-Review, daher
  // fail-closed (siehe Kopfkommentar). Kein gpsr in den Changes → No-op.
  let gpsrValidation = null;
  if (datasheetChanges.some((c) => c && c.gpsr && typeof c.gpsr === 'object')) {
    gpsrValidation = await validateGpsrDatasheetChanges({
      product,
      changes: datasheetChanges,
      fetchImpl: opts.gpsrFetchImpl || deps.gpsrFetchImpl,
      failMode: 'closed',
      // Vertrauen in Etikett-Daten NUR, wenn dem Modell echt Bilder gesendet
      // wurden. Bulk hat kein Human-Review — Fake-Gates + auditierbarer
      // Evidence-Eintrag (outcome:'product_image') bleiben aktiv.
      imageContextAvailable: Number(result && result.productImagesSent) > 0,
    });
    datasheetChanges = gpsrValidation.changes;
  }

  const { product: merged, changed } = applyChatChangesToProduct(product, datasheetChanges, { nowIso: opts.nowIso });

  // Beleg-Metadaten ins Datenblatt schreiben, wenn gpsr angewendet wurde
  // (apply-chat-changes stringifiziert Objekt-Werte in change.gpsr — deshalb
  // wird evidence hier NACH dem Apply gesetzt, nie in der Card selbst).
  if (gpsrValidation && changed.includes('gpsr') && merged.details && merged.details.gpsr) {
    if (gpsrValidation.verifiedEvidence) {
      merged.details.gpsr.evidence = { ...gpsrValidation.verifiedEvidence, source: 'chat-enricher' };
    } else if (gpsrValidation.infraFlagged) {
      merged.details.gpsr.evidence = {
        status: 'unverified',
        reason: 'fetch_infrastructure_failure',
        checked_at: new Date().toISOString(),
        source: 'chat-enricher',
      };
    }
  }

  return {
    product: merged,
    changed,
    datasheetChanges,
    evidence: Array.isArray(result && result.evidence) ? result.evidence : [],
    confidence: result && result.confidence && typeof result.confidence.overall === 'number' ? result.confidence.overall : null,
    model: (result && result.model) || null,
    gpsrWarnings: gpsrValidation ? gpsrValidation.notes : [],
    gpsrChangesRemoved: gpsrValidation ? gpsrValidation.removed : 0,
  };
}

module.exports = { enrichViaChatV3, validateGpsrDatasheetChanges, FULL_ENRICH_MESSAGE };
