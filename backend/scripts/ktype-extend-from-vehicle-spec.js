/* eslint-disable no-console */
/**
 * K-Typ aus der Fahrzeugnennung ERWEITERN + HSN/TSN-Muell aus Vergleichsnummer-Attributen raeumen.
 *
 * Hintergrund (Vorfall 2026-08-21, SKU-7093518261, Airbag-Steuergeraet Audi Q7 4M + Q8):
 * - Das K-Typ-Feld trug 5 von ~44 MVL-Fahrzeugen. Der HSN/TSN-Beleg-Weg ist eine
 *   Lupe (jede Schluesselnummer = EINE Homologation); die ganze Baureihe steht als
 *   make+model+platform+period direkt in der MVL. resolveKTypFromVehicleSpec()
 *   (lib/ktype-enrichment.js) schlaegt sie deterministisch nach — kein Raten,
 *   nur echte MVL-Treffer, Generations-Beleg (Plattform-Token/Baujahr) ist Pflicht.
 * - Beim Vorfall 2026-08-17 legte das Modell HSN/TSN-Listen unter erfundenen
 *   Merkmalen "Vergleichsnummer"/"Vergleichsnummer 2..4" ab. Diese Werte sind
 *   KEINE Vergleichsnummern und wuerden beim naechsten Revise als sinnlose
 *   ItemSpecifics zu eBay gehen. --clean-hsntsn-attrs entfernt exakt solche
 *   Eintraege (nur Vergleichsnummer*-Schluessel, nur wenn der Wert nach Abzug
 *   der Schluesselnummern-Paare keinen Inhalt mehr hat — echte OE-Listen bleiben).
 *
 * Verhalten:
 * - K-Typ wird NUR erweitert (Union, Bestand hat Vorrang) — nie gekuerzt/ersetzt.
 * - Schreibweg K-Typ: saveProductV2 (mode system). Das Entfernen der Muell-Schluessel
 *   geht als gezieltes FieldValue.delete() direkt auf das Dokument, weil der
 *   saveProductV2-Merge Map-Schluessel bauartbedingt nicht loeschen kann
 *   (Praezedenzfall: ktype->K-Typ-Repair 2026-07-10). Es trifft ausschliesslich
 *   Attribut-EINTRAEGE (Daten), keine Schema-Felder.
 * - Dry-run ist Default. --apply ohne --sku verlangt --confirm EXTEND_ALL.
 *
 * Usage:
 *   USE_PRODUCTS_V2=true TENANT_ID=default node backend/scripts/ktype-extend-from-vehicle-spec.js
 *   USE_PRODUCTS_V2=true TENANT_ID=default node backend/scripts/ktype-extend-from-vehicle-spec.js \
 *     --sku SKU-7093518261 --clean-hsntsn-attrs --apply
 */

process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';

const { getAllProductsForTenant, firestore } = require('../lib/firestore');
const { getVehicleFitmentMode } = require('../lib/vehicle-fitment');
const { loadMvlIndex, resolveKTypFromVehicleSpec, buildExtendedKTypValue } = require('../lib/ktype-enrichment');
const { saveProductV2 } = require('../lib/product-store');
const { FieldValue } = require('firebase-admin/firestore');

// Scripts-only default per CLAUDE.md; Prod-Daten liegen unter TENANT_ID=default.
const TENANT_ID = process.env.TENANT_ID || 'avycloud';

function argFlag(name) {
  return process.argv.includes(name);
}
function argValue(name, fallback = null) {
  const idx = process.argv.findIndex((x) => x === name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}
function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function parseKTypIds(raw) {
  return Array.from(
    new Set(
      safeString(raw)
        .split(/[|,;]+/)
        .map((x) => safeString(x))
        .filter((x) => /^\d+$/.test(x))
        .map(Number)
    )
  );
}

/**
 * Ein Attributwert ist HSN/TSN-Muell, wenn er Schluesselnummern-Paare enthaelt
 * und nach deren Abzug (plus Labels/Klammern) kein tragender Inhalt uebrig
 * bleibt. Echte Vergleichsnummern-Listen (OE-Nummern, lange Alnum-Tokens)
 * bleiben unangetastet — im Zweifel behalten.
 */
function isHsnTsnJunkValue(value) {
  const s = safeString(value);
  if (!s) return false;
  const pairs = s.match(/\b\d{4}\s*\/\s*[A-Z0-9]{3}\b/gi) || [];
  if (!pairs.length) return false;
  let rest = s.replace(/\b\d{4}\s*\/\s*[A-Z0-9]{3}\b/gi, ' ');
  rest = rest.replace(/\bHSN\b|\bTSN\b|Schl(?:ü|ue)sselnummern?/gi, ' ');
  rest = rest.replace(/\([^)]*\)/g, ' ');
  const tokens = rest.match(/[A-Za-z0-9]{5,}/g) || [];
  return tokens.length === 0;
}

