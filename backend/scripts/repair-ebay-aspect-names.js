#!/usr/bin/env node
'use strict';

/**
 * Nachziehlauf: Artikelmerkmale LAUFENDER eBay-Angebote so benennen, dass eBay sie
 * als Suchfilter erkennt.
 *
 * HINTERGRUND
 * 52,4 % der gesendeten Merkmalsnamen kennt eBay in der Zielkategorie nicht. Solche
 * Merkmale stehen zwar im Angebot, erzeugen aber KEINEN Filter in der Suchleiste —
 * die Pflegearbeit verpufft. Der Schalter EBAY_ASPECT_REPAIR sorgt dafuer, dass
 * kuenftige Publishes/Revises sauber rausgehen. Dieses Skript zieht den BESTAND nach.
 *
 * DIE GEFAEHRLICHSTE EIGENSCHAFT VON EBAY HIER
 * `ReviseFixedPriceItem` ERSETZT die komplette Merkmalsliste, wenn der ItemSpecifics-
 * Container mitgeschickt wird ("complete replace of the item's Item Specific values").
 * Ein Teil-Patch wuerde also Merkmale LOESCHEN. Deshalb wird immer die VEREINIGTE
 * Liste gesendet (lokal + live), exakt nach dem Muster aus scripts/ebay-push-weights.js,
 * das im Juli 663 von 665 Angeboten fehlerfrei geaendert hat.
 *
 * SICHERHEIT
 *  - DRY RUN per Default. Aenderungen nur mit --apply.
 *  - GetItem VOR jedem Revise: der Spiegel luegt (bekannt aus dem Gewichts-Backfill).
 *  - Es wird NUR revidiert, wenn sich die Merkmalsliste wirklich aendert.
 *  - Minimal-Patch: nur itemId + ItemSpecifics. Titel, Preis, Menge, Bilder und
 *    Beschreibung werden NICHT mitgesendet (Best-Offer-Schwelle und Bestand sicher).
 *  - Fehler beenden NIE ein Listing (CLAUDE.md Punkt 14) — sie werden gezaehlt,
 *    protokolliert und der Lauf geht weiter.
 *  - Kontingent: harte Obergrenze je Lauf, Abbruch bei aktivem Quota-Cooldown.
 *  - Fortsetzbar: Fortschritt in Firestore (ops/aspectRepairBackfill).
 *
 * AUFRUF
 *   node backend/scripts/repair-ebay-aspect-names.js                 # Trockenlauf, 50 Angebote
 *   node backend/scripts/repair-ebay-aspect-names.js --limit 200     # Trockenlauf, mehr
 *   node backend/scripts/repair-ebay-aspect-names.js --limit 200 --apply
 *   node backend/scripts/repair-ebay-aspect-names.js --site 77 --apply    # nur DE
 *   node backend/scripts/repair-ebay-aspect-names.js --reset          # Fortschritt loeschen
 */

process.env.USE_PRODUCTS_V2 = process.env.USE_PRODUCTS_V2 || 'true';

const { parseApplyArgs } = require('./_apply-guard');
const { firestore } = require('../lib/firestore');
const { getCategoryAspectCatalog } = require('../lib/ebay-taxonomy');
const { repairAspectsForCategory } = require('../lib/ebay-aspect-repair');
const { filterPatchItemSpecificsForListing } = require('../lib/ebay-direct');
const {
  getItemDetails,
  reviseFixedPriceItem,
  ebayQuotaCooldownActive,
  ebayQuotaCooldownRemainingMs,
} = require('../lib/ebay-trading-api');

const PROGRESS_DOC = 'ops/aspectRepairBackfill';
const MAX_ASPECTS = 45;

function argValue(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v === undefined ? fallback : v;
}

function safeString(v) {
  return v === null || v === undefined ? '' : String(v);
}

/**
 * Vereinigte Merkmalsliste: lokale Werte gewinnen, live vorhandene Merkmale bleiben
 * erhalten. Ohne diese Vereinigung wuerde eBay alles loeschen, was nicht mitgesendet wird.
 */
