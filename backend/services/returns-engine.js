'use strict';

/**
 * returns-engine.js — Returns Management Engine.
 *
 * Handles marketplace return intake (eBay + Kaufland), workflow state machine,
 * reason categorization, and refund communication.
 */

const { FieldValue } = require('@google-cloud/firestore');
const { firestore } = require('../lib/firestore');

const RETURNS_COLLECTION = 'returns';
const ORDERS_COLLECTION = 'orders';
const RETURN_EVENTS_COLLECTION = 'return_events';

function getDb() {
  return firestore;
}

// ─── Return Status Flow ──────────────────────────────────────

const RETURN_STATUSES = [
  'eingegangen',    // Return received/created
  'in_pruefung',    // Under review / inspection
  'erstattet',      // Refunded
  'teilweise_erstattet', // Partially refunded
  'abgelehnt',      // Rejected
  'abgeschlossen',  // Closed / finalized
];

const VALID_TRANSITIONS = {
  eingegangen:         ['in_pruefung', 'erstattet', 'abgelehnt'],
  in_pruefung:         ['erstattet', 'teilweise_erstattet', 'abgelehnt'],
  erstattet:           ['abgeschlossen'],
  teilweise_erstattet: ['abgeschlossen'],
  abgelehnt:           ['abgeschlossen', 'in_pruefung'], // Can re-open
  abgeschlossen:       [], // Terminal
};

// ─── Return Reason Categories ────────────────────────────────

const RETURN_REASONS = {
  defekt:              { label: 'Defekt / Beschädigt', refundDefault: 'full' },
  falsche_lieferung:   { label: 'Falsche Lieferung', refundDefault: 'full' },
  nicht_wie_beschrieben: { label: 'Nicht wie beschrieben', refundDefault: 'full' },
  zu_spaet:            { label: 'Zu spät geliefert', refundDefault: 'full' },
  meinungsaenderung:   { label: 'Meinungsänderung', refundDefault: 'full' },
  doppelbestellung:    { label: 'Doppelbestellung', refundDefault: 'full' },
  sonstiges:           { label: 'Sonstiges', refundDefault: 'partial' },
};

/**
 * eBay return reason → internal category mapping.
 */
const EBAY_REASON_MAP = {
  ARRIVED_DAMAGED:       'defekt',
  WRONG_ITEM_SENT:       'falsche_lieferung',
  NOT_AS_DESCRIBED:      'nicht_wie_beschrieben',
  LATE_DELIVERY:         'zu_spaet',
  BUYERS_REMORSE:        'meinungsaenderung',
  DUPLICATE_PURCHASE:    'doppelbestellung',
  OTHER:                 'sonstiges',
  DEFECTIVE:             'defekt',
  ITEM_BROKEN:           'defekt',
};

/**
 * Kaufland return reason → internal category mapping.
 */
const KAUFLAND_REASON_MAP = {
  WRONG_PRODUCT_DELIVERED: 'falsche_lieferung',
  DEFECTIVE:               'defekt',
  ITEM_NOT_AS_DESCRIBED:   'nicht_wie_beschrieben',
  NO_LONGER_NEEDED:        'meinungsaenderung',
  TOO_LATE:                'zu_spaet',
  DUPLICATE_ORDER:         'doppelbestellung',
  OTHER:                   'sonstiges',
};

// ─── Return Workflow ─────────────────────────────────────────

/**
 * Transition a return to a new status with validation.
 *
 * @param {{
 *   returnId: string,
 *   toStatus: string,
 *   actor?: { uid: string, email: string },
 *   note?: string,
 *   itemCondition?: 'a_ware' | 'b_ware' | 'c_ware',
 *   refundAmount?: number,
 *   refundType?: 'full' | 'partial' | 'none',
 * }} opts
 * @returns {Promise<{ id: string, status: string }>}
 */
