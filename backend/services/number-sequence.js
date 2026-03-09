'use strict';

/**
 * number-sequence.js — Atomic number sequence generator for orders, invoices, etc.
 *
 * Uses Firestore transactions for gap-free, duplicate-free numbering.
 * Format configurable per type: e.g. "AVY-2026-0001", "RE-2026-0001"
 *
 * Collection: number_sequences
 * Doc: {tenantId}__{type} — e.g. "default__order", "default__invoice"
 */

const { Firestore, FieldValue } = require('@google-cloud/firestore');

const COLLECTION = 'number_sequences';

let _db;
function getDb() {
  if (!_db) _db = new Firestore();
  return _db;
}

// ─── Default Sequence Configs ────────────────────────────────

const DEFAULTS = {
  order:         { prefix: 'AVY',  padLength: 4 },
  invoice:       { prefix: 'RE',   padLength: 4 },
  delivery_note: { prefix: 'LS',   padLength: 4 },
  return:        { prefix: 'RET',  padLength: 4 },
  shipment:      { prefix: 'VS',   padLength: 4 },
};

/**
 * Get the current year for sequence prefix.
 * @returns {string}
 */
function getCurrentYear() {
  return new Date().getFullYear().toString();
}

/**
 * Format a number with the sequence config.
 * Example: prefix=AVY, year=2026, number=42, padLength=4 → "AVY-2026-0042"
 *
 * @param {{ prefix: string, padLength: number }} config
 * @param {number} number
 * @returns {string}
 */
function formatNumber(config, number) {
  const year = getCurrentYear();
  const padded = String(number).padStart(config.padLength, '0');
  return `${config.prefix}-${year}-${padded}`;
}

/**
 * Get the next number in a sequence (atomic increment).
 * Creates the sequence if it doesn't exist yet.
 *
 * @param {{ tenantId?: string, type: string }} opts
 * @returns {Promise<{ number: number, formatted: string }>}
 */
async function getNextNumber({ tenantId = 'default', type }) {
  if (!type) throw new Error('Sequence type is required');

  const config = DEFAULTS[type];
  if (!config) throw new Error(`Unknown sequence type: ${type}`);

  const docId = `${tenantId}__${type}`;
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(docId);
  const year = getCurrentYear();

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);

    let currentNumber = 0;
    let storedYear = year;

    if (snap.exists) {
      const data = snap.data();
      storedYear = data.year || year;
      currentNumber = data.currentNumber || 0;

      // Reset counter on year change
      if (storedYear !== year) {
        currentNumber = 0;
        storedYear = year;
      }
    }

    const nextNumber = currentNumber + 1;
    const formatted = formatNumber(config, nextNumber);

    tx.set(ref, {
      tenantId,
      type,
      prefix: config.prefix,
      padLength: config.padLength,
      year: storedYear,
      currentNumber: nextNumber,
      lastGenerated: formatted,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return { number: nextNumber, formatted };
  });

  return result;
}

/**
 * Preview what the next number would be (without incrementing).
 * @param {{ tenantId?: string, type: string }} opts
 * @returns {Promise<string>}
 */
async function previewNextNumber({ tenantId = 'default', type }) {
  const config = DEFAULTS[type];
  if (!config) throw new Error(`Unknown sequence type: ${type}`);

  const docId = `${tenantId}__${type}`;
  const snap = await getDb().collection(COLLECTION).doc(docId).get();

  let currentNumber = 0;
  if (snap.exists) {
    const data = snap.data();
    const storedYear = data.year || getCurrentYear();
    currentNumber = storedYear === getCurrentYear() ? (data.currentNumber || 0) : 0;
  }

  return formatNumber(config, currentNumber + 1);
}

/**
 * Get current sequence state for all types.
 * @param {{ tenantId?: string }} opts
 * @returns {Promise<Record<string, { current: number, lastGenerated: string, nextPreview: string }>>}
 */
async function getSequenceStates({ tenantId = 'default' } = {}) {
  const states = {};
  const year = getCurrentYear();

  for (const [type, config] of Object.entries(DEFAULTS)) {
    const docId = `${tenantId}__${type}`;
    const snap = await getDb().collection(COLLECTION).doc(docId).get();

    if (snap.exists) {
      const data = snap.data();
      const storedYear = data.year || year;
      const num = storedYear === year ? (data.currentNumber || 0) : 0;
      states[type] = {
        current: num,
        lastGenerated: storedYear === year ? (data.lastGenerated || null) : null,
        nextPreview: formatNumber(config, num + 1),
        prefix: config.prefix,
      };
    } else {
      states[type] = {
        current: 0,
        lastGenerated: null,
        nextPreview: formatNumber(config, 1),
        prefix: config.prefix,
      };
    }
  }

  return states;
}

module.exports = {
  getNextNumber,
  previewNextNumber,
  getSequenceStates,
  formatNumber,
  DEFAULTS,
};
