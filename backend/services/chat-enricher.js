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
  'ZUERST die angehängten Produktbilder auswerten: Sie zeigen den echten Artikel/die Verpackung. Lies Marke, Modell/Typnummer, Maße, Material UND besonders die Hersteller-/EU-Verantwortlichen-/GPSR-Angaben DIREKT vom Etikett/Karton ab.',
  'Recherchiere fehlende ODER falsche Daten aktiv (googleSearch, urlContext, lookup_gtin, search_ebay_catalog, search_amazon_product, search_manufacturer_site, fetch_url_content) und KORRIGIERE sie. Cross-referenziere mindestens 2 Quellen.',
  'Fülle/korrigiere: Titel (MARKE ZUERST, 70–80 Zeichen), Beschreibung, Key-Features, ALLE eBay-Pflicht-Merkmale (Maße/Material/Farbe/Anwendung — verifiziert!), GPSR (Hersteller UND EU-Verantwortlicher, Rollen exakt gemäß Etikett-Beschriftung), Gewicht, Preis (mit Quellen-URL).',
  'GPSR-Rollen strikt: "Manufacturer:"/"Hersteller:"-Zeile → manufacturer_* (auch China); "EC REP"/"EU-Bevollmächtigter" → eu_responsible_*; "UK/AR" ist NICHT der EU-Verantwortliche. Wenn du Hersteller-/EU-Angaben vom Etikett abliest, setze gpsr.source = "product_image". NIEMALS einen Hersteller/EU-Verantwortlichen erfinden oder Adressen/Telefone der Rollen vermischen.',
  'Ändere NICHT die Kategorie. Erfinde nichts — nur belegte Fakten oder vom Etikett Abgelesenes; bei Unsicherheit confidence < 0.7 und Feld weglassen.',
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
 * @param {Function} [params.searchImpl] — Injection fuer die Impressum-
 *   Selbstsuche (Signatur wie lib/web-search-html searchWeb).
 * @param {Function} [params.registryLookupImpl] — Injection fuer den
 *   Registry-Lookup (Signatur wie getManufacturerGpsrByName).
 * @returns {Promise<{ changes: Array, notes: string[], removed: number,
 *   unverifiedKept: number, infraFlagged: boolean,
 *   verifiedEvidence: object|null }>}
 */
