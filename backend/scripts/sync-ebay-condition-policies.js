'use strict';
/**
 * sync-ebay-condition-policies.js — holt die erlaubten Artikelzustaende je
 * eBay-Kategorie und legt sie als kompakte Repo-Datei ab.
 *
 * WARUM DIESES SKRIPT EXISTIERT:
 *   Der klassische Trading-Call GetCategoryFeatures ist abgeschaltet (HTTP 410
 *   Gone, gemessen 2026-08-10). Gueltig ist die REST-Metadata-API
 *   getItemConditionPolicies. Ohne diese Daten kann das Datenblatt nicht
 *   wissen, welche Zustaende eine Kategorie ueberhaupt zulaesst — und wie sie
 *   dort heissen. Denn beides haengt an der Kategorie: ConditionID 1000 heisst
 *   meistens "Neu", in Bekleidungs-Kategorien aber "Neu mit Etikett".
 *
 * STRIKT READ-ONLY gegen eBay (ein GET). Schreibt nur die JSON-Datei.
 *
 * Usage:
 *   node scripts/sync-ebay-condition-policies.js            # schreibt die Datei
 *   node scripts/sync-ebay-condition-policies.js --dry-run  # nur Statistik
 *
 * Env: GOOGLE_CLOUD_PROJECT=avycloud (fuer den OAuth-Token aus Firestore)
 */

const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, '..', 'ebay-data', 'condition-policies-de.json');
const MARKETPLACE = 'EBAY_DE';

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const { getValidEbayAccessToken } = require('../lib/ebay-oauth');
  const { accessToken } = await getValidEbayAccessToken();
  if (!accessToken) throw new Error('Kein eBay-Access-Token verfuegbar');

  const url = `https://api.ebay.com/sell/metadata/v1/marketplace/${MARKETPLACE}/get_item_condition_policies`;
  console.log(`[sync-conditions] GET ${url}`);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Accept-Language': 'de-DE' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const policies = Array.isArray(data.itemConditionPolicies) ? data.itemConditionPolicies : [];
  if (!policies.length) throw new Error('Antwort enthaelt keine itemConditionPolicies');

  // Kompaktierung: ueber alle Kategorien gibt es nur eine Handvoll verschiedener
  // Zustands-Sets (2026-08-10: 27 bei 14.917 Kategorien). Statt jede Kategorie
  // ihre Liste tragen zu lassen, wird jedes Set einmal abgelegt und je Kategorie
  // nur der Index gespeichert. Das druckt die Datei von ~5 MB auf ~215 KB.
  const setIndexByKey = new Map();
  const sets = [];
  const cats = {};

  policies.forEach((policy) => {
    const conditions = Array.isArray(policy.itemConditions) ? policy.itemConditions : [];
    const pairs = conditions
      .map((c) => [Number(c.conditionId), String(c.conditionDescription || '')])
      .filter(([id]) => Number.isFinite(id) && id > 0);
    const key = JSON.stringify(pairs);
    let idx = setIndexByKey.get(key);
    if (idx === undefined) {
      idx = sets.length;
      sets.push(pairs);
      setIndexByKey.set(key, idx);
    }
    cats[String(policy.categoryId)] = [idx, policy.itemConditionRequired ? 1 : 0];
  });

  const payload = {
    v: 1,
    marketplace: MARKETPLACE,
    syncedAt: new Date().toISOString(),
    categoryCount: policies.length,
    sets,
    cats,
  };

  const json = JSON.stringify(payload);
  console.log(`[sync-conditions] Kategorien: ${policies.length}`);
  console.log(`[sync-conditions] verschiedene Zustands-Sets: ${sets.length}`);
  console.log(`[sync-conditions] Pflicht-Kategorien: ${policies.filter((p) => p.itemConditionRequired).length}`);
  console.log(`[sync-conditions] Dateigroesse: ${(json.length / 1024).toFixed(1)} KB`);

  if (dryRun) {
    console.log('[sync-conditions] --dry-run: nichts geschrieben');
    return;
  }

  fs.writeFileSync(OUT_FILE, json);
  console.log(`[sync-conditions] geschrieben: ${OUT_FILE}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[sync-conditions] FEHLER: ${err.message}`);
    process.exit(1);
  });
