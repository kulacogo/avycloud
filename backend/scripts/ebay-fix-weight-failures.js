#!/usr/bin/env node
/**
 * Operator-Skript: Nachzügler des Gewichts-Pushes (ebay-push-weights.js)
 * reparieren — Revisen, die an FEHLENDEN PFLICHT-MERKMALEN scheiterten
 * ("La caractéristique de l'objet obligatoire Type est manquante", das Konto
 * meldet auf Französisch/BEFR-Site-Defaults).
 *
 * Mechanik pro fehlgeschlagenem (Produkt, itemId) aus den Push-Reports:
 *   1. Fehlende Aspect-Namen aus der Fehlermeldung extrahieren (FR-Pattern
 *      hier + DE/EN via services/ebay-auto-fix extractMissingAspectNames).
 *   2. Werte füllen: MPN-artige Aspects direkt aus identification.mpn,
 *      Rest via fillAspectsViaGemini (services/ebay-auto-fix, Strategie 2 des
 *      Publish-Auto-Fix — kurze korrekte Werte, kein Raten).
 *   3. GetItem (Active + FixedPrice), Union-Merge wie ebay-push-weights.js
 *      (live + lokal + generierte Pflicht-Aspects, additiv, Cap 45 — Pflicht-
 *      Aspects und Gewicht zuerst, damit der Cap sie nie frisst).
 *   4. ReviseFixedPriceItem mit NUR { itemId, itemSpecifics }.
 *   5. Bei Erfolg: generierte Aspects additiv ins Datenblatt (saveProductV2)
 *      — künftige Publishes/Revisen regressieren nicht.
 *
 * HARTE GUARDS (CLAUDE.md Punkt 14): kein endItem-Import, Fehler werden nur
 * gesammelt, 2s Delay pro Item.
 *
 * Aufruf:
 *   node backend/scripts/ebay-fix-weight-failures.js --report <push-report.json> [--report ...]
 *   node backend/scripts/ebay-fix-weight-failures.js --report r1.json --apply
 */

'use strict';

process.env.USE_PRODUCTS_V2 = process.env.USE_PRODUCTS_V2 || 'true';

const fs = require('fs');
const path = require('path');

const REVISE_DELAY_MS = 2000;
const MAX_ASPECTS = 45;

function safeString(v) {
  return v == null ? '' : String(v).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const out = {
    apply: false,
    reports: [],
    outDir: process.env.SCRATCHPAD_DIR || '/tmp',
    limit: null,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--apply') out.apply = true;
    else if (t === '--report') { const f = argv[i + 1]; if (f) out.reports.push(f); i += 1; }
    else if (t === '--out') { out.outDir = argv[i + 1] || out.outDir; i += 1; }
    else if (t === '--limit') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n);
      i += 1;
    } else if (t === '--help' || t === '-h') out.help = true;
  }
  return out;
}

/**
 * Fehlende Pflicht-Aspect-Namen aus eBay-Fehlermeldungen ziehen.
 * Ergänzt die DE/EN-Patterns aus services/ebay-auto-fix um die
 * FRANZÖSISCHEN Meldungen dieses Kontos (BEFR-Site-Defaults). PURE.
 */