function findJunkAttrKeys(product) {
  const attrs = product?.details?.attributes;
  if (!attrs || typeof attrs !== 'object') return [];
  return Object.keys(attrs).filter((k) => {
    const norm = safeString(k).toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!norm.startsWith('vergleichsnummer')) return false;
    return isHsnTsnJunkValue(attrs[k]);
  });
}

async function main() {
  const APPLY = argFlag('--apply');
  const CLEAN = argFlag('--clean-hsntsn-attrs');
  const skuFilter = safeString(argValue('--sku', ''));
  const limit = Math.max(1, parseInt(argValue('--limit', '1000') || '1000', 10));
  const confirm = safeString(argValue('--confirm', ''));

  if (APPLY && !skuFilter && confirm !== 'EXTEND_ALL') {
    console.error('SICHERHEIT: --apply ohne --sku verlangt --confirm EXTEND_ALL (Massen-Schreiben ist eine Operator-Entscheidung).');
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        action: 'ktype-extend-from-vehicle-spec',
        project: process.env.GOOGLE_CLOUD_PROJECT,
        tenant: TENANT_ID,
        dryRun: !APPLY,
        cleanHsnTsnAttrs: CLEAN,
        sku: skuFilter || null,
        limit,
      },
      null,
      2
    )
  );

  const mvl = await loadMvlIndex();
  if (!mvl?.ok) {
    console.error('MVL nicht ladbar:', mvl?.reason, mvl?.gcsUri || '');
    process.exit(1);
  }
  console.log(`MVL geladen: ${mvl.parsed} Zeilen (${mvl.jsonlPath})`);

  const all = await getAllProductsForTenant(TENANT_ID);
  const candidates = (all || []).filter((p) => {
    if (!p?.id) return false;
    if (skuFilter) {
      const sku = safeString(p?.identification?.sku) || safeString(p?.details?.identifiers?.sku);
      if (sku !== skuFilter) return false;
    }
    const catId = safeString(p?.details?.categoryId) || safeString(p?.details?.ebayCategoryId);
    return Boolean(catId && getVehicleFitmentMode(catId) === 'auto');
  });

  console.log(`Kandidaten (Auto-Fitment-Kategorie${skuFilter ? `, SKU=${skuFilter}` : ''}): ${candidates.length}`);

  const stats = { checked: 0, extendable: 0, extended: 0, junkFound: 0, junkCleaned: 0, errors: 0 };
  const samples = [];

  for (const product of candidates.slice(0, limit)) {
    stats.checked += 1;
    try {
      const before = parseKTypIds(product?.details?.attributes?.['K-Typ']);
      const res = resolveKTypFromVehicleSpec(product, { mvl, maxKTypes: 60 });
      const junkKeys = CLEAN ? findJunkAttrKeys(product) : [];
      if (junkKeys.length) stats.junkFound += 1;

      // Format-erhaltend erweitern: Eintraege koennen Notizen tragen
      // ("113153,Audi Q7") — buildExtendedKTypValue haengt neue IDs nur an,
      // statt den Wert neu zu formatieren (sonst Datenverlust, Punkt 16).
      const ext =
        res.ok && res.ids?.length
          ? buildExtendedKTypValue(product?.details?.attributes?.['K-Typ'], res.ids, 60)
          : { value: safeString(product?.details?.attributes?.['K-Typ']), added: 0, total: before.length };

      if (!ext.added && !junkKeys.length) continue;
      if (ext.added) stats.extendable += 1;

      const sku = safeString(product?.identification?.sku) || product.id;
      samples.push({
        sku,
        before: before.length,
        after: ext.total,
        added: ext.added,
        matched: res.ok ? res.matched : res.reason,
        junkKeys,
      });

      if (!APPLY) continue;

      if (ext.added) {
        product.details = product.details || {};
        product.details.attributes =
          product.details.attributes && typeof product.details.attributes === 'object'
            ? product.details.attributes
            : {};
        product.details.attributes['K-Typ'] = ext.value;
        // Veraltete "K-Typ fehlt/nicht angereichert"-Warnungen stimmen ab jetzt
        // nicht mehr — mit rausschreiben (gleiche Muster wie clearKTypWarnings).
        if (Array.isArray(product?.notes?.warnings)) {
          product.notes.warnings = product.notes.warnings.filter(
            (w) => !/^K-Typ (nicht angereichert:|konnte|fehlt:)/i.test(safeString(w))
          );
        }
        await saveProductV2(product, { mode: 'system', source: 'ktype-vehicle-spec-extend' });
        stats.extended += 1;
      }
      if (junkKeys.length) {
        const updates = {};
        for (const k of junkKeys) updates[`details.attributes.${k}`] = FieldValue.delete();
        await firestore.collection('products_v2').doc(product.id).update(updates);
        stats.junkCleaned += 1;
      }
    } catch (err) {
      stats.errors += 1;
      console.error(`Fehler bei ${product?.id}:`, err?.message || err);
    }
  }

  console.log(JSON.stringify({ stats, samples: samples.slice(0, 40) }, null, 2));
  if (!APPLY) console.log('DRY-RUN — nichts geschrieben. Mit --apply anwenden.');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