function mergeSpecificsUnion(local, live) {
  const l = local && typeof local === 'object' ? local : {};
  const r = live && typeof live === 'object' ? live : {};
  const out = {};
  for (const [k, v] of Object.entries(l)) {
    if (Object.keys(out).length >= MAX_ASPECTS) break;
    if (v === null || v === undefined || safeString(v).trim() === '') continue;
    out[k] = v;
  }
  const lower = new Set(Object.keys(out).map((k) => k.toLowerCase()));
  let dropped = 0;
  for (const [k, v] of Object.entries(r)) {
    if (lower.has(k.toLowerCase())) continue;
    if (Object.keys(out).length >= MAX_ASPECTS) { dropped += 1; continue; }
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  return { specifics: out, dropped };
}

/** Stabiler Vergleich zweier Merkmalslisten (Reihenfolge egal). */
function specificsSignature(map) {
  const obj = map && typeof map === 'object' ? map : {};
  return Object.keys(obj)
    .sort()
    .map((k) => `${k}=${Array.isArray(obj[k]) ? obj[k].join('|') : safeString(obj[k])}`)
    .join('');
}

async function loadProgress() {
  try {
    const snap = await firestore.doc(PROGRESS_DOC).get();
    return snap.exists ? snap.data() || {} : {};
  } catch (_) {
    return {};
  }
}

async function saveProgress(patch) {
  try {
    await firestore.doc(PROGRESS_DOC).set(
      { ...patch, updatedAt: new Date().toISOString() },
      { merge: true }
    );
  } catch (err) {
    console.warn('[fortschritt] konnte nicht gespeichert werden:', err.message);
  }
}

async function main() {
  const { apply, tenant, argv } = parseApplyArgs();
  const limit = Math.max(1, Number(argValue(argv, '--limit', '50')) || 50);
  const siteFilter = argValue(argv, '--site', null);
  const reset = argv.includes('--reset');

  if (reset) {
    await firestore.doc(PROGRESS_DOC).set({ done: [], updatedAt: new Date().toISOString() });
    console.log('Fortschritt zurueckgesetzt.');
    return;
  }

  const progress = await loadProgress();
  const erledigt = new Set(Array.isArray(progress.done) ? progress.done : []);
  console.log(`Bereits erledigt in frueheren Laeufen: ${erledigt.size} Angebote`);

  if (ebayQuotaCooldownActive()) {
    console.error(
      `ABBRUCH: eBay-Kontingent gesperrt, noch ${Math.ceil(ebayQuotaCooldownRemainingMs() / 1000)} s. `
      + 'Spaeter erneut starten.'
    );
    process.exitCode = 3;
    return;
  }

  // Aktive Angebote holen. Der Spiegel dient NUR der Auswahl — die Wahrheit kommt
  // gleich per GetItem.
  let query = firestore.collection('ebayListingsLive').where('active', '==', true);
  const snap = await query.get();
  console.log(`Aktive Angebote im Spiegel: ${snap.size}`);

  const kandidaten = [];
  snap.forEach((doc) => {
    const d = doc.data();
    const itemId = safeString(d.itemId || doc.id).trim();
    if (!itemId || erledigt.has(itemId)) return;
    if (siteFilter && safeString(d.siteId) && safeString(d.siteId) !== safeString(siteFilter)) return;
    kandidaten.push({ itemId, sku: safeString(d.sku).trim(), siteId: safeString(d.siteId) });
  });
  console.log(`Zu pruefende Angebote: ${kandidaten.length} (dieser Lauf: max ${limit})`);

  // Produkte je SKU vorladen (ein Durchlauf statt N Einzelabfragen).
  const produkte = new Map();
  const pSnap = await firestore
    .collection('products_v2')
    .where('tenantId', '==', tenant)
    .get();
  pSnap.forEach((doc) => {
    const d = doc.data();
    const sku = safeString(d?.identification?.sku || d?.details?.identifiers?.sku).trim();
    if (sku) produkte.set(sku, d);
  });
  console.log(`Produkte geladen: ${produkte.size}`);

  const stat = {
    geprueft: 0, uebersprungenOhneProdukt: 0, uebersprungenOhneAenderung: 0,
    geaendert: 0, fehler: 0, apiCalls: 0,
  };
  const beispiele = [];
  const fehler = [];
  const zuLang = [];
  const neuErledigt = [];

  for (const k of kandidaten) {
    if (stat.geprueft >= limit) break;
    if (ebayQuotaCooldownActive()) {
      console.warn('[abbruch] Kontingent-Sperre waehrend des Laufs — sauberer Stopp.');
      break;
    }

    const produkt = k.sku ? produkte.get(k.sku) : null;
    if (!produkt) { stat.uebersprungenOhneProdukt += 1; continue; }

    stat.geprueft += 1;

    let live;
    try {
      live = await getItemDetails(k.itemId);
      stat.apiCalls += 1;
    } catch (err) {
      stat.fehler += 1;
      fehler.push({ itemId: k.itemId, phase: 'GetItem', message: err.message });
      continue;
    }

    const liveSpecifics = live?.item?.itemSpecifics || live?.itemSpecifics || {};
    const liveCategoryId =
      safeString(live?.item?.primaryCategoryId || live?.primaryCategoryId).trim()
      || safeString(produkt?.details?.categoryId).trim();
    if (!liveCategoryId) { stat.uebersprungenOhneAenderung += 1; continue; }

    const rohLokal = produkt?.details?.attributes && typeof produkt.details.attributes === 'object'
      ? produkt.details.attributes
      : {};
    // DENSELBEN Filter nutzen wie der Sendepfad. Ohne ihn gehen technische Schluessel
    // mit an eBay — "Kategorie" mit dem vollen Pfad und "K-Typ" mit einer langen
    // Nummernliste — und eBay lehnt den gesamten Revise ab
    // ("Wert ist zu lang, maximal 65 Zeichen"). Genau daran sind im ersten scharfen
    // Lauf 5 von 10 Angeboten gescheitert.
    const gefiltert = filterPatchItemSpecificsForListing({
      categoryId: liveCategoryId,
      listing: { primaryCategoryId: liveCategoryId },
      itemSpecifics: rohLokal,
    });
    const lokal = gefiltert?.itemSpecifics || {};
    const merged = mergeSpecificsUnion(lokal, liveSpecifics);
    // Letzte Sicherung: eBay kappt Merkmalswerte bei 65 Zeichen. Ein zu langer Wert
    // laesst den GANZEN Revise scheitern, nicht nur das eine Merkmal.
    for (const [k, v] of Object.entries(merged.specifics)) {
      const s = Array.isArray(v) ? v.map(safeString) : [safeString(v)];
      if (s.some((x) => x.length > 65)) {
        delete merged.specifics[k];
        zuLang.push(`${k} (${s[0].length} Zeichen)`);
      }
    }

    // Aufbereiten gegen die LIVE-Kategorie — die entscheidet bei eBay, nicht unsere.
    const repariert = repairAspectsForCategory({
      categoryId: liveCategoryId,
      itemSpecifics: merged.specifics,
      catalogAspectNames: getCategoryAspectCatalog(liveCategoryId),
      mode: 'on',
    });

    const vorher = specificsSignature(liveSpecifics);
    const nachher = specificsSignature(repariert.itemSpecifics);
    if (vorher === nachher) {
      stat.uebersprungenOhneAenderung += 1;
      neuErledigt.push(k.itemId);
      continue;
    }

    if (beispiele.length < 8) {
      beispiele.push({
        itemId: k.itemId, sku: k.sku, kategorie: liveCategoryId,
        aenderungen: repariert.aenderungen.slice(0, 6),
      });
    }

    if (!apply) {
      stat.geaendert += 1;
      continue;
    }

    try {
      // MINIMAL-Patch: nur itemId + ItemSpecifics. Kein Titel, kein Preis, keine Menge,
      // keine Bilder — sonst wuerde der Lauf Preise/Bestand/Bildbasis mit anfassen.
      await reviseFixedPriceItem({ itemId: k.itemId, itemSpecifics: repariert.itemSpecifics });
      stat.apiCalls += 1;
      stat.geaendert += 1;
      neuErledigt.push(k.itemId);
    } catch (err) {
      // NIE destruktiv reagieren (CLAUDE.md Punkt 14): zaehlen, merken, weitermachen.
      stat.fehler += 1;
      fehler.push({ itemId: k.itemId, phase: 'Revise', message: err.message });
    }
  }

  if (apply && neuErledigt.length) {
    const alle = [...erledigt, ...neuErledigt];
    await saveProgress({ done: alle, lastRunAt: new Date().toISOString(), lastRunCount: neuErledigt.length });
  }

  console.log('');
  console.log('=== ERGEBNIS ===');
  console.log(`Modus:                       ${apply ? 'SCHARF (--apply)' : 'Trockenlauf'}`);
  console.log(`Geprueft:                    ${stat.geprueft}`);
  console.log(`Ohne Aenderung:              ${stat.uebersprungenOhneAenderung}`);
  console.log(`${apply ? 'Geaendert' : 'Wuerden geaendert'}:${apply ? '                   ' : '           '}${stat.geaendert}`);
  console.log(`Ohne passendes Produkt:      ${stat.uebersprungenOhneProdukt}`);
  console.log(`Fehler:                      ${stat.fehler}`);
  console.log(`eBay-Aufrufe verbraucht:     ${stat.apiCalls}`);
  if (zuLang.length) {
    console.log(`Wegen 65-Zeichen-Grenze weggelassen: ${zuLang.length} Merkmale`);
    [...new Set(zuLang)].slice(0, 6).forEach((z) => console.log(`      ${z}`));
  }
  console.log(`Noch offen nach diesem Lauf: ${Math.max(0, kandidaten.length - stat.geprueft)}`);

  if (beispiele.length) {
    console.log('');
    console.log('=== BEISPIELE ===');
    beispiele.forEach((b) => {
      console.log(`  ${b.itemId} (${b.sku}, Kategorie ${b.kategorie})`);
      b.aenderungen.forEach((a) => {
        if (a.art === 'entfernt') console.log(`      entfernt:  ${a.von}  — ${a.grund}`);
        else if (a.art === 'einheit') console.log(`      Einheit:   ${a.von} = "${a.wertVon}"  ->  ${a.nach} = "${a.wertNach}"`);
        else console.log(`      umbenannt: ${a.von}  ->  ${a.nach}`);
      });
    });
  }

  if (fehler.length) {
    console.log('');
    console.log('=== FEHLER (kein Angebot wurde beendet) ===');
    fehler.slice(0, 15).forEach((f) => console.log(`  ${f.itemId} [${f.phase}] ${f.message}`));
    if (fehler.length > 15) console.log(`  … und ${fehler.length - 15} weitere`);
  }

  if (!apply && stat.geaendert > 0) {
    console.log('');
    console.log('Nichts wurde geaendert. Fuer den scharfen Lauf: --apply anhaengen.');
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
