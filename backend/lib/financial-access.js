'use strict';

// Sales prices, order totals and carrier quotes remain operational data. Cost
// bases, marketplace settlements and internal valuations are finance data.
const FINANCIAL_FIELDS = new Set([
  'buyPrice', 'ekBrutto', 'ekJeEinheitBrutto', 'restwertBrutto', 'abgangswertBrutto',
  'marketplaceRefunds', 'refundedTotal', 'netAmount', 'costModel',
]);
function stripFinancialFields(value) {
  if (Array.isArray(value)) return value.map(stripFinancialFields);
  if (!value || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !FINANCIAL_FIELDS.has(key)).map(([key, item]) => [key, stripFinancialFields(item)]));
}
function containsFinancialWrite(value) {
  if (Array.isArray(value)) return value.some(containsFinancialWrite);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) =>
    (FINANCIAL_FIELDS.has(key.split('.').pop()) && item !== undefined) ||
    ((key === 'field' || key === 'targetField') && typeof item === 'string' && FINANCIAL_FIELDS.has(item.split('.').pop())) ||
    (key === 'mapping' && item && Object.values(item).some(field => FINANCIAL_FIELDS.has(String(field).split('.').pop()))) ||
    containsFinancialWrite(item)
  );
}
module.exports = { stripFinancialFields, containsFinancialWrite };
