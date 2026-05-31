'use strict';

/**
 * audit-invoice-duplicates.js — READ-ONLY analysis of the SevDesk invoice book.
 *
 * Diagnoses the duplicate-invoice problem WITHOUT changing anything:
 *   1. Duplicate invoice numbers (same RE-xxxx appearing more than once,
 *      typically one finalized + one leftover draft).
 *   2. Non-sequential / wrong-format numbers (local fallback "RE-2026-0059").
 *   3. Invoices without any number (blank).
 *   4. Drafts (status 100) — safe to delete vs. finalized (>=200) — GoBD-locked,
 *      can only be cancelled, not deleted.
 *
 * It NEVER writes to SevDesk or Firestore. There is intentionally no --apply
 * flag. Use the output to decide the cleanup strategy per category.
 *
 * Usage:
 *   node backend/scripts/audit-invoice-duplicates.js
 *   node backend/scripts/audit-invoice-duplicates.js --json   # machine-readable
 */

const { getSecretValue } = require('../lib/secret-values');

const SEVDESK_BASE_URL = 'https://my.sevdesk.de/api/v1';
const JSON_OUT = process.argv.includes('--json');

// SevDesk invoice status codes
const STATUS_LABEL = {
  '50': 'wiederkehrend (deaktiviert)',
  '100': 'Entwurf',
  '200': 'offen/versendet',
  '750': 'teilbezahlt',
  '1000': 'bezahlt',
};
const isDraft = (s) => String(s) === '100';
const isFinalized = (s) => ['200', '750', '1000'].includes(String(s));

// A proper SevDesk number looks like "RE-1234". The buggy local fallback looks
// like "RE-2026-0059" (prefix-YEAR-counter). Cancellations (Storno) are fine.
const LOCAL_FALLBACK_RE = /^[A-Z]{2,3}-\d{4}-\d{3,}$/; // RE-2026-0059