async function transitionReturn({
  returnId,
  toStatus,
  actor = { uid: 'system', email: 'api' },
  note = '',
  itemCondition,
  refundAmount,
  refundType,
}) {
  if (!returnId) throw new Error('returnId required');
  if (!RETURN_STATUSES.includes(toStatus)) {
    throw new Error(`Ungültiger Status: ${toStatus}`);
  }

  const db = getDb();
  const ref = db.collection(RETURNS_COLLECTION).doc(returnId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Retoure nicht gefunden');

  const current = snap.data();
  const fromStatus = current.status || 'eingegangen';

  const allowed = VALID_TRANSITIONS[fromStatus] || [];
  if (!allowed.includes(toStatus)) {
    throw new Error(`Übergang ${fromStatus} → ${toStatus} nicht erlaubt`);
  }

  const update = {
    status: toStatus,
    updatedAt: new Date().toISOString(),
  };

  if (itemCondition) update.itemCondition = itemCondition;
  if (refundAmount !== undefined) update.refundAmount = refundAmount;
  if (refundType) update.refundType = refundType;

  // Auto-set restock flag for A/B-ware
  if (itemCondition === 'a_ware' || itemCondition === 'b_ware') {
    update.restock = true;
  }
  if (itemCondition === 'c_ware') {
    update.restock = false;
  }

  await ref.set(update, { merge: true });

  // Log event
  await db.collection(RETURN_EVENTS_COLLECTION).add({
    returnId,
    fromStatus,
    toStatus,
    actor,
    note,
    itemCondition: itemCondition || null,
    refundAmount: refundAmount || null,
    timestamp: new Date().toISOString(),
  });

  return { id: returnId, status: toStatus };
}

/**
 * Process return: inspect item, decide refund, and optionally restock.
 *
 * @param {{
 *   returnId: string,
 *   tenantId?: string,
 *   itemCondition: 'a_ware' | 'b_ware' | 'c_ware',
 *   refundType: 'full' | 'partial' | 'none',
 *   refundAmount?: number,
 *   note?: string,
 *   actor?: object,
 * }} opts
 * @returns {Promise<{ id: string, status: string, restock: boolean }>}
 */
async function processReturn({
  returnId,
  tenantId = 'default',
  itemCondition,
  refundType,
  refundAmount,
  note = '',
  actor = { uid: 'system', email: 'api' },
}) {
  const db = getDb();
  const snap = await db.collection(RETURNS_COLLECTION).doc(returnId).get();
  if (!snap.exists) throw new Error('Retoure nicht gefunden');
  const ret = snap.data();

  // Determine target status based on refund decision
  let toStatus;
  if (refundType === 'none') {
    toStatus = 'abgelehnt';
  } else if (refundType === 'partial') {
    toStatus = 'teilweise_erstattet';
  } else {
    toStatus = 'erstattet';
  }

  // If item not yet in review, transition there first
  if (ret.status === 'eingegangen') {
    await transitionReturn({
      returnId, toStatus: 'in_pruefung', actor, note: 'Warenprüfung gestartet',
    });
  }

  // Calculate refund amount if not provided
  let finalAmount = refundAmount;
  if (finalAmount === undefined) {
    if (refundType === 'full') {
      finalAmount = ret.refundAmount || ret.orderAmount || 0;
    } else if (refundType === 'partial') {
      finalAmount = Math.round((ret.orderAmount || 0) * 0.5 * 100) / 100; // Default 50%
    } else {
      finalAmount = 0;
    }
  }

  // Transition to final status
  const result = await transitionReturn({
    returnId, toStatus, actor, note,
    itemCondition, refundAmount: finalAmount, refundType,
  });

  // Restock if A/B ware
  const shouldRestock = itemCondition === 'a_ware' || itemCondition === 'b_ware';
  if (shouldRestock && ret.orderId) {
    try {
      await restockItem({ returnId, orderId: ret.orderId, itemCondition, tenantId });
    } catch (err) {
      console.error(`[returns-engine] Restock failed for return ${returnId}: ${err.message}`);
    }
  }

  return { id: returnId, status: toStatus, restock: shouldRestock };
}

/**
 * Restock returned item back to inventory.
 *
 * @param {{ returnId: string, orderId: string, itemCondition: string, tenantId?: string }} opts
 */
async function restockItem({ returnId, orderId, itemCondition, tenantId = 'default' }) {
  const db = getDb();

  // Load original order to get product info
  const orderSnap = await db.collection(ORDERS_COLLECTION).doc(orderId).get();
  if (!orderSnap.exists) return;
  const order = orderSnap.data();

  const returnSnap = await db.collection(RETURNS_COLLECTION).doc(returnId).get();
  const ret = returnSnap.exists ? returnSnap.data() : {};

  // Find the returned product in order items
  const items = order.items || [];
  const returnedItem = ret.product
    ? items.find((i) => i.sku === ret.product?.sku || i.name === ret.product?.name)
    : items[0];

  if (!returnedItem) return;

  // Log warehouse movement for restock
  await db.collection('warehouse_movements').add({
    tenantId,
    type: 'restock_return',
    productSku: returnedItem.sku || null,
    productName: returnedItem.name || null,
    quantity: returnedItem.quantity || 1,
    condition: itemCondition,
    returnId,
    orderId,
    note: `Wiedereinlagerung aus Retoure (${itemCondition === 'a_ware' ? 'A-Ware' : 'B-Ware reduziert'})`,
    createdAt: new Date().toISOString(),
  });
}

// ─── Marketplace Return Intake ───────────────────────────────

/**
 * Sync returns from eBay via Post-Order REST API.
 * Uses GET /post-order/v2/return/search (JSON, OAuth bearer token).
 *
 * @param {{ tenantId?: string, lookbackDays?: number }} opts
 * @returns {Promise<{ synced: number, skipped: number, errors: number }>}
 */
async function syncEbayReturns({ tenantId = 'default', lookbackDays = 30 } = {}) {
  const { getValidEbayAccessToken } = require('../lib/ebay-oauth');
  const db = getDb();

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const { accessToken, apiBaseUrl } = await getValidEbayAccessToken();
    const fromDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

    // eBay Post-Order API: GET /post-order/v2/return/search
    const searchUrl = new URL('/post-order/v2/return/search', apiBaseUrl);
    searchUrl.searchParams.set('creation_date_range_from', fromDate);
    searchUrl.searchParams.set('limit', '200');
    searchUrl.searchParams.set('offset', '0');
    searchUrl.searchParams.set('sort', 'RETURN_CREATION_DATE_DESC');

    const res = await fetch(searchUrl.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_DE',
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`eBay Post-Order API ${res.status}: ${body.slice(0, 500)}`);
    }

    const json = await res.json();
    const returnRequests = Array.isArray(json.members) ? json.members : [];

    for (const rr of returnRequests) {
      try {
        const marketplaceReturnId = rr.returnId || rr.returnRequest?.returnId || '';
        if (!marketplaceReturnId) continue;

        // Deduplicate by marketplace return ID
        const existing = await db.collection(RETURNS_COLLECTION)
          .where('marketplaceReturnId', '==', String(marketplaceReturnId))
          .where('marketplace', '==', 'ebay')
          .limit(1)
          .get();

        if (!existing.empty) {
          skipped++;
          continue;
        }

        // Map eBay Post-Order fields to our return schema
        const detail = rr.returnRequest || rr;
        const ebayReason = detail.reason || detail.returnReason || 'OTHER';
        const reason = EBAY_REASON_MAP[ebayReason] || 'sonstiges';

        const returnDoc = {
          tenantId,
          marketplace: 'ebay',
          marketplaceReturnId: String(marketplaceReturnId),
          marketplaceOrderId: detail.orderId || null,
          orderId: null,
          customer: {
            name: detail.buyerLoginName || null,
            email: null,
          },
          product: {
            name: detail.itemTitle || null,
            sku: detail.sellerResponse?.itemSku || null,
            quantity: detail.returnQuantity || 1,
          },
          reason,
          reasonRaw: ebayReason,
          reasonText: detail.comments?.content || detail.buyerComments || null,
          refundAmount: parseFloat(detail.estimatedRefundAmount?.value || detail.actualRefundAmount?.value || '0') || 0,
          currency: detail.estimatedRefundAmount?.currency || detail.actualRefundAmount?.currency || 'EUR',
          status: 'eingegangen',
          marketplaceStatus: detail.state || detail.status || null,
          createdAt: detail.creationDate || new Date().toISOString(),
          syncedAt: new Date().toISOString(),
        };

        // Try to link to our order by marketplace order ID
        if (returnDoc.marketplaceOrderId) {
          const orderSnap = await db.collection(ORDERS_COLLECTION)
            .where('marketplaceOrderId', '==', returnDoc.marketplaceOrderId)
            .limit(1)
            .get();
          if (!orderSnap.empty) {
            returnDoc.orderId = orderSnap.docs[0].id;
            returnDoc.orderAmount = orderSnap.docs[0].data().totalAmount || 0;
          }
        }

        await db.collection(RETURNS_COLLECTION).add(returnDoc);
        synced++;
      } catch (err) {
        console.error(`[returns-engine] eBay return parse error: ${err.message}`);
        errors++;
      }
    }
  } catch (err) {
    console.error(`[returns-engine] eBay returns sync failed: ${err.message}`);
    errors++;
    console.log(`[returns-engine] eBay sync: ${synced} synced, ${skipped} skipped, ${errors} errors`);
    return { synced, skipped, errors, errorMessage: err.message };
  }

  console.log(`[returns-engine] eBay sync: ${synced} synced, ${skipped} skipped, ${errors} errors`);
  return { synced, skipped, errors };
}