function extractMissingAspectNamesFr(message) {
  const found = new Set();
  const patterns = [
    /caract[ée]ristique de l'objet obligatoire (.+?) est manquante/i,
    /caract[ée]ristique de l'objet (.+?) est manquante/i,
    /Ajoutez (.+?) (?:et une valeur correspondante )?[àa] (?:l'annonce|cette)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(safeString(message));
    if (m && m[1]) {
      // 'obligatoire ' ist Teil der Meldung, nie des Merkmalnamens — das
      // laxere zweite Pattern fängt es sonst mit ein (Duplikat-Key-Falle).
      const name = m[1].trim().replace(/\s{2,}/g, ' ').replace(/^obligatoire\s+/i, '');
      if (name && name.length <= 60) found.add(name);
    }
  }
  return Array.from(found);
}

/** MPN-artige Aspect-Namen direkt aus dem Datenblatt bedienbar? PURE. */
function isMpnAspect(name) {
  return /num[ée]ro de pi[èe]ce fabricant|herstellernummer|manufacturer part number|mpn/i.test(safeString(name));
}

/**
 * Union wie ebay-push-weights.js, aber mit Prioritäts-Schicht: generierte
 * Pflicht-Aspects + Gewichts-Merkmal zuerst (der Cap darf sie nie fressen),
 * dann restliche lokale, dann live-only. PURE.
 */
function mergeSpecificsWithRequired(requiredSpecifics, localSpecifics, liveSpecifics) {
  const specifics = {};
  const put = (k, v) => {
    if (Object.keys(specifics).length >= MAX_ASPECTS) return false;
    if (v == null || String(Array.isArray(v) ? v[0] : v).trim() === '') return true;
    if (Object.keys(specifics).some((x) => x.toLowerCase() === k.toLowerCase())) return true;
    specifics[k] = v;
    return true;
  };
  for (const [k, v] of Object.entries(requiredSpecifics || {})) put(k, v);
  const local = Object.entries(localSpecifics || {});
  for (const [k, v] of local) {
    if (/gewicht|weight/i.test(k)) put(k, v);
  }
  for (const [k, v] of local) put(k, v);
  for (const [k, v] of Object.entries(liveSpecifics || {})) put(k, v);
  return specifics;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.reports.length) {
    console.log('Aufruf: node backend/scripts/ebay-fix-weight-failures.js --report <push-report.json> [--report ...] [--apply] [--limit n] [--out dir]');
    return;
  }

  // Lazy Requires — bewusst KEIN endItem/endFixedPriceItem (CLAUDE.md Punkt 14).
  const { firestore } = require('../lib/firestore');
  const { saveProductV2, getCollection } = require('../lib/product-store');
  const { reviseFixedPriceItem, getItemDetails } = require('../lib/ebay-trading-api');
  const { mapProductToEbayItem } = require('../lib/ebay-direct');
  const { extractMissingAspectNames } = require('../services/ebay-auto-fix');
  const { gemini3GenerateText } = require('../lib/gemini3-client');

  const startedAt = new Date().toISOString();

  // Fehlgeschlagene Revisen aus den Push-Reports einsammeln (dedupe pro Produkt).
  const failures = new Map();
  for (const file of args.reports) {
    const rep = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Akzeptiert Push-Reports (stage='revise') UND eigene Fix-Reports (ohne
    // stage) — Listings mit MEHREREN fehlenden Pflicht-Merkmalen brauchen
    // iterative Läufe, weil eBay pro Revise nur das erste fehlende meldet.
    for (const e of rep.errors || []) {
      if ((e.stage && e.stage !== 'revise') || !e.productId || !e.itemId) continue;
      if (!failures.has(e.productId)) failures.set(e.productId, e);
    }
  }
  let todo = Array.from(failures.values()).sort((a, b) => String(a.productId).localeCompare(String(b.productId)));
  if (args.limit) todo = todo.slice(0, args.limit);
  console.log(`[ebay-fix-weights] Modus=${args.apply ? 'APPLY' : 'DRY-RUN'} — ${todo.length} fehlgeschlagene Revisen aus ${args.reports.length} Report(s)`);

  const results = [];
  const errors = [];
  const collectionName = getCollection();
  let processed = 0;

  for (const fail of todo) {
    if (processed > 0 && args.apply) await sleep(REVISE_DELAY_MS);
    processed += 1;

    try {
      const snap = await firestore.collection(collectionName).doc(String(fail.productId)).get();
      if (!snap.exists) {
        results.push({ productId: fail.productId, sku: fail.sku, status: 'skipped_not_found' });
        continue;
      }
      const product = { id: snap.id, ...snap.data() };

      // 1. Fehlende Aspect-Namen (FR zuerst, dann DE/EN-Patterns).
      const missing = [
        ...extractMissingAspectNamesFr(fail.error),
        ...extractMissingAspectNames([safeString(fail.error)]),
      ].filter((v, i, a) => a.indexOf(v) === i);
      const isSystemError = /systemfehler|internal error/i.test(safeString(fail.error));
      if (!missing.length && !isSystemError) {
        results.push({ productId: product.id, sku: fail.sku, status: 'skipped_no_aspect_in_error', error: fail.error.slice(0, 120) });
        continue;
      }

      // 2. Werte füllen: MPN direkt, Rest via Gemini.
      const generateValuesFor = async (names) => {
        const out = {};
        const needGemini = [];
        for (const name of names) {
          if (isMpnAspect(name)) {
            const mpn = safeString(product?.identification?.mpn) || safeString(product?.details?.attributes?.Herstellernummer);
            if (mpn) { out[name] = mpn; continue; }
          }
          needGemini.push(name);
        }
        if (needGemini.length) {
          const ident = product?.identification || {};
          const attrs = product?.details?.attributes || {};
          const ctx = [
            `Titel: ${safeString(ident.name)}`,
            `Marke: ${safeString(ident.brand) || '-'}`,
            `Kategorie: ${safeString(ident.category) || '-'}`,
            `Attribute: ${Object.entries(attrs).slice(0, 25).map(([k, v]) => `${k}=${String(v).slice(0, 50)}`).join('; ')}`,
          ].join('\n');
          const prompt = [
            'Du bist eBay-Listing-Experte. Generiere kurze, korrekte Werte für fehlende eBay-Pflichtmerkmale.',
            'Die Merkmalnamen sind ggf. französisch (BEFR-Site) — antworte mit EXAKT diesen Schlüsseln, Werte in der Produktsprache (kurz, 1-3 Wörter).',
            '',
            'Produkt:',
            ctx,
            '',
            'Fehlende Pflicht-Merkmale:',
            needGemini.map((n) => `- ${n}`).join('\n'),
            '',
            'Antworte NUR mit JSON: {"Merkmalname":"Wert", ...}. Nicht ableitbare Merkmale weglassen statt raten.',
          ].join('\n');
          try {
            const raw = await gemini3GenerateText({ prompt, temperature: 0.2, maxOutputTokens: 2048, timeoutMs: 25000 });
            const jsonMatch = String(raw || '').match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              for (const [k, v] of Object.entries(parsed || {})) {
                const value = safeString(v);
                if (value && value.length <= 80) out[k] = value;
              }
            }
          } catch (err) {
            console.warn(`[ebay-fix-weights] Gemini-Fehler ${fail.sku}: ${err?.message}`);
          }
        }
        return out;
      };

      const generated = await generateValuesFor(missing);
      const unresolvedRequired = missing.filter((n) => !Object.keys(generated).some((k) => k.toLowerCase() === n.toLowerCase()));
      if (unresolvedRequired.length && !isSystemError) {
        results.push({ productId: product.id, sku: fail.sku, status: 'skipped_gemini_no_value', missing: unresolvedRequired });
        continue;
      }

      if (!args.apply) {
        results.push({ productId: product.id, sku: fail.sku, itemId: fail.itemId, status: 'would_fix', missing, generated });
        continue;
      }

      // 3. GetItem + Union + Revise — mit Retry-Schleife: eBay meldet pro
      // Revise nur das ERSTE fehlende Pflicht-Merkmal; Listings mit mehreren
      // Lücken brauchen akkumulierende Versuche (alles-oder-nichts-Revise).
      const liveItem = (await getItemDetails(fail.itemId))?.item || null;
      if (safeString(liveItem?.listingStatus) !== 'Active') {
        results.push({ productId: product.id, sku: fail.sku, itemId: fail.itemId, status: 'skipped_not_active', listingStatus: liveItem?.listingStatus || null });
        continue;
      }
      const localSpecifics = mapProductToEbayItem(product)?.itemSpecifics || {};
      let response = null;
      let lastReviseError = null;
      let sentCount = 0;
      const MAX_ASPECT_ROUNDS = 5;
      for (let round = 0; round < MAX_ASPECT_ROUNDS; round += 1) {
        const merged = mergeSpecificsWithRequired(generated, localSpecifics, liveItem?.itemSpecifics || {});
        sentCount = Object.keys(merged).length;
        try {
          response = await reviseFixedPriceItem({ itemId: fail.itemId, itemSpecifics: merged });
          lastReviseError = null;
          break;
        } catch (err) {
          lastReviseError = err;
          const moreMissing = extractMissingAspectNamesFr(err?.message)
            .concat(extractMissingAspectNames([safeString(err?.message)]))
            .filter((n) => !Object.keys(generated).some((k) => k.toLowerCase() === n.toLowerCase()));
          if (!moreMissing.length) break;
          const moreValues = await generateValuesFor(moreMissing);
          const stillMissing = moreMissing.filter((n) => !Object.keys(moreValues).some((k) => k.toLowerCase() === n.toLowerCase()));
          if (stillMissing.length) break;
          Object.assign(generated, moreValues);
          await sleep(REVISE_DELAY_MS);
        }
      }
      if (lastReviseError) throw lastReviseError;

      // 4. Generierte Pflicht-Aspects additiv ins Datenblatt.
      if (Object.keys(generated).length) {
        product.details = product.details || {};
        product.details.attributes = product.details.attributes || {};
        for (const [k, v] of Object.entries(generated)) {
          if (product.details.attributes[k] == null || String(product.details.attributes[k]).trim() === '') {
            product.details.attributes[k] = v;
          }
        }
        await saveProductV2(product, {
          source: 'script:ebay-fix-weight-failures',
          overwriteTextFields: false,
          replaceAttributes: false,
          allowCategoryChange: false,
          allowWarehouseFields: false,
          skipTitlePolicy: true,
          skipKeyFeaturesNormalize: true,
        });
      }

      results.push({ productId: product.id, sku: fail.sku, itemId: fail.itemId, status: 'fixed', generated, ack: response?.ack || null, specificsSent: sentCount });
      console.log(`[ebay-fix-weights] OK itemId=${fail.itemId} sku=${fail.sku || '-'} +${Object.keys(generated).map((k) => `${k}=${generated[k]}`).join(',') || 'retry'} ack=${response?.ack || '?'} (${processed}/${todo.length})`);
    } catch (err) {
      errors.push({ productId: fail.productId, sku: fail.sku, itemId: fail.itemId, error: err?.message || String(err) });
      console.warn(`[ebay-fix-weights] FEHLER sku=${fail.sku || '-'}: ${err?.message}`);
    }
  }

  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const report = {
    script: 'ebay-fix-weight-failures',
    mode: args.apply ? 'apply' : 'dry-run',
    startedAt,
    finishedAt: new Date().toISOString(),
    counts: { todo: todo.length, byStatus, errors: errors.length },
    results,
    errors,
  };
  const outFile = path.join(args.outDir, `ebay-fix-weight-failures-${startedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`[ebay-fix-weights] Fertig — ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(', ') || '-'} errors=${errors.length}`);
  console.log(`[ebay-fix-weights] Report: ${outFile}`);
  if (errors.length) process.exitCode = 1;
}

module.exports = {
  parseArgs,
  extractMissingAspectNamesFr,
  isMpnAspect,
  mergeSpecificsWithRequired,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`[ebay-fix-weights] Abbruch: ${err?.message}`, err);
    process.exitCode = 1;
  });
}