async function fetchAllSevdeskInvoices(token) {
  const PAGE = 100;
  const all = [];
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = `${SEVDESK_BASE_URL}/Invoice?limit=${PAGE}&offset=${offset}&embed=contact&orderBy=invoiceDate%2Cdesc`;
    const res = await fetch(url, { headers: { Authorization: token, 'Content-Type': 'application/json' } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`SevDesk API ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const page = Array.isArray(data?.objects) ? data.objects : [];
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

(async () => {
  const token = await getSecretValue('SEVDESK_API_TOKEN');
  if (!token) throw new Error('SEVDESK_API_TOKEN not configured');

  const invoices = await fetchAllSevdeskInvoices(token);

  // Group by invoiceNumber
  const byNumber = new Map();
  const blank = [];
  for (const inv of invoices) {
    const num = (inv.invoiceNumber || '').trim();
    if (!num) { blank.push(inv); continue; }
    if (!byNumber.has(num)) byNumber.set(num, []);
    byNumber.get(num).push(inv);
  }

  // 1. Duplicate numbers
  const duplicates = [];
  for (const [num, list] of byNumber.entries()) {
    if (list.length > 1) {
      duplicates.push({
        number: num,
        count: list.length,
        drafts: list.filter((i) => isDraft(i.status)).map((i) => String(i.id)),
        finalized: list.filter((i) => isFinalized(i.status)).map((i) => String(i.id)),
        statuses: list.map((i) => STATUS_LABEL[String(i.status)] || i.status),
      });
    }
  }

  // 2. Wrong-format numbers
  const wrongFormat = [];
  for (const [num, list] of byNumber.entries()) {
    if (LOCAL_FALLBACK_RE.test(num)) {
      wrongFormat.push({
        number: num,
        ids: list.map((i) => String(i.id)),
        statuses: list.map((i) => STATUS_LABEL[String(i.status)] || i.status),
        deletable: list.every((i) => isDraft(i.status)),
      });
    }
  }

  // 3 + 4. Drafts overall
  const allDrafts = invoices.filter((i) => isDraft(i.status));

  // ── SAFETY ANALYSIS (the tax-critical questions) ──────────────────────────
  const hasCustomer = (i) => {
    const n = i.contact?.name || [i.contact?.surename, i.contact?.familyname].filter(Boolean).join(' ');
    return Boolean((n || '').trim());
  };
  const gross = (i) => parseFloat(i.sumGross) || 0;

  // Set of numbers that have at least one FINALIZED invoice
  const finalizedNumbers = new Set(
    invoices.filter((i) => isFinalized(i.status)).map((i) => (i.invoiceNumber || '').trim()).filter(Boolean),
  );

  // Q2: lonely drafts = a draft whose number has NO finalized twin (DANGER to delete)
  const lonelyDrafts = allDrafts
    .filter((i) => {
      const num = (i.invoiceNumber || '').trim();
      return !num || !finalizedNumbers.has(num);
    })
    .map((i) => ({ id: String(i.id), number: (i.invoiceNumber || '').trim() || '(leer)', gross: gross(i) }));

  // Zero-amount finalized invoices (the eBay-Käufer 0,00 € rows)
  const zeroFinalized = invoices
    .filter((i) => isFinalized(i.status) && gross(i) === 0)
    .map((i) => ({ id: String(i.id), number: (i.invoiceNumber || '').trim(), hasCustomer: hasCustomer(i) }));

  // Sequence gaps in the proper SevDesk RE-#### range (cancellations can be legit gaps)
  const numericNums = [...finalizedNumbers]
    .map((n) => { const m = n.match(/^RE-(\d+)$/); return m ? parseInt(m[1], 10) : null; })
    .filter((n) => n != null)
    .sort((a, b) => a - b);
  const gaps = [];
  if (numericNums.length > 1) {
    for (let n = numericNums[0]; n <= numericNums[numericNums.length - 1]; n++) {
      if (!finalizedNumbers.has(`RE-${n}`)) gaps.push(`RE-${n}`);
    }
  }

  // Cleanup buckets
  const draftIdsInDuplicates = new Set(duplicates.flatMap((d) => d.drafts));
  const deletableDrafts = allDrafts.length;                 // status 100 → DELETE possible
  const finalizedWrongFormat = wrongFormat.filter((w) => !w.deletable); // GoBD → only Storno

  const report = {
    sevdeskTotalInvoices: invoices.length,
    uniqueNumbers: byNumber.size,
    blankNumberCount: blank.length,
    duplicateNumberGroups: duplicates.length,
    duplicateDraftLeftovers: draftIdsInDuplicates.size,
    draftsTotal: deletableDrafts,
    draftsWithFinalizedTwin: deletableDrafts - lonelyDrafts.length,
    lonelyDraftsNoTwin_DANGER: lonelyDrafts.length,
    wrongFormatNumbers: wrongFormat.length,
    wrongFormatFinalized_needCancel: finalizedWrongFormat.length,
    zeroAmountFinalized: zeroFinalized.length,
    zeroAmountFinalized_noCustomer: zeroFinalized.filter((z) => !z.hasCustomer).length,
    sequenceGaps: gaps.length,
  };

  if (JSON_OUT) {
    console.log(JSON.stringify({ report, duplicates, wrongFormat, lonelyDrafts, zeroFinalized, gaps, blank: blank.map((i) => String(i.id)) }, null, 2));
    return;
  }

  const line = (n) => '─'.repeat(n);
  console.log(`\n${line(64)}`);
  console.log('  SevDesk Rechnungs-Audit (READ-ONLY — nichts wird geändert)');
  console.log(`${line(64)}\n`);

  console.log(`  Rechnungen in SevDesk gesamt : ${report.sevdeskTotalInvoices}`);
  console.log(`  Eindeutige Nummern           : ${report.uniqueNumbers}`);
  console.log(`  Ohne Nummer (leer)           : ${report.blankNumberCount}`);
  console.log(`  Doppelte Nummern (Gruppen)   : ${report.duplicateNumberGroups}`);
  console.log(`  → davon Entwurf-Dubletten    : ${report.duplicateDraftLeftovers}`);
  console.log(`  Entwürfe gesamt (Status 100) : ${report.draftsTotal}`);
  console.log(`  → mit finalisiertem Zwilling : ${report.draftsWithFinalizedTwin}   ← sicher löschbar`);
  console.log(`  → OHNE Zwilling (GEFAHR!)    : ${report.lonelyDraftsNoTwin_DANGER}   ← NICHT blind löschen`);
  console.log(`  Falsche Nummern (RE-JJJJ-…)  : ${report.wrongFormatNumbers}`);
  console.log(`  → davon schon finalisiert    : ${report.wrongFormatFinalized_needCancel}   ← NUR Storno (GoBD)`);
  console.log(`  0,00 €-Rechnungen finalisiert: ${report.zeroAmountFinalized}`);
  console.log(`  → davon ohne Kundendaten     : ${report.zeroAmountFinalized_noCustomer}`);
  console.log(`  Lücken in RE-#### Reihe      : ${report.sequenceGaps}\n`);

  if (duplicates.length) {
    console.log(`${line(64)}`);
    console.log('  Doppelte Nummern (eine echte + ein Entwurf):');
    console.log(`${line(64)}`);
    for (const d of duplicates.slice(0, 80)) {
      console.log(`  ${d.number.padEnd(14)} ${d.count}× [${d.statuses.join(', ')}]  Entwurf-IDs: ${d.drafts.join(', ') || '—'}`);
    }
    if (duplicates.length > 80) console.log(`  … und ${duplicates.length - 80} weitere`);
    console.log('');
  }

  if (wrongFormat.length) {
    console.log(`${line(64)}`);
    console.log('  Falsche/nicht-fortlaufende Nummern:');
    console.log(`${line(64)}`);
    for (const w of wrongFormat) {
      const tag = w.deletable ? 'löschbar (Entwurf)' : 'NUR Storno (finalisiert)';
      console.log(`  ${w.number.padEnd(16)} [${w.statuses.join(', ')}]  → ${tag}`);
    }
    console.log('');
  }

  if (lonelyDrafts.length) {
    console.log(`${line(64)}`);
    console.log('  ⚠ Entwürfe OHNE finalisierten Zwilling (vor Löschen prüfen!):');
    console.log(`${line(64)}`);
    for (const d of lonelyDrafts.slice(0, 60)) {
      console.log(`  ${String(d.number).padEnd(16)} id ${d.id}  ${d.gross.toFixed(2)} €`);
    }
    if (lonelyDrafts.length > 60) console.log(`  … und ${lonelyDrafts.length - 60} weitere`);
    console.log('');
  }

  if (zeroFinalized.length) {
    console.log(`${line(64)}`);
    console.log('  0,00 €-Rechnungen im finalisierten Status (eBay Käufer etc.):');
    console.log(`${line(64)}`);
    for (const z of zeroFinalized.slice(0, 60)) {
      console.log(`  ${String(z.number || '(leer)').padEnd(12)} id ${z.id}  Kunde: ${z.hasCustomer ? 'ja' : 'NEIN'}`);
    }
    if (zeroFinalized.length > 60) console.log(`  … und ${zeroFinalized.length - 60} weitere`);
    console.log('');
  }

  if (gaps.length) {
    console.log(`${line(64)}`);
    console.log(`  Lücken in der RE-####-Reihe (können legitime Stornos sein): ${gaps.length}`);
    console.log(`${line(64)}`);
    console.log(`  ${gaps.slice(0, 40).join(', ')}${gaps.length > 40 ? ' …' : ''}\n`);
  }

  console.log(`${line(64)}`);
  console.log('  Empfehlung:');
  console.log(`${line(64)}`);
  console.log('  • Entwurf-Dubletten (Status 100) können gefahrlos gelöscht werden.');
  console.log('  • Finalisierte falsche Nummern dürfen NICHT gelöscht, nur storniert werden.');
  console.log('  • Dieses Skript ändert nichts. Lösch-/Storno-Skript folgt erst nach deiner Freigabe.\n');
})().catch((err) => {
  console.error(`[audit-invoice-duplicates] ${err.message}`);
  process.exit(1);
});
