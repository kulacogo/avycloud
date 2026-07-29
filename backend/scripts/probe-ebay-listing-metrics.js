'use strict';
/**
 * probe-ebay-listing-metrics.js — READ-ONLY Mess-Sonde (2026-07-29)
 *
 * FRAGE, die dieses Skript beantwortet:
 *   Liefert die eBay Trading API die Erfolgszahlen je Angebot — Beobachter
 *   (WatchCount), Aufrufe (HitCount) und verkaufte Menge
 *   (SellingStatus.QuantitySold) — überhaupt? Und wenn ja: über welchen Aufruf?
 *
 * HINTERGRUND: In allen ~4.828 Dokumenten der Spiegel-Collection
 * `ebayListingsLive` fehlen diese Zahlen. Ohne sie lässt sich nicht
 * unterscheiden, ob ein Angebot gar nicht gefunden wird oder gefunden und
 * verschmäht. Der geplante Weg lautet: "GetMyeBaySelling mit
 * DetailLevel=ReturnAll liefert die Felder mit". Das ist eine UNGEPRÜFTE
 * ANNAHME. Dieses Skript prüft sie — es baut nicht darauf auf.
 *
 * STRIKT READ-ONLY:
 *   - eBay: NUR GetItem und GetMyeBaySelling. Keine Revise/End/Add/Relist-Calls.
 *   - Firestore: NUR .get(). Kein set/update/delete.
 *   - Kein --apply, keine Mutation, kein Schreiben irgendwo.
 *
 * QUOTA: Standard-Limit 5 Angebote → 5 (+1) GetItem + 2 GetMyeBaySelling ≈ 8
 * Trading-Calls. `ebayQuotaCooldownActive()` wird respektiert: bei offenem
 * Breaker bricht das Skript ab, ohne eBay anzufassen.
 *
 * Usage:
 *   node scripts/probe-ebay-listing-metrics.js
 *   node scripts/probe-ebay-listing-metrics.js --limit 10
 *   node scripts/probe-ebay-listing-metrics.js --item 123456789012 --item 987654321098
 *   node scripts/probe-ebay-listing-metrics.js --no-selling      # nur GetItem
 *   node scripts/probe-ebay-listing-metrics.js --json            # Rohbefund als JSON
 *
 * Env: GOOGLE_CLOUD_PROJECT=avycloud (für den Firestore-Stichprobenzug)
 */

const EBAY_LISTINGS_COLLECTION = 'ebayListingsLive';

// ── Argumente ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    limit: 5,
    items: [],
    selling: true,
    json: false,
    watchProbe: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i] || '');
    if (a === '--limit') {
      const n = parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0) args.limit = Math.min(n, 50);
    } else if (a.startsWith('--limit=')) {
      const n = parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) args.limit = Math.min(n, 50);
    } else if (a === '--item') {
      const v = String(argv[++i] || '').trim();
      if (v) args.items.push(v);
    } else if (a.startsWith('--item=')) {
      const v = a.slice('--item='.length).trim();
      if (v) args.items.push(v);
    } else if (a === '--no-selling') {
      args.selling = false;
    } else if (a === '--no-watchcount-probe') {
      args.watchProbe = false;
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    }
  }
  return args;
}

// ── Feld-Katalog: genau das, was für Ranking/Conversion fehlt ───────────────

const PROBE_FIELDS = [
  { label: 'WatchCount', paths: ['WatchCount', 'ListingDetails.WatchCount'] },
  { label: 'HitCount', paths: ['HitCount', 'ListingDetails.HitCount'] },
  { label: 'SellingStatus.QuantitySold', paths: ['SellingStatus.QuantitySold'] },
  { label: 'QuestionCount', paths: ['QuestionCount'] },
  { label: 'PrimaryCategory.CategoryID', paths: ['PrimaryCategory.CategoryID'] },
  { label: 'ListingStatus', paths: ['SellingStatus.ListingStatus', 'ListingStatus'] },
  { label: 'EndTime', paths: ['ListingDetails.EndTime', 'EndTime'] },
  { label: 'ListingDetails.StartTime', paths: ['ListingDetails.StartTime', 'StartTime'] },
];

