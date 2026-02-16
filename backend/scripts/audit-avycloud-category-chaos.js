/* eslint-disable no-console */
/**
 * Audit + optional repair for AvyCloud category chaos.
 *
 * What it does:
 * - Builds an overview of all BaseLinker categories used in products.
 * - Identifies category drift/conflicts across fields.
 * - Writes a Markdown report with full category list.
 * - Optionally backfills canonical BaseLinker category fields.
 *
 * Usage:
 *   node backend/scripts/audit-avycloud-category-chaos.js --dry-run
 *   node backend/scripts/audit-avycloud-category-chaos.js --apply --expected-count 767
 */

const fs = require('fs');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');
const {
  normalizeBreadcrumb,
  resolveBaselinkerCategory,
  buildBaselinkerCategoryDetails,
} = require('../lib/baselinker-category-resolver');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const firestore = new Firestore({ projectId: PROJECT_ID });

function safeString(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function parseArgs(argv) {
  const args = {
    apply: false,
    dryRun: true,
    expectedCount: 0,
    limit: 0,
    offset: 0,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--apply') {
      args.apply = true;
      args.dryRun = false;
    } else if (t === '--dry-run') {
      args.apply = false;
      args.dryRun = true;
    } else if (t === '--expected-count') {
      args.expectedCount = Math.max(0, Number(argv[i + 1]) || 0);
      i += 1;
    } else if (t === '--limit') {
      args.limit = Math.max(0, Number(argv[i + 1]) || 0);
      i += 1;
    } else if (t === '--offset') {
      args.offset = Math.max(0, Number(argv[i + 1]) || 0);
      i += 1;
    }
  }
  return args;
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function markdownEscape(value) {
  return String(value || '').replace(/\|/g, '\\|');
}

function topLevel(pathValue) {
  const normalized = normalizeBreadcrumb(pathValue);
  if (!normalized) return '';
  const idx = normalized.indexOf(' > ');
  return idx === -1 ? normalized : normalized.slice(0, idx);
}

function pickSku(data, fallbackId) {
  return (
    safeString(data?.identification?.sku) ||
    safeString(data?.details?.identifiers?.sku) ||
    safeString(data?.details?.identifiers?.ean) ||
    safeString(data?.details?.identifiers?.gtin) ||
    safeString(data?.details?.identifiers?.upc) ||
    safeString(fallbackId)
  );
}

function buildMarkdownReport({
  summary,
  categories,
  roots,
  mismatchExamples,
  conflictExamples,
  missingExamples,
  applyInfo,
}) {
  const lines = [];
  lines.push('# AvyCloud Kategorien Audit');
  lines.push('');
  lines.push(`- Stand: ${new Date().toISOString()}`);
  lines.push(`- Projekt: ${PROJECT_ID}`);
  lines.push(`- Produkte gesamt: ${summary.totalProducts}`);
  lines.push(`- Produkte mit BaseLinker-Kategorie: ${summary.productsWithCategory}`);
  lines.push(`- Produkte ohne BaseLinker-Kategorie: ${summary.productsWithoutCategory}`);
  lines.push(`- Eindeutige Kategorien: ${summary.uniqueCategories}`);
  lines.push('');
  lines.push('## Problemquellen');
  lines.push('');
  lines.push('| Problemquelle | Anzahl |');
  lines.push('| --- | ---: |');
  lines.push(`| BaseLinker-Kategorie fehlt | ${summary.productsWithoutCategory} |`);
  lines.push(`| Konflikt zwischen mehreren Kategorie-Quellen | ${summary.conflictProducts} |`);
  lines.push(`| UI-Mix Risiko (identification.category != BaseLinker) | ${summary.mismatchIdentificationVsBaselinker} |`);
  lines.push(`| Backfill/Repair notwendig | ${summary.repairCandidates} |`);
  lines.push('');
  lines.push('### Quellenverteilung (welches Feld liefert aktuell die Kategorie)');
  lines.push('');
  lines.push('| Quelle | Produkte |');
  lines.push('| --- | ---: |');
  Object.entries(summary.sourceCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de-DE'))
    .forEach(([source, count]) => {
      lines.push(`| ${markdownEscape(source)} | ${count} |`);
    });
  lines.push('');
  lines.push('## Top-Level Kategorien');
  lines.push('');
  lines.push('| # | Top-Level Kategorie | Produkte |');
  lines.push('| ---: | --- | ---: |');
  roots.forEach((entry, idx) => {
    lines.push(`| ${idx + 1} | ${markdownEscape(entry.category)} | ${entry.count} |`);
  });
  lines.push('');
  lines.push('## Alle AvyCloud Kategorien (BaseLinker)');
  lines.push('');
  lines.push('| # | Kategorie | Produkte |');
  lines.push('| ---: | --- | ---: |');
  categories.forEach((entry, idx) => {
    lines.push(`| ${idx + 1} | ${markdownEscape(entry.category)} | ${entry.count} |`);
  });
  lines.push('');
  lines.push('## Stichprobe: Konflikte (mehrere unterschiedliche Kategoriepfade pro Produkt)');
  lines.push('');
  if (conflictExamples.length) {
    lines.push('| Produkt-ID | SKU | Gewählte Kategorie | Kandidaten |');
    lines.push('| --- | --- | --- | --- |');
    conflictExamples.forEach((entry) => {
      lines.push(
        `| ${markdownEscape(entry.id)} | ${markdownEscape(entry.sku)} | ${markdownEscape(entry.selected)} | ${markdownEscape(entry.candidates.join(' || '))} |`
      );
    });
  } else {
    lines.push('Keine Konflikte gefunden.');
  }
  lines.push('');
  lines.push('## Stichprobe: identification.category weicht von BaseLinker-Kategorie ab');
  lines.push('');
  if (mismatchExamples.length) {
    lines.push('| Produkt-ID | SKU | BaseLinker | identification.category |');
    lines.push('| --- | --- | --- | --- |');
    mismatchExamples.forEach((entry) => {
      lines.push(
        `| ${markdownEscape(entry.id)} | ${markdownEscape(entry.sku)} | ${markdownEscape(entry.baselinker)} | ${markdownEscape(entry.identification)} |`
      );
    });
  } else {
    lines.push('Keine Abweichungen gefunden.');
  }
  lines.push('');
  lines.push('## Stichprobe: Produkte ohne BaseLinker-Kategorie');
  lines.push('');
  if (missingExamples.length) {
    lines.push('| Produkt-ID | SKU | identification.category (Fallback) |');
    lines.push('| --- | --- | --- |');
    missingExamples.forEach((entry) => {
      lines.push(
        `| ${markdownEscape(entry.id)} | ${markdownEscape(entry.sku)} | ${markdownEscape(entry.identification || '—')} |`
      );
    });
  } else {
    lines.push('Keine fehlenden BaseLinker-Kategorien gefunden.');
  }
  lines.push('');
  lines.push('## Implementierte Lösung');
  lines.push('');
  lines.push('1. Kategorie-Auflösung auf eine kanonische BaseLinker-Quelle vereinheitlicht (Path + Legacy 78659).');
  lines.push('2. Repair-Backfill setzt `details.baselinkerCategoryPath` und `details.baselinkerCategories.78659` konsistent.');
  lines.push('3. UI nutzt die BaseLinker-Kategorie als primäre Inventar-Kategorie (kein Taxonomie-Mix mit eBay).');
  lines.push('');
  lines.push('## Präventive Maßnahmen');
  lines.push('');
  lines.push('- Save-Pipeline erzwingt künftig kanonischen BaseLinker-Kategoriepfad pro Produkt.');
  lines.push('- Konfliktfälle werden als Data-Quality-Signal markiert statt still weiterzutreiben.');
  lines.push('- Dieses Audit-Skript kann regelmäßig (z. B. nightly) laufen, um neue Drifts früh sichtbar zu machen.');
  lines.push('');
  lines.push('## Apply-Info');
  lines.push('');
  lines.push(`- Modus: ${applyInfo.mode}`);
  lines.push(`- Repair-Kandidaten: ${applyInfo.repairCandidates}`);
  lines.push(`- Tatsächlich aktualisiert: ${applyInfo.updated}`);
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const repoRoot = path.resolve(__dirname, '..', '..');
  const outRoot = path.join(repoRoot, 'backend', 'exports', 'category-chaos');
  const outDir = path.join(outRoot, stamp);
  ensureDir(outDir);

  console.log(
    `[category-chaos] project=${PROJECT_ID} mode=${args.apply ? 'APPLY' : 'DRY_RUN'} out=${outDir}`
  );

  const snap = await firestore.collection('products').get();
  const allDocs = snap.docs;
  const docs = allDocs.slice(
    args.offset,
    args.limit && args.limit > 0 ? args.offset + Math.floor(args.limit) : undefined
  );
  const totalProducts = docs.length;
  if (args.apply) {
    if (!args.expectedCount || args.expectedCount <= 0) {
      throw new Error('[category-chaos] --apply requires --expected-count <n>');
    }
    if (totalProducts !== args.expectedCount) {
      throw new Error(
        `[category-chaos] ABORT expected-count=${args.expectedCount} actual=${totalProducts}`
      );
    }
  }

  const sourceCounts = {};
  const categoryCounts = new Map();
  const rootCounts = new Map();
  const mismatchExamples = [];
  const conflictExamples = [];
  const missingExamples = [];
  const repairRows = [];

  let productsWithCategory = 0;
  let productsWithoutCategory = 0;
  let conflictProducts = 0;
  let mismatchIdentificationVsBaselinker = 0;

  for (const doc of docs) {
    const data = doc.data() || {};
    const details = data?.details && typeof data.details === 'object' ? data.details : {};
    const identification =
      data?.identification && typeof data.identification === 'object' ? data.identification : {};

    const resolved = resolveBaselinkerCategory(details);
    sourceCounts[resolved.source] = (sourceCounts[resolved.source] || 0) + 1;
    const selected = resolved.value;
    const identCategory = normalizeBreadcrumb(identification.category);
    const sku = pickSku(data, doc.id);

    if (selected) {
      productsWithCategory += 1;
      categoryCounts.set(selected, (categoryCounts.get(selected) || 0) + 1);
      const root = topLevel(selected);
      if (root) rootCounts.set(root, (rootCounts.get(root) || 0) + 1);
    } else {
      productsWithoutCategory += 1;
      if (missingExamples.length < 30) {
        missingExamples.push({
          id: doc.id,
          sku,
          identification: identCategory || '',
        });
      }
    }

    if (resolved.hasConflict) {
      conflictProducts += 1;
      if (conflictExamples.length < 30) {
        conflictExamples.push({
          id: doc.id,
          sku,
          selected: selected || '—',
          candidates: resolved.distinctValues,
        });
      }
    }

    if (selected && identCategory && selected !== identCategory) {
      mismatchIdentificationVsBaselinker += 1;
      if (mismatchExamples.length < 40) {
        mismatchExamples.push({
          id: doc.id,
          sku,
          baselinker: selected,
          identification: identCategory,
        });
      }
    }

    const hydrated = buildBaselinkerCategoryDetails(details);
    if (hydrated.changed && hydrated.value) {
      const updates = {};
      const currentPath = normalizeBreadcrumb(details.baselinkerCategoryPath);
      if (currentPath !== hydrated.value) {
        updates['details.baselinkerCategoryPath'] = hydrated.value;
      }
      const legacy =
        details.baselinkerCategories &&
        typeof details.baselinkerCategories === 'object' &&
        !Array.isArray(details.baselinkerCategories)
          ? details.baselinkerCategories
          : {};
      const current78659 = normalizeBreadcrumb(legacy['78659']);
      if (current78659 !== hydrated.value) {
        updates['details.baselinkerCategories.78659'] = hydrated.value;
      }
      if (Object.keys(updates).length) {
        repairRows.push({
          id: doc.id,
          sku,
          source: hydrated.source,
          value: hydrated.value,
          updates,
        });
      }
    }
  }

  let updated = 0;
  if (args.apply && repairRows.length) {
    const bulkWriter = firestore.bulkWriter({
      throttling: { initialOpsPerSecond: 50, maxOpsPerSecond: 300 },
    });
    bulkWriter.onWriteError((error) => {
      console.error('[category-chaos] write error', error.documentRef.path, error.message);
      if (error.code === 'unavailable' && error.failedAttempts < 6) return true;
      return false;
    });

    for (const row of repairRows) {
      bulkWriter.update(firestore.collection('products').doc(row.id), row.updates);
      updated += 1;
    }
    await bulkWriter.close();
  }

  const categories = Array.from(categoryCounts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category, 'de-DE'));
  const roots = Array.from(rootCounts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category, 'de-DE'));

  const summary = {
    totalProducts,
    productsWithCategory,
    productsWithoutCategory,
    uniqueCategories: categories.length,
    conflictProducts,
    mismatchIdentificationVsBaselinker,
    sourceCounts,
    repairCandidates: repairRows.length,
  };

  const summaryPath = path.join(outDir, 'summary.json');
  const repairPath = path.join(outDir, args.apply ? 'apply_repairs.json' : 'dryrun_repairs.json');
  const markdownPath = path.join(outDir, 'avycloud-categories-overview.md');

  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        summary,
        roots,
        categories,
      },
      null,
      2
    ),
    'utf8'
  );
  fs.writeFileSync(
    repairPath,
    JSON.stringify(
      {
        mode: args.apply ? 'APPLY' : 'DRY_RUN',
        count: repairRows.length,
        rows: repairRows,
      },
      null,
      2
    ),
    'utf8'
  );

  const markdown = buildMarkdownReport({
    summary,
    categories,
    roots,
    mismatchExamples,
    conflictExamples,
    missingExamples,
    applyInfo: {
      mode: args.apply ? 'APPLY' : 'DRY_RUN',
      repairCandidates: repairRows.length,
      updated,
    },
  });
  fs.writeFileSync(markdownPath, markdown, 'utf8');
  fs.writeFileSync(path.join(outRoot, 'latest-avycloud-categories-overview.md'), markdown, 'utf8');

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: args.apply ? 'APPLY' : 'DRY_RUN',
        totalProducts,
        repairCandidates: repairRows.length,
        updated,
        summaryPath,
        repairPath,
        markdownPath,
        latestMarkdownPath: path.join(outRoot, 'latest-avycloud-categories-overview.md'),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('[category-chaos] failed:', error?.message || error);
  process.exit(1);
});
