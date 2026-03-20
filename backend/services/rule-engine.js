'use strict';

/**
 * rule-engine.js — Core logic for the visual rule engine (RULE-001).
 *
 * Evaluates conditions against products, applies actions, and orchestrates
 * rule execution via automationJobs.
 */

const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { saveProductV2 } = require('../lib/product-store');

const RULES_COLLECTION = 'automationRules';
const JOBS_COLLECTION = 'automationJobs';
const PRODUCTS_COLLECTION = 'products_v2';

let _db;
function getDb() {
  if (!_db) _db = new Firestore();
  return _db;
}

/* ─── Nested Field Access ─── */

function getNestedField(obj, path) {
  if (!obj || !path) return undefined;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function setNestedField(obj, path, value) {
  if (!obj || !path) return obj;
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] == null || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
  return obj;
}

/* ─── Condition Evaluation ─── */

const VALID_OPERATORS = new Set([
  'equals', 'not_equals', 'contains', 'not_contains',
  'starts_with', 'ends_with', 'greater_than', 'less_than',
  'is_empty', 'is_not_empty',
]);

function evaluateCondition(product, condition) {
  if (!condition || !condition.operator) return false;
  if (!VALID_OPERATORS.has(condition.operator)) return false;

  const fieldValue = getNestedField(product, condition.field);
  const condValue = condition.value;
  const op = condition.operator;

  // Existence checks
  if (op === 'is_empty') {
    return fieldValue == null || fieldValue === '' || (Array.isArray(fieldValue) && fieldValue.length === 0);
  }
  if (op === 'is_not_empty') {
    return fieldValue != null && fieldValue !== '' && !(Array.isArray(fieldValue) && fieldValue.length === 0);
  }

  // Numeric comparisons
  if (op === 'greater_than') {
    const numField = parseFloat(fieldValue);
    const numCond = parseFloat(condValue);
    return !isNaN(numField) && !isNaN(numCond) && numField > numCond;
  }
  if (op === 'less_than') {
    const numField = parseFloat(fieldValue);
    const numCond = parseFloat(condValue);
    return !isNaN(numField) && !isNaN(numCond) && numField < numCond;
  }

  // String comparisons (case-insensitive)
  const strField = String(fieldValue ?? '').toLowerCase();
  const strCond = String(condValue ?? '').toLowerCase();

  switch (op) {
    case 'equals': return strField === strCond;
    case 'not_equals': return strField !== strCond;
    case 'contains': return strField.includes(strCond);
    case 'not_contains': return !strField.includes(strCond);
    case 'starts_with': return strField.startsWith(strCond);
    case 'ends_with': return strField.endsWith(strCond);
    default: return false;
  }
}

function evaluateConditions(product, conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) return false;
  return conditions.every((cond) => evaluateCondition(product, cond));
}

/* ─── Action Application ─── */

const VALID_ACTION_TYPES = new Set([
  'set_field', 'adjust_price', 'prepend_text', 'append_text', 'replace_text',
]);

function applyAction(product, action) {
  if (!action || !VALID_ACTION_TYPES.has(action.type)) return null;

  const field = action.field;
  const oldValue = getNestedField(product, field);
  let newValue;

  switch (action.type) {
    case 'set_field':
      newValue = action.value;
      break;

    case 'adjust_price': {
      const current = parseFloat(oldValue) || 0;
      const amount = parseFloat(action.value) || 0;
      const mode = action.params?.mode || 'absolute';
      if (mode === 'percent') {
        newValue = Math.round(current * (1 + amount / 100) * 100) / 100;
      } else {
        newValue = Math.round((current + amount) * 100) / 100;
      }
      break;
    }

    case 'prepend_text':
      newValue = String(action.value ?? '') + String(oldValue ?? '');
      break;

    case 'append_text':
      newValue = String(oldValue ?? '') + String(action.value ?? '');
      break;

    case 'replace_text': {
      const search = action.params?.search || '';
      const replace = action.params?.replace ?? '';
      if (!search) return null;
      newValue = String(oldValue ?? '').split(search).join(replace);
      break;
    }

    default:
      return null;
  }

  // Only record if value actually changed
  if (oldValue === newValue) return null;

  setNestedField(product, field, newValue);
  return { field, oldValue, newValue };
}

function applyActions(product, actions) {
  if (!Array.isArray(actions)) return [];
  const changes = [];
  for (const action of actions) {
    const change = applyAction(product, action);
    if (change) changes.push(change);
  }
  return changes;
}

/* ─── Product Matching ─── */

async function getMatchingProducts(tenantId, conditions, limit = 1000) {
  const db = getDb();
  const snap = await db.collection(PRODUCTS_COLLECTION)
    .where('tenantId', '==', tenantId)
    .limit(Math.min(limit, 5000))
    .get();

  const matched = [];
  for (const doc of snap.docs) {
    const product = { id: doc.id, ...doc.data() };
    if (evaluateConditions(product, conditions)) {
      matched.push(product);
    }
  }
  return matched;
}

/* ─── Rule Execution ─── */

async function executeRule(ruleId, mode = 'dry_run', limit = 1000) {
  const db = getDb();
  const ruleSnap = await db.collection(RULES_COLLECTION).doc(ruleId).get();
  if (!ruleSnap.exists) throw new Error('Regel nicht gefunden');

  const rule = ruleSnap.data();
  const tenantId = rule.tenantId || 'default';

  // Create automation job
  const jobDoc = {
    tenantId,
    ruleId,
    status: 'pending',
    mode,
    progress: { total: 0, processed: 0, applied: 0, skipped: 0, errors: 0 },
    result: null,
    error: null,
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const jobRef = await db.collection(JOBS_COLLECTION).add(jobDoc);
  return { jobId: jobRef.id, status: 'pending' };
}

module.exports = {
  getNestedField,
  setNestedField,
  evaluateCondition,
  evaluateConditions,
  applyAction,
  applyActions,
  getMatchingProducts,
  executeRule,
  RULES_COLLECTION,
  JOBS_COLLECTION,
  PRODUCTS_COLLECTION,
  getDb,
};