/**
 * Sync returns from Kaufland via GET /returns.
 *
 * @param {{ tenantId?: string, lookbackDays?: number }} opts
 * @returns {Promise<{ synced: number, skipped: number, errors: number }>}
 */
async function syncKauflandReturns({ tenantId = 'default', lookbackDays = 30 } = {}) {
  const { kauflandRequest } = require('../lib/kaufland-api');
  const db = getDb();

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const fromDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

    const result = await kauflandRequest('GET', '/returns', {
      query: {
        ts_created_from_iso: fromDate,
        limit: 100,
        sort: 'ts_created:desc',
      },
    });

    const returns = Array.isArray(result?.data) ? result.data : [];

    for (const kr of returns) {
      try {
        const marketplaceReturnId = String(kr.id_return || kr.id || '');
        if (!marketplaceReturnId) continue;

        // Deduplicate
        const existing = await db.collection(RETURNS_COLLECTION)
          .where('marketplaceReturnId', '==', marketplaceReturnId)
          .where('marketplace', '==', 'kaufland')
          .limit(1)
          .get();

        if (!existing.empty) {
          skipped++;
          continue;
        }

        const klReason = kr.reason || 'OTHER';
        const reason = KAUFLAND_REASON_MAP[klReason] || 'sonstiges';

        const returnDoc = {
          tenantId,
          marketplace: 'kaufland',
          marketplaceReturnId,
          marketplaceOrderId: kr.id_order ? String(kr.id_order) : null,
          orderId: null,
          customer: {
            name: kr.buyer_name || kr.buyer?.name || null,
            email: kr.buyer_email || kr.buyer?.email || null,
          },
          product: {
            name: kr.product_title || kr.title || null,
            sku: kr.id_offer ? String(kr.id_offer) : null,
            quantity: kr.quantity || 1,
          },
          reason,
          reasonRaw: klReason,
          reasonText: kr.reason_comment || kr.note || null,
          refundAmount: parseFloat(kr.refund_amount || '0') || 0,
          currency: 'EUR',
          status: 'eingegangen',
          marketplaceStatus: kr.status || null,
          createdAt: kr.ts_created || new Date().toISOString(),
          syncedAt: new Date().toISOString(),
        };

        // Link to order
        if (returnDoc.marketplaceOrderId) {
          const orderSnap = await db.collection(ORDERS_COLLECTION)
            .where('marketplaceOrderId', '==', returnDoc.marketplaceOrderId)
            .limit(1)
            .get();
          if (!orderSnap.empty) {
            returnDoc.orderId = orderSnap.docs[0].id;
            returnDoc.orderAmount = orderSnap.docs[0].data().totalAmount || 0;
          }
        }

        await db.collection(RETURNS_COLLECTION).add(returnDoc);
        synced++;
      } catch (err) {
        console.error(`[returns-engine] Kaufland return parse error: ${err.message}`);
        errors++;
      }
    }
  } catch (err) {
    console.error(`[returns-engine] Kaufland returns sync failed: ${err.message}`);
    errors++;
    console.log(`[returns-engine] Kaufland sync: ${synced} synced, ${skipped} skipped, ${errors} errors`);
    return { synced, skipped, errors, errorMessage: err.message };
  }

  console.log(`[returns-engine] Kaufland sync: ${synced} synced, ${skipped} skipped, ${errors} errors`);
  return { synced, skipped, errors };
}