async function validateGpsrDatasheetChanges({ product, changes, fetchImpl, timeoutMs, maxPages, failMode = 'closed', imageContextAvailable = false, searchImpl, registryLookupImpl } = {}) {
  const list = Array.isArray(changes) ? changes : [];
  const notes = new Set();
  const kept = [];
  let removed = 0;
  let unverifiedKept = 0;
  let infraFlagged = false;
  let imageFlagged = false;
  let verifiedEvidence = null;
  // Incident 2026-08-04 (SKU-2834170242): ohne gpsr.url verwarf das Gate jeden
  // Vorschlag OHNE einen Netz-Request ('no_candidate_urls'), und der User sah
  // die Werte nie. Beide Verhalten sind seither per Kill-Switch revidierbar.
  const selfSearchEnabled = String(process.env.GPSR_GATE_SELF_SEARCH || 'on').toLowerCase() !== 'off';
  const keepUnverifiedEnabled = String(process.env.GPSR_GATE_KEEP_UNVERIFIED || 'on').toLowerCase() !== 'off';

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
    // Provenienz-Marker konsumieren + aus der Card strippen (nie roh persistieren).
    const explicitImageFlag = _safeStr(change.gpsr.source) === 'product_image';
    if ('source' in change.gpsr) delete change.gpsr.source;
    // Etikett-Vertrauen: Das physische Verpackungsfoto ist die autoritativste
    // Quelle und schlägt die Web-Prüfung (Incident 2026-07-17: gr4tec.com listet
    // den OEM-Hersteller nicht → "unverifiable" verwarf korrekte Etikett-Daten).
    // Voraussetzung: dem Modell wurden ECHTE Produktbilder gesendet
    // (imageContextAvailable, wahrhaftig aus productImagesSent). Im interaktiven
    // Chat (failMode 'open', Human-Review) reicht das; im Bulk (kein Review)
    // zusätzlich der explizite source='product_image'-Marker.
    const imageSourced = imageContextAvailable && (explicitImageFlag || failMode === 'open');

    const incoming = _pickGpsrProposal(change.gpsr);
    if (!Object.keys(incoming).length) {
      kept.push(change);
      continue;
    }

    let verification;
    let selfSearchedUrl = null;
    try {
      const { verifyGpsrRecord, findManufacturerImpressumUrl } = require('../lib/gpsr-evidence');
      const existing = product && product.details && product.details.gpsr
        && typeof product.details.gpsr === 'object' ? product.details.gpsr : {};
      // Der NEUE Stand (existing + Vorschlag) wird verifiziert — das ist
      // exakt das, was ein Apply persistieren wuerde.
      const proposed = { ...existing, ...incoming };
      delete proposed.evidence;
      const brand = product && product.identification ? product.identification.brand : undefined;
      // Selbstsuche: fehlt die Kandidaten-URL, beschafft das Gate sie selbst
      // (Registry → Web-Suche), statt ohne Netz-Request "unbelegt" zu urteilen.
      if (!_safeStr(proposed.url) && selfSearchEnabled) {
        // Latenz-Schranke: Die Selbstsuche darf den Chat nie festhalten —
        // nach 8s gilt "keine URL gefunden" und die normale Kette läuft weiter.
        let selfSearchTimer = null;
        const found = await Promise.race([
          findManufacturerImpressumUrl({
            brand,
            manufacturerName: proposed.manufacturer_name,
            searchImpl,
            registryLookupImpl,
          }),
          new Promise((resolve) => { selfSearchTimer = setTimeout(resolve, 8000, null); }),
        ]).finally(() => { if (selfSearchTimer) clearTimeout(selfSearchTimer); });
        if (found) {
          proposed.url = found;
          selfSearchedUrl = found;
        }
      }
      verification = await verifyGpsrRecord({
        brand,
        gpsr: proposed,
        fetchImpl,
        timeoutMs,
        maxPages,
      });
      // Eine SELBST gesuchte URL beweist mit reinem Namens-Treffer nichts —
      // der Markenname steht auf jeder Haendler-Seite. 'partial' zaehlt nur,
      // wenn die URL aus dem Vorschlag/Datenblatt selbst stammt.
      if (selfSearchedUrl && verification && verification.status === 'partial') {
        verification = { ...verification, status: 'unverifiable' };
      }
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
      // Vom Etikett abgelesene Daten sind Ground Truth vom EIGENEN Produkt und
      // schlagen die Web-Prüfung: Eine Marken-/Händlerseite (z. B. gr4tec.com)
      // listet den OEM-Hersteller oft NICHT — das darf die korrekten
      // Karton-Angaben nicht verwerfen. Die Fake-Gates oben (Fake-Telefon/
      // suspekte E-Mail) bleiben die Halluzinations-Absicherung.
      if (imageSourced) {
        imageFlagged = true;
        change.gpsr_evidence_check = {
          outcome: 'product_image',
          checked_at: new Date().toISOString(),
          note: 'vom Produktbild/Etikett abgelesen — kein passender Web-Impressum-Beleg, bitte sichten',
        };
        notes.add('Die Hersteller-/GPSR-Angaben wurden vom Produktbild (Etikett) abgelesen und übernommen — bitte kurz gegenprüfen.');
        kept.push(change);
        continue;
      }
      if (failMode === 'open' && keepUnverifiedEnabled) {
        // Interaktiver Chat: Der Mensch sieht die Karte und entscheidet.
        // Loeschen wuerde die recherchierten Werte unsichtbar machen (Incident
        // 2026-08-04: 3x GPSR angefragt, 3x beantwortet, 3x still geloescht).
        unverifiedKept += 1;
        change.gpsr_evidence_check = {
          outcome: 'unverified',
          checked_at: new Date().toISOString(),
          note: 'kein Web-Beleg gefunden — vor Übernahme manuell prüfen',
        };
        notes.add('Die vorgeschlagenen Hersteller-/GPSR-Angaben konnten auf keiner Hersteller-Seite belegt werden — sie bleiben als UNBESTÄTIGTER Vorschlag in der Karte. Bitte vor Übernahme prüfen.');
        kept.push(change);
        continue;
      }
      notes.add('Die vorgeschlagenen Hersteller-/GPSR-Angaben konnten auf keiner Hersteller-Seite belegt werden — die Änderung wurde als UNBELEGT verworfen. Bitte manuell verifizieren.');
      dropGpsrFrom(change);
      continue;
    }

    if (verification.status === 'infra_blocked') {
      // Netz-/Infrastruktur-Problem: kein Urteil moeglich — NICHT blocken.
      // Bei Etikett-Quelle die klarere "vom Produktbild"-Botschaft (die Daten
      // sind vom eigenen Karton, nicht "unbestätigt geraten").
      if (imageSourced) {
        imageFlagged = true;
        change.gpsr_evidence_check = {
          outcome: 'product_image',
          checked_at: new Date().toISOString(),
          note: 'vom Produktbild/Etikett abgelesen (Web-Beleg technisch nicht erreichbar), bitte sichten',
        };
        notes.add('Die Hersteller-/GPSR-Angaben wurden vom Produktbild (Etikett) abgelesen und übernommen — bitte kurz gegenprüfen.');
        kept.push(change);
        continue;
      }
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
    // Selbst gefundene, verifizierte URL in den Vorschlag uebernehmen — damit
    // wird sie beim Apply persistiert und kuenftige Pruefungen deterministisch.
    if (selfSearchedUrl && !_safeStr(change.gpsr.url)) {
      change.gpsr.url = selfSearchedUrl;
    }
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
    unverifiedKept,
    infraFlagged,
    imageFlagged,
    verifiedEvidence,
  };
}