function getPath(obj, path) {
  let cur = obj;
  for (const key of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  // fast-xml-parser packt Attribut-Knoten als { '#text': ... }
  if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, '#text')) {
    return cur['#text'];
  }
  return cur;
}

function presentValue(node, field) {
  for (const p of field.paths) {
    const v = getPath(node, p);
    if (v !== undefined && v !== null && String(v) !== '') {
      return { present: true, path: p, value: v };
    }
  }
  return { present: false, path: null, value: undefined };
}

/**
 * Sammelt die tatsächlich gelieferten Feldnamen eines Item-Knotens.
 * Wichtig, weil "Feld fehlt" zwei Ursachen haben kann: der Aufruf liefert den
 * Block gar nicht — oder eBay lässt das Element bei Wert 0 einfach weg.
 */
function collectKeys(nodes) {
  const top = new Set();
  const sellingStatus = new Set();
  const listingDetails = new Set();
  for (const node of nodes) {
    Object.keys(node || {}).forEach((k) => top.add(k));
    Object.keys((node && node.SellingStatus) || {}).forEach((k) => sellingStatus.add(k));
    Object.keys((node && node.ListingDetails) || {}).forEach((k) => listingDetails.add(k));
  }
  return {
    top: Array.from(top).sort(),
    sellingStatus: Array.from(sellingStatus).sort(),
    listingDetails: Array.from(listingDetails).sort(),
  };
}

/** Wertet eine Menge von Item-Knoten aus: in wie vielen kam das Feld an? */
function evaluateNodes(nodes, label) {
  const rows = {};
  for (const field of PROBE_FIELDS) {
    let hits = 0;
    let samplePath = null;
    let sampleValue;
    for (const node of nodes) {
      const r = presentValue(node, field);
      if (r.present) {
        hits++;
        if (samplePath === null) {
          samplePath = r.path;
          sampleValue = r.value;
        }
      }
    }
    rows[field.label] = {
      hits,
      total: nodes.length,
      path: samplePath,
      sample: sampleValue,
    };
  }
  return { label, count: nodes.length, rows, keys: collectKeys(nodes) };
}

function cell(entry) {
  if (!entry || !entry.total) return 'n/a';
  if (!entry.hits) return `— (0/${entry.total})`;
  const sample = entry.sample === undefined ? '' : ` z.B. ${String(entry.sample).slice(0, 22)}`;
  return `ja ${entry.hits}/${entry.total}${sample}`;
}