/**
 * Sync returns from all configured marketplaces.
 *
 * @param {{ tenantId?: string, lookbackDays?: number }} opts
 * @returns {Promise<{ ebay: object, kaufland: object }>}
 */
async function syncAllReturns({ tenantId = 'default', lookbackDays = 30 } = {}) {
  const results = {};

  try {
    results.ebay = await syncEbayReturns({ tenantId, lookbackDays });
  } catch (err) {
    results.ebay = { synced: 0, skipped: 0, errors: 1, error: err.message };
  }

  try {
    results.kaufland = await syncKauflandReturns({ tenantId, lookbackDays });
  } catch (err) {
    results.kaufland = { synced: 0, skipped: 0, errors: 1, error: err.message };
  }

  return results;
}

// ─── Marketplace Refund APIs ─────────────────────────────────

/**
 * Issue a refund via the marketplace API.
 *
 * @param {{ returnId: string, tenantId?: string, actor?: object }} opts
 * @returns {Promise<{ ok: boolean, marketplace?: string, error?: string }>}
 */
async function issueMarketplaceRefund({ returnId, tenantId = 'default', actor }) {
  const db = getDb();
  const snap = await db.collection(RETURNS_COLLECTION).doc(returnId).get();
  if (!snap.exists) throw new Error('Retoure nicht gefunden');

  const ret = snap.data();
  const marketplace = (ret.marketplace || '').toLowerCase();

  if (marketplace === 'ebay') {
    return issueEbayRefund({ ret, returnId });
  }
  if (marketplace === 'kaufland') {
    return issueKauflandRefund({ ret, returnId });
  }

  return { ok: true, marketplace, skipped: 'No marketplace refund needed' };
}

