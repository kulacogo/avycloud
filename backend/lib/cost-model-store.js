'use strict';

/**
 * Persistenz des COGS-Kostenmodells je Tenant (Paletten-Eckdaten etc.).
 * Collection `tenant_settings`, Doc = tenantId, Feld `costModel`.
 * Additive, tenant-scoped (CLAUDE.md #8). Liefert sichere Defaults bei leerem Doc.
 */

const { firestore } = require('./firestore');
const { DEFAULT_COST_CONFIG } = require('./cost-model');

const COLLECTION = 'tenant_settings';

function feeRate(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(0.9, n); // guard: a fee rate above 90 % is almost certainly a mistake
}

function sanitize(raw) {
  const r = raw || {};
  const mode = r.mode === 'flat' ? 'flat' : 'proportional';
  const vatMode = r.vatMode === 'brutto' ? 'brutto' : 'netto';
  const palletCostBrutto = Math.max(0, Number(r.palletCostBrutto) || 0);
  const unitsPerPallet = Math.max(0, Number(r.unitsPerPallet) || 0);
  const manualRatio = r.manualRatio != null && Number(r.manualRatio) > 0
    ? Math.min(5, Number(r.manualRatio)) // 0..5 guard (ratio, not %)
    : null;
  const feeRateEbay = feeRate(r.feeRateEbay, DEFAULT_COST_CONFIG.feeRateEbay);
  const feeRateKaufland = feeRate(r.feeRateKaufland, DEFAULT_COST_CONFIG.feeRateKaufland);
  return { mode, vatMode, palletCostBrutto, unitsPerPallet, manualRatio, feeRateEbay, feeRateKaufland };
}

async function getCostModelConfig(tenantId = 'default') {
  try {
    const snap = await firestore.collection(COLLECTION).doc(tenantId).get();
    if (!snap.exists) return { ...DEFAULT_COST_CONFIG };
    const data = snap.data() || {};
    return sanitize(data.costModel || DEFAULT_COST_CONFIG);
  } catch (err) {
    // Never block the report on a config read — fall back to defaults.
    console.warn('[cost-model-store] read failed:', err && err.message);
    return { ...DEFAULT_COST_CONFIG };
  }
}

async function saveCostModelConfig(tenantId = 'default', partial = {}, actorUid = null) {
  const clean = sanitize(partial);
  await firestore.collection(COLLECTION).doc(tenantId).set(
    {
      tenantId,
      costModel: { ...clean, updatedAt: new Date().toISOString(), updatedBy: actorUid || null },
    },
    { merge: true },
  );
  return clean;
}

module.exports = { getCostModelConfig, saveCostModelConfig, sanitize };