function renderTable(columns) {
  // columns: [{ title, result|null }, ...]
  const header = ['Feld', ...columns.map((c) => c.title)];
  const body = PROBE_FIELDS.map((f) => [
    f.label,
    ...columns.map((c) => (c.result ? cell(c.result.rows[f.label]) : 'nicht geprüft')),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ');
  const out = [];
  out.push(line(header));
  out.push(widths.map((w) => '-'.repeat(w)).join('-+-'));
  body.forEach((r) => out.push(line(r)));
  return out.join('\n');
}

// ── Firestore-Stichprobe (nur lesend) ──────────────────────────────────────

async function sampleItemIdsFromMirror(limit) {
  const { Firestore } = require('@google-cloud/firestore');
  const db = new Firestore();
  const snap = await db
    .collection(EBAY_LISTINGS_COLLECTION)
    .where('active', '==', true)
    .limit(Math.max(limit * 4, limit))
    .get();
  const ids = [];
  snap.docs.forEach((doc) => {
    const data = doc.data() || {};
    const id = String(data.itemId || doc.id || '').trim();
    if (!id || ids.includes(id)) return;
    ids.push(id);
  });
  return ids.slice(0, limit);
}

// ── eBay-Aufrufe (ausschliesslich lesend) ──────────────────────────────────

function buildGetItemXml(trading, cfg, itemId, { includeWatchCount = false } = {}) {
  const inner = [
    `<ItemID>${trading.escapeXml(itemId)}</ItemID>`,
    '<IncludeItemSpecifics>true</IncludeItemSpecifics>',
    includeWatchCount ? '<IncludeWatchCount>true</IncludeWatchCount>' : '',
    '<DetailLevel>ReturnAll</DetailLevel>',
  ].filter(Boolean).join('\n');
  return trading.buildRequestRoot('GetItem', inner, cfg.userToken, cfg.compatibilityLevel);
}

function buildGetMyeBaySellingXml(trading, cfg, { entriesPerPage, detailLevelReturnAll }) {
  const per = Math.max(2, Math.min(Number(entriesPerPage) || 10, 200));
  const inner = [
    detailLevelReturnAll ? '<DetailLevel>ReturnAll</DetailLevel>' : '',
    `<ActiveList>
  <Include>true</Include>
  <Pagination>
    <EntriesPerPage>${per}</EntriesPerPage>
    <PageNumber>1</PageNumber>
  </Pagination>
</ActiveList>`,
  ].filter(Boolean).join('\n');
  return trading.buildRequestRoot('GetMyeBaySelling', inner, cfg.userToken, cfg.compatibilityLevel);
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// ── Hauptlauf ──────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('probe-ebay-listing-metrics.js — read-only Mess-Sonde für WatchCount/HitCount/QuantitySold.');
    console.log('Optionen: --limit N | --item <id> (mehrfach) | --no-selling | --no-watchcount-probe | --json');
    return 0;
  }

  console.log('[probe] READ-ONLY. Keine Schreib-Calls (kein Revise/End/Add/Relist), keine Firestore-Writes.');

  const trading = require('../lib/ebay-trading-api');

  // 1) Quota-Breaker respektieren — vor jedem eBay-Kontakt.
  if (trading.ebayQuotaCooldownActive()) {
    const secs = Math.ceil(trading.ebayQuotaCooldownRemainingMs() / 1000);
    console.error(`[probe] ABBRUCH: eBay-Quota-Cooldown ist aktiv (noch ~${secs}s). Es wurde KEIN eBay-Aufruf gemacht.`);
    console.error('[probe] Operator: später erneut laufen lassen, wenn der Breaker zu ist.');
    return 3;
  }

  // 2) Zugangsdaten prüfen — sauberer Abbruch statt kryptischem Stacktrace.
  let cfg = null;
  try {
    cfg = await trading.getEbayTradingConfig();
  } catch (err) {
    console.error(`[probe] ABBRUCH: keine eBay-Zugangsdaten verfügbar — ${err.message}`);
    console.error('[probe] Operator: EBAY_TRADING_APP_ID / _DEV_ID / _CERT_ID / _USER_TOKEN als ENV setzen');
    console.error('[probe] oder im Secret Manager hinterlegen (bzw. Lauf in einer Umgebung mit ADC starten).');
    return 2;
  }
  console.log(`[probe] eBay-Umgebung: ${cfg.env}, Site ${cfg.siteId}, Compatibility ${cfg.compatibilityLevel}`);

  // 3) Stichprobe ziehen.
  let itemIds = args.items.slice(0, args.limit);
  if (!itemIds.length) {
    try {
      itemIds = await sampleItemIdsFromMirror(args.limit);
    } catch (err) {
      console.error(`[probe] ABBRUCH: Stichprobe aus ${EBAY_LISTINGS_COLLECTION} nicht lesbar — ${err.message}`);
      console.error('[probe] Operator: GOOGLE_CLOUD_PROJECT=avycloud setzen und ADC bereitstellen,');
      console.error('[probe] oder ItemIDs direkt übergeben: --item <id> --item <id>');
      return 2;
    }
  }
  if (!itemIds.length) {
    console.error(`[probe] ABBRUCH: keine aktiven Angebote in ${EBAY_LISTINGS_COLLECTION} gefunden.`);
    return 2;
  }
  console.log(`[probe] Stichprobe (${itemIds.length}): ${itemIds.join(', ')}`);

  const findings = {
    at: new Date().toISOString(),
    env: cfg.env,
    itemIds,
    getItem: null,
    getItemWatchCountProbe: null,
    selling: null,
    sellingReturnAll: null,
    errors: [],
  };

  // 4) GetItem je ItemID — exakt die Aufruf-Form, die lib/ebay-trading-api.js
  //    heute für getItemDetails() nutzt (DetailLevel=ReturnAll).
  const getItemNodes = [];
  for (const itemId of itemIds) {
    if (trading.ebayQuotaCooldownActive()) {
      console.error('[probe] Quota-Cooldown während des Laufs geöffnet — Abbruch der GetItem-Schleife.');
      findings.errors.push({ stage: 'GetItem', itemId, error: 'quota cooldown opened mid-run' });
      break;
    }
    try {
      const xml = buildGetItemXml(trading, cfg, itemId);
      const res = await trading.callTradingApi('GetItem', xml, {});
      const node = res?.response?.Item;
      if (node) getItemNodes.push(node);
      else findings.errors.push({ stage: 'GetItem', itemId, error: 'kein <Item> im Response' });
    } catch (err) {
      console.error(`[probe] GetItem ${itemId} fehlgeschlagen: ${err.message}`);
      findings.errors.push({ stage: 'GetItem', itemId, error: err.message, code: err.code || null });
      if (err.code === 'EBAY_QUOTA_COOLDOWN' || err.quotaExhausted) break;
    }
  }
  findings.getItem = getItemNodes.length ? evaluateNodes(getItemNodes, 'GetItem') : null;

  // 4b) Zusatzprobe: ändert <IncludeWatchCount>true</IncludeWatchCount> etwas?
  //     Nur EIN Extra-Call, damit die Quota nicht leidet.
  if (args.watchProbe && getItemNodes.length && !trading.ebayQuotaCooldownActive()) {
    const probeId = itemIds[0];
    try {
      const xml = buildGetItemXml(trading, cfg, probeId, { includeWatchCount: true });
      const res = await trading.callTradingApi('GetItem', xml, {});
      const node = res?.response?.Item;
      if (node) findings.getItemWatchCountProbe = evaluateNodes([node], 'GetItem+IncludeWatchCount');
    } catch (err) {
      console.error(`[probe] GetItem+IncludeWatchCount ${probeId} fehlgeschlagen: ${err.message}`);
      findings.errors.push({ stage: 'GetItem+IncludeWatchCount', itemId: probeId, error: err.message });
    }
  }

  // 5) GetMyeBaySelling — ohne und mit DetailLevel=ReturnAll. Genau hier steckt
  //    die offene Frage: kommen WatchCount / QuantitySold mit ReturnAll dazu?
  if (args.selling) {
    const perPage = Math.max(2, Math.min(args.limit, 25));
    for (const variant of [
      { key: 'selling', title: 'GetMyeBaySelling (ohne DetailLevel)', returnAll: false },
      { key: 'sellingReturnAll', title: 'GetMyeBaySelling + ReturnAll', returnAll: true },
    ]) {
      if (trading.ebayQuotaCooldownActive()) {
        console.error(`[probe] Quota-Cooldown aktiv — ${variant.title} übersprungen.`);
        findings.errors.push({ stage: variant.title, error: 'quota cooldown' });
        continue;
      }
      try {
        const xml = buildGetMyeBaySellingXml(trading, cfg, {
          entriesPerPage: perPage,
          detailLevelReturnAll: variant.returnAll,
        });
        const res = await trading.callTradingApi('GetMyeBaySelling', xml, {});
        const nodes = asArray(res?.response?.ActiveList?.ItemArray?.Item);
        findings[variant.key] = nodes.length ? evaluateNodes(nodes, variant.title) : null;
        if (!nodes.length) findings.errors.push({ stage: variant.title, error: 'ActiveList leer' });
      } catch (err) {
        console.error(`[probe] ${variant.title} fehlgeschlagen: ${err.message}`);
        findings.errors.push({ stage: variant.title, error: err.message, code: err.code || null });
      }
    }
  }

  // 6) Ausgabe.
  console.log('');
  console.log(renderTable([
    { title: 'via GetItem', result: findings.getItem },
    { title: 'via GetMyeBaySelling', result: findings.selling },
    { title: 'via ReturnAll', result: findings.sellingReturnAll },
  ]));
  console.log('');

  if (findings.getItemWatchCountProbe) {
    const w = findings.getItemWatchCountProbe.rows.WatchCount;
    console.log(`[probe] Zusatz: GetItem mit <IncludeWatchCount>true</IncludeWatchCount> → WatchCount ${w && w.hits ? `vorhanden (${w.sample})` : 'weiterhin NICHT vorhanden'}.`);
  }

  const pathNotes = PROBE_FIELDS
    .map((f) => {
      const src = [findings.getItem, findings.sellingReturnAll, findings.selling, findings.getItemWatchCountProbe]
        .filter(Boolean)
        .map((r) => r.rows[f.label])
        .find((r) => r && r.hits && r.path);
      return src ? `  ${f.label} → tatsächlicher XML-Pfad: ${src.path}` : null;
    })
    .filter(Boolean);
  if (pathNotes.length) {
    console.log('[probe] Gefundene XML-Pfade:');
    pathNotes.forEach((l) => console.log(l));
  }

  // 6b) Feld-Inventar: was liefert der jeweilige Aufruf ÜBERHAUPT? Damit lässt
  //     sich "Block fehlt komplett" von "eBay lässt den Wert 0 weg" trennen.
  console.log('');
  console.log('[probe] Feld-Inventar (was der Aufruf tatsächlich liefert):');
  for (const result of [findings.getItem, findings.selling, findings.sellingReturnAll]) {
    if (!result) continue;
    console.log(`  ${result.label}:`);
    console.log(`    Item.*            : ${result.keys.top.join(', ') || '(leer)'}`);
    console.log(`    SellingStatus.*   : ${result.keys.sellingStatus.join(', ') || '(nicht geliefert)'}`);
    console.log(`    ListingDetails.*  : ${result.keys.listingDetails.join(', ') || '(nicht geliefert)'}`);
  }

  // 7) Fazit — trägt der geplante Weg? Pro Kennzahl einzeln, weil die drei
  //    gesuchten Zahlen NICHT aus derselben Quelle kommen.
  const hit = (result, label) => Boolean(result && result.rows[label] && result.rows[label].hits);
  const deliversKey = (result, key) => Boolean(result && result.keys && result.keys.top.includes(key));

  const returnAllWatch = hit(findings.sellingReturnAll, 'WatchCount');
  const baseWatch = hit(findings.selling, 'WatchCount');
  const returnAllSold = hit(findings.sellingReturnAll, 'SellingStatus.QuantitySold');
  const itemWatch = hit(findings.getItem, 'WatchCount') || hit(findings.getItemWatchCountProbe, 'WatchCount');
  const itemSold = hit(findings.getItem, 'SellingStatus.QuantitySold');
  const anyHits = hit(findings.getItem, 'HitCount')
    || hit(findings.selling, 'HitCount')
    || hit(findings.sellingReturnAll, 'HitCount');

  const nothingUsable = !findings.sellingReturnAll && !findings.selling && !findings.getItem;

  console.log('');
  if (nothingUsable) {
    console.log('[probe] FAZIT: unklar — es kam keine auswertbare Antwort zurück. Siehe Fehler unten.');
  }

  // Kernfrage des Plans: bringt DetailLevel=ReturnAll überhaupt etwas?
  if (!nothingUsable && findings.selling && findings.sellingReturnAll) {
    const a = JSON.stringify(findings.selling.keys);
    const b = JSON.stringify(findings.sellingReturnAll.keys);
    console.log(a === b
      ? '[probe] FAZIT 0 (Kernannahme): DetailLevel=ReturnAll ändert bei GetMyeBaySelling GAR NICHTS — '
        + 'das gelieferte Feld-Inventar ist mit und ohne ReturnAll identisch. Die Plan-Annahme ist FALSCH.'
      : '[probe] FAZIT 0 (Kernannahme): DetailLevel=ReturnAll ändert das Feld-Inventar von GetMyeBaySelling — '
        + 'siehe Inventar oben.');
  }

  // Beobachter
  if (nothingUsable) {
    // keine Kennzahl-Aussage möglich
  } else if (baseWatch || returnAllWatch) {
    console.log('[probe] FAZIT 1 (Beobachter): ERREICHBAR über GetMyeBaySelling — und zwar bereits OHNE DetailLevel. '
      + 'Ein Bulk-Call je Seite reicht, kein Call je Angebot. '
      + 'Achtung: eBay lässt <WatchCount> bei 0 Beobachtern weg → fehlend = 0, nicht "unbekannt".');
  } else if (itemWatch) {
    console.log('[probe] FAZIT 1 (Beobachter): NUR über GetItem mit <IncludeWatchCount>true</IncludeWatchCount> — '
      + 'ohne dieses Flag liefert GetItem den Wert nicht. Kosten: 1 Call je Angebot.');
  } else {
    console.log('[probe] FAZIT 1 (Beobachter): NICHT erreichbar über die geprüften Aufrufe.');
  }

  // Verkaufte Menge
  if (nothingUsable) {
    // keine Kennzahl-Aussage möglich
  } else if (returnAllSold) {
    console.log('[probe] FAZIT 2 (verkaufte Menge): ERREICHBAR über GetMyeBaySelling+ReturnAll.');
  } else if (itemSold) {
    console.log('[probe] FAZIT 2 (verkaufte Menge): NUR über GetItem (SellingStatus.QuantitySold). '
      + 'GetMyeBaySelling liefert unter SellingStatus nur '
      + `${(findings.selling && findings.selling.keys.sellingStatus.join(', ')) || '(nichts)'}. `
      + 'Kosten: 1 Call je Angebot — bei ~4.828 Angeboten quota-relevant, also gestaffelt/priorisiert backfillen.');
  } else {
    console.log('[probe] FAZIT 2 (verkaufte Menge): NICHT erreichbar über die geprüften Aufrufe.');
  }

  // Aufrufe
  if (nothingUsable) {
    // keine Kennzahl-Aussage möglich
  } else if (anyHits) {
    console.log('[probe] FAZIT 3 (Aufrufe): HitCount kommt an — Quelle siehe XML-Pfade oben.');
  } else {
    const proxy = deliversKey(findings.getItem, 'SellingStatus') ? ' Als schwacher Ersatz liefert GetItem SellingStatus.LeadCount und ListingDetails.HasUnansweredQuestions.' : '';
    console.log('[probe] FAZIT 3 (Aufrufe): NICHT erreichbar — HitCount kommt bei KEINEM der drei Aufrufe an '
      + '(der eBay-Besucherzähler ist abgekündigt). Aufrufe/Impressionen brauchen eine ANDERE Quelle, '
      + 'z.B. den Traffic-Report der eBay Analytics API.' + proxy);
  }

  console.log('[probe] Hinweis: getItemDetails()/getMyeBaySellingActive() aus lib/ebay-trading-api.js mappen die '
    + 'Antwort und WERFEN WatchCount/HitCount/QuantitySold/QuestionCount heute weg — selbst wenn eBay sie liefert. '
    + 'Ein Anschluss braucht also zusätzlich eine Erweiterung der Mapper (mapActiveListingItem/mapListingDetail).');

  if (findings.errors.length) {
    console.log('');
    console.log(`[probe] ${findings.errors.length} Fehler/Auslassungen:`);
    findings.errors.forEach((e) => console.log(`  - ${e.stage}${e.itemId ? ` ${e.itemId}` : ''}: ${e.error}`));
  }

  if (args.json) {
    console.log('');
    console.log(JSON.stringify(findings, null, 2));
  }

  return 0;
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code || 0; })
    .catch((err) => {
      console.error(`[probe] Unerwarteter Fehler: ${err.message}`);
      console.error(err.stack);
      process.exitCode = 1;
    });
}

module.exports = {
  parseArgs,
  getPath,
  presentValue,
  collectKeys,
  evaluateNodes,
  renderTable,
  buildGetItemXml,
  buildGetMyeBaySellingXml,
  PROBE_FIELDS,
};