/**
 * Issue eBay refund via Post-Order REST API.
 * POST /post-order/v2/return/{returnId}/issue_refund
 */
async function issueEbayRefund({ ret, returnId }) {
  try {
    const { getValidEbayAccessToken } = require('../lib/ebay-oauth');

    const marketplaceReturnId = ret.marketplaceReturnId;
    if (!marketplaceReturnId) return { ok: false, marketplace: 'ebay', error: 'No eBay return ID' };

    const { accessToken, apiBaseUrl } = await getValidEbayAccessToken();
    const amount = ret.refundAmount || 0;
    const refundType = ret.refundType === 'partial' ? 'OTHER' : 'FULL_REFUND';

    const refundUrl = `${apiBaseUrl}/post-order/v2/return/${encodeURIComponent(marketplaceReturnId)}/issue_refund`;

    const res = await fetch(refundUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_DE',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        comments: { content: `Refund issued via AvyCloud` },
        refundDetail: {
          itemizedRefundDetail: [{
            refundAmount: { value: amount.toFixed(2), currency: ret.currency || 'EUR' },
            refundFeeType: refundType,
          }],
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`eBay refund API ${res.status}: ${body.slice(0, 500)}`);
    }

    console.log(`[returns-engine] eBay refund for return ${marketplaceReturnId}: success`);

    // Update return with refund status
    await getDb().collection(RETURNS_COLLECTION).doc(returnId).set({
      marketplaceRefundStatus: 'issued',
      marketplaceRefundAt: new Date().toISOString(),
    }, { merge: true });

    return { ok: true, marketplace: 'ebay' };
  } catch (err) {
    console.error(`[returns-engine] eBay refund failed: ${err.message}`);
    return { ok: false, marketplace: 'ebay', error: err.message };
  }
}

/**
 * Issue Kaufland refund via API.
 */
async function issueKauflandRefund({ ret, returnId }) {
  try {
    const { kauflandRequest } = require('../lib/kaufland-api');

    const marketplaceReturnId = ret.marketplaceReturnId;
    if (!marketplaceReturnId) return { ok: false, marketplace: 'kaufland', error: 'No Kaufland return ID' };

    await kauflandRequest('PATCH', `/returns/${marketplaceReturnId}/accept`, {
      body: {
        refund_amount: ret.refundAmount || 0,
      },
    });

    console.log(`[returns-engine] Kaufland refund for return ${marketplaceReturnId}`);

    await getDb().collection(RETURNS_COLLECTION).doc(returnId).set({
      marketplaceRefundStatus: 'issued',
      marketplaceRefundAt: new Date().toISOString(),
    }, { merge: true });

    return { ok: true, marketplace: 'kaufland' };
  } catch (err) {
    console.error(`[returns-engine] Kaufland refund failed: ${err.message}`);
    return { ok: false, marketplace: 'kaufland', error: err.message };
  }
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Extract array from XML-parsed object (handles single item vs array).
 */
function extractArray(obj, key) {
  if (!obj || !obj[key]) return [];
  return Array.isArray(obj[key]) ? obj[key] : [obj[key]];
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = {
  // Workflow
  transitionReturn,
  processReturn,
  restockItem,

  // Marketplace Intake
  syncEbayReturns,
  syncKauflandReturns,
  syncAllReturns,

  // Refunds
  issueMarketplaceRefund,

  // Constants
  RETURN_STATUSES,
  VALID_TRANSITIONS,
  RETURN_REASONS,
  EBAY_REASON_MAP,
  KAUFLAND_REASON_MAP,
};
