// globals: true in vitest.config.js
'use strict';

/**
 * Quell-Vertrag der Tagesbudget-Verdrahtung (Vorfall 2026-10-08). Diese
 * Zusicherungen sind bewusst Grep-Gates: wer eine Prioritaet entfernt oder
 * die Messung aus dem Worker-Block nimmt, bricht den Test — und damit den
 * Schutz, der P0 (Oversell-Schutz, Import, Versandmeldung) vor P2 (Spiegel,
 * Komfort) stellt.
 */

const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('Tagesbudget — Verdrahtung', () => {
  it('index.js misst das Kontingent im Worker-Block (RUN_BACKGROUND_JOBS) alle 15 min', () => {
    const src = read('index.js');
    const blockStart = src.indexOf('if (RUN_BACKGROUND_JOBS) {');
    const probeAt = src.indexOf("require('./lib/ebay-rate-limit-probe')");
    expect(blockStart).toBeGreaterThan(0);
    expect(probeAt).toBeGreaterThan(blockStart);
    // Muell-Wert (z. B. "15m") darf keine 1-ms-Messschleife ergeben: Untergrenze 60 s.
    expect(src).toMatch(/EBAY_BUDGET_PROBE_INTERVAL_MS\s*=\s*resolveIntervalMs\(process\.env\.EBAY_BUDGET_PROBE_INTERVAL_MS,\s*15 \* 60 \* 1000,\s*60_000\)/);
  });

  it('SIGTERM: ungeflushte Budget-Zaehler werden vor dem Beenden best-effort geschrieben', () => {
    const src = read('index.js');
    const sigterm = src.indexOf("process.on('SIGTERM'");
    expect(sigterm).toBeGreaterThan(0);
    expect(src.slice(sigterm, sigterm + 1200)).toMatch(/getEbayTradingBudget\(\)\.flush\(\)/);
  });

  it('Stock-Sync: Mengen-Revise (Haupt- und Geschwister-Listing) laeuft als P0, Preis-Revise als P2', () => {
    const src = read('services/stock-sync-dispatcher.js');
    const quantityP0 = src.match(/reviseFixedPriceItem\(\{[^}]*quantity:\s*availableQuantity,?\s*\},\s*\{\s*priority:\s*'P0'\s*\}\)/g) || [];
    expect(quantityP0.length).toBe(2);
    expect(src).toMatch(/startPrice:\s*ebayPrice,\s*currency:\s*'EUR',\s*\},\s*\{\s*priority:\s*'P2'\s*\}\)/);
  });

  it('reviseListing reicht priority an callTradingApi durch', () => {
    const src = read('lib/ebay-trading-api.js');
    expect(src).toMatch(/async function reviseListing\(callName, patch, \{ timeoutMs = DEFAULT_TIMEOUT_MS, priority = null \} = \{\}\)/);
    expect(src).toMatch(/callTradingApi\(callName, requestXml, \{ timeoutMs, priority: priority \|\| undefined \}\)/);
  });

  it('EndFixedPriceItem und CompleteSale sind per Voreinstellung P0, GetMyeBaySelling P2', () => {
    const { DEFAULT_PRIORITY_BY_CALL } = require('../lib/ebay-trading-api');
    expect(DEFAULT_PRIORITY_BY_CALL.EndFixedPriceItem).toBe('P0');
    expect(DEFAULT_PRIORITY_BY_CALL.CompleteSale).toBe('P0');
    expect(DEFAULT_PRIORITY_BY_CALL.GetMyeBaySelling).toBe('P2');
  });

  it('GET /ebay/rate-limit-status liefert zusaetzlich den instanzuebergreifenden Budget-Stand', () => {
    const src = read('routes/marketplace.js');
    expect(src).toMatch(/router\.get\('\/ebay\/rate-limit-status'[\s\S]*?getEbayTradingBudget\(\)\.getState\(\{ force: true \}\)[\s\S]*?data: \{ \.\.\.getUsage\(\), budget \}/);
  });

  it('Angebots-Abgleich-Status traegt Fehlertyp und Budget (fuer das ehrliche Banner)', () => {
    const src = read('lib/ebay-direct.js');
    expect(src).toMatch(/errorKind: failingSinceIso \? classifyEbaySyncError\(lastError\?\.message\) : null/);
    expect(src).toMatch(/async function readTradingBudgetForStatus\(\)/);
  });

  it('Drain: Quota-Skips verbrennen keine Versuche (quota-aware, Notbremse DRAIN_QUOTA_AWARE=off)', () => {
    const src = read('services/stock-failure-drain.js');
    expect(src).toMatch(/function quotaAwareDrainEnabled\(\)/);
    expect(src).toMatch(/DRAIN_QUOTA_AWARE/);
    expect(src).toMatch(/_maybeQuotaDeferral\(/);
  });
});
