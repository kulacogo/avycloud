#!/usr/bin/env node
'use strict';

/**
 * probe-ebay-quota.js — READ-ONLY: Rest des eBay-Trading-Tageskontingents.
 *
 * Quelle 1: Developer-Analytics-API (eigenes Kontingent, KEIN Trading-Aufruf).
 * Quelle 2: das Budget-Doc system/ebay_trading_budget/windows/<Tag> (Zähler je
 *           CallName und Prioritaet, Ablehnungen, letzte Messung).
 *
 * Aufruf:  GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/probe-ebay-quota.js [--json] [--ohne-firestore]
 *
 * Vor jedem Verdacht „der eBay-Sync spinnt" ZUERST laufen lassen (CLAUDE.md
 * „eBay-Trading-Tagesbudget"). Schreibt nichts.
 */

if (!process.env.GOOGLE_CLOUD_PROJECT) process.env.GOOGLE_CLOUD_PROJECT = 'avycloud';

const args = new Set(process.argv.slice(2));

async function main() {
  const { fetchTradingRateLimit } = require('../lib/ebay-rate-limit-probe');
  const out = { gemessenAt: new Date().toISOString(), analytics: null, budget: null };

  try {
    out.analytics = await fetchTradingRateLimit({});
  } catch (err) {
    out.analytics = { error: err && err.message ? err.message : String(err) };
  }

  if (!args.has('--ohne-firestore')) {
    try {
      const { getEbayTradingBudget } = require('../lib/ebay-trading-budget');
      out.budget = await getEbayTradingBudget().getState({ force: true });
    } catch (err) {
      out.budget = { error: err && err.message ? err.message : String(err) };
    }
  }

  if (args.has('--json')) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`eBay-Trading-Kontingent — Messung ${out.gemessenAt}`);
  if (out.analytics && !out.analytics.error) {
    const a = out.analytics;
    console.log(`  eBay (Analytics-API): Rest ${a.remaining} von ${a.limit}, Reset ${a.resetAtIso} (${a.resources} Ressourcen melden denselben Pool)`);
  } else {
    console.log(`  eBay (Analytics-API): nicht messbar — ${out.analytics && out.analytics.error}`);
  }
  if (out.budget && !out.budget.error) {
    const b = out.budget;
    console.log(`  Budget-Doc (${b.windowKey}): Rest ${b.remaining} / Limit ${b.limit}, Stufe ${b.level}, Quelle ${b.source}, Reset ${b.resetAtIso}`);
    console.log(`  Reserven: P0-Boden ${b.reserves.floorP0}, P1 ${b.reserves.reserveP1}, P2 ${b.reserves.reserveP2}; Budget ${b.enabled ? 'aktiv' : 'AUS (EBAY_TRADING_BUDGET=off)'}`);
    const calls = Object.entries(b.usedByCall || {}).sort((x, y) => y[1] - x[1]);
    if (calls.length) {
      console.log('  Verbrauch je Call (eigener Zaehler):');
      for (const [name, n] of calls) console.log(`    ${String(name).padEnd(28)} ${String(n).padStart(6)}`);
    }
    const prios = Object.entries(b.usedByPriority || {}).sort();
    if (prios.length) console.log(`  Je Prioritaet: ${prios.map(([p, n]) => `${p}=${n}`).join(', ')}`);
    const deferred = Object.entries(b.deferredByPriority || {}).sort();
    if (deferred.length) console.log(`  Abgelehnt (Reserve erreicht): ${deferred.map(([p, n]) => `${p}=${n}`).join(', ')}`);
    if (b.probe) console.log(`  Letzte Messung im Doc: Rest ${b.probe.remaining} um ${b.probe.atIso}`);
  } else if (out.budget) {
    console.log(`  Budget-Doc: nicht lesbar — ${out.budget.error}`);
  }
}

main().catch((err) => {
  console.error('ERR', err && err.message ? err.message : err);
  process.exit(1);
});