async function enrichViaChatV3(product, opts = {}) {
  const deps = opts.deps || {};
  const runChat = deps.runProductChatV3 || require('./product-chat-v3').runProductChatV3;
  const { extractGpsrFromImages } = require('../lib/gpsr-image-extract');

  // AUTORITATIVE GPSR vom Etikett (Incident 2026-07-17): Der agentische Chat
  // liest GPSR-Rollen inkonsistent (mal richtig, mal Hersteller/EU-Rep vertauscht).
  // Ein dedizierter, niedrig-temperierter Vision-Call mit striktem Schema liest
  // die Rollen deterministisch. Er läuft PARALLEL zum agentischen Enrich (nicht
  // danach — sonst wird er nach dem 90s-Call ressourcen-ausgehungert und
  // scheitert am Timeout), und sein Ergebnis ERSETZT den agentischen GPSR-Read.
  const [chatOutcome, extracted] = await Promise.all([
    runChat({
      product,
      message: FULL_ENRICH_MESSAGE,
      tenantId: opts.tenantId || null,
      userId: opts.userId || 'bulk-veredler',
    }).then((r) => ({ result: r })).catch((e) => ({ error: (e && e.message) || String(e) })),
    extractGpsrFromImages(product, { aiClient: deps.aiClient }).catch((e) => {
      console.warn('[chat-enricher] gpsr-image-extract error:', e?.message || e);
      return null;
    }),
  ]);

  if (chatOutcome.error) {
    return { product, changed: [], datasheetChanges: [], evidence: [], confidence: null, model: null, error: chatOutcome.error };
  }
  const result = chatOutcome.result;

  let datasheetChanges = Array.isArray(result && result.datasheetChanges) ? result.datasheetChanges : [];

  let gpsrImageSourced = false;
  if (extracted && extracted.gpsr && Object.keys(extracted.gpsr).length) {
    gpsrImageSourced = true;
    let gpsrChange = datasheetChanges.find((c) => c && c.gpsr && typeof c.gpsr === 'object');
    if (!gpsrChange) {
      gpsrChange = { summary: 'GPSR-Angaben vom Etikett abgelesen', gpsr: {} };
      datasheetChanges.push(gpsrChange);
    }
    gpsrChange.gpsr = { ...extracted.gpsr, source: 'product_image' };
  }
  console.log('[chat-enricher] gpsr-image-extract: product=%s imageSourced=%s manufacturer=%s',
    product?.id || '?', gpsrImageSourced, extracted?.gpsr?.manufacturer_name || '-');

  // GPSR-Beleg-Validierung VOR dem Apply — Bulk hat kein Human-Review, daher
  // fail-closed (siehe Kopfkommentar). Kein gpsr in den Changes → No-op.
  let gpsrValidation = null;
  if (datasheetChanges.some((c) => c && c.gpsr && typeof c.gpsr === 'object')) {
    gpsrValidation = await validateGpsrDatasheetChanges({
      product,
      changes: datasheetChanges,
      fetchImpl: opts.gpsrFetchImpl || deps.gpsrFetchImpl,
      failMode: 'closed',
      // Etikett-Extraktion ODER echt gesendete Bilder = vertrauenswürdiger
      // Bildkontext. Fake-Gates + auditierbarer Evidence-Eintrag bleiben aktiv.
      imageContextAvailable: gpsrImageSourced || Number(result && result.productImagesSent) > 0,
    });
    datasheetChanges = gpsrValidation.changes;
  }

  const { product: merged, changed } = applyChatChangesToProduct(product, datasheetChanges, { nowIso: opts.nowIso });

  // Beleg-Metadaten ins Datenblatt schreiben, wenn gpsr angewendet wurde
  // (apply-chat-changes stringifiziert Objekt-Werte in change.gpsr — deshalb
  // wird evidence hier NACH dem Apply gesetzt, nie in der Card selbst).
  if (changed.includes('gpsr') && merged.details && merged.details.gpsr) {
    if (gpsrImageSourced) {
      // Etikett-Quelle ist AUTORITATIV: der Marker sorgt dafür, dass die
      // GPSR-Marken-Registry sie NICHT überschreibt (gpsrRegistryEnforce) und
      // stattdessen mit der korrekten Angabe geheilt wird (Incident 2026-07-17).
      merged.details.gpsr.evidence = {
        status: 'product_image',
        checked_at: new Date().toISOString(),
        source: 'chat-enricher',
      };
    } else if (gpsrValidation && gpsrValidation.verifiedEvidence) {
      merged.details.gpsr.evidence = { ...gpsrValidation.verifiedEvidence, source: 'chat-enricher' };
    } else if (gpsrValidation && gpsrValidation.infraFlagged) {
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
