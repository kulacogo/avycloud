'use strict';

/**
 * webhooks.js — Incoming webhook handlers for external services.
 *
 * These routes are PUBLIC (no auth middleware) because they receive
 * machine-to-machine callbacks from SendCloud, etc.
 * Security: Validated via shared secret or signature verification.
 */

const express = require('express');
const router = express.Router();
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { emitSyncEvent } = require('../services/sync-event-bus');

const SHIPMENTS_COLLECTION = 'shipments';
const ORDERS_COLLECTION = 'orders';
const ORDER_EVENTS_COLLECTION = 'order_events';

let _db;
function getDb() {
  if (!_db) _db = new Firestore();
  return _db;
}

/**
 * SendCloud status ID → OMS status mapping.
 * See: https://docs.sendcloud.sc/api/v2/shipping/#parcel-statuses
 */
const SENDCLOUD_STATUS_MAP = {
  1:    null,         // Announced (parcel created, not yet at carrier)
  3:    'shipped',    // Handed to carrier / en route
  4:    'shipped',    // Sorting
  5:    'shipped',    // Customs
  6:    'shipped',    // At sorting centre
  7:    'shipped',    // Being delivered
  8:    'shipped',    // Delivered attempt
  11:   'delivered',  // Delivered
  12:   'delivered',  // Delivered (at neighbour)
  62:   'delivered',  // Delivered at service point
  2000: null,         // Cancelled
  80:   null,         // Exception
  1002: null,         // Announcement failed
  1337: null,         // Ready to send (not yet picked up)
  // Return statuses
  15:   'returned',   // Return: being delivered back
  32:   'returned',   // Return: at sender
  33:   'returned',   // Return: delivered back to sender
};

/**
 * POST /api/webhooks/sendcloud — Receive tracking events from SendCloud.
 *
 * SendCloud sends JSON with: { action, timestamp, message, parcel_id, ... }
 * Key fields: parcel_id, status.id, status.message, tracking_number
 */
router.post('/webhooks/sendcloud', async (req, res) => {
  try {
    const body = req.body || {};
    const parcelId = body.parcel_id || body.parcel?.id;
    const statusId = body.status?.id || body.parcel?.status?.id;
    const statusMessage = body.status?.message || body.parcel?.status?.message || '';
    const trackingNumber = body.tracking_number || body.parcel?.tracking_number || null;
    const trackingUrl = body.parcel?.tracking_url || null;

    if (!parcelId) {
      return res.status(200).json({ ok: true, skipped: 'no parcel_id' });
    }

    const db = getDb();

    // Find shipment by SendCloud parcel ID
    const shipSnap = await db.collection(SHIPMENTS_COLLECTION)
      .where('sendcloudParcelId', '==', Number(parcelId))
      .limit(1)
      .get();

    if (shipSnap.empty) {
      // Unknown parcel — acknowledge but don't process
      console.log(`[webhook/sendcloud] Unknown parcel ${parcelId}, ignoring`);
      return res.status(200).json({ ok: true, skipped: 'unknown parcel' });
    }

    const shipDoc = shipSnap.docs[0];
    const shipData = shipDoc.data();
    const orderId = shipData.orderId;

    // Update shipment record
    const shipUpdate = {
      status: statusMessage,
      statusId: statusId || null,
      updatedAt: new Date().toISOString(),
    };
    if (trackingNumber) shipUpdate.trackingNumber = trackingNumber;
    if (trackingUrl) shipUpdate.trackingUrl = trackingUrl;

    await shipDoc.ref.set(shipUpdate, { merge: true });

    // Map SendCloud status to OMS status
    const omsStatus = SENDCLOUD_STATUS_MAP[statusId] || null;

    if (omsStatus && orderId) {
      const orderRef = db.collection(ORDERS_COLLECTION).doc(orderId);
      const orderSnap = await orderRef.get();

      if (orderSnap.exists) {
        const order = orderSnap.data();
        const currentOmsStatus = order.omsStatus || order.status || 'pending';

        // Only update if the new status is "forward" in the pipeline
        const statusOrder = { pending: 0, confirmed: 1, picking: 2, picked: 3, packing: 4, packed: 5, shipped: 6, delivered: 7, completed: 8 };
        const currentIdx = statusOrder[currentOmsStatus] ?? -1;
        const newIdx = statusOrder[omsStatus] ?? -1;

        if (newIdx > currentIdx) {
          const { ORDER_STATUSES } = require('../services/order-state-machine');
          const update = {
            omsStatus,
            omsStatusLabel: ORDER_STATUSES[omsStatus]?.label || omsStatus,
            updatedAt: new Date().toISOString(),
          };
          if (trackingNumber) update.trackingNumber = trackingNumber;
          if (trackingUrl) update.trackingUrl = trackingUrl;
          if (omsStatus === 'shipped') update.shippedAt = new Date().toISOString();
          if (omsStatus === 'delivered') update.deliveredAt = new Date().toISOString();

          await orderRef.set(update, { merge: true });

          // Log event
          await db.collection(ORDER_EVENTS_COLLECTION).add({
            orderId,
            tenantId: shipData.tenantId || 'default',
            event: 'status_change',
            fromStatus: currentOmsStatus,
            toStatus: omsStatus,
            fromStatusLabel: ORDER_STATUSES[currentOmsStatus]?.label || currentOmsStatus,
            toStatusLabel: ORDER_STATUSES[omsStatus]?.label || omsStatus,
            actor: { uid: 'system', email: 'sendcloud-webhook' },
            note: `SendCloud: ${statusMessage}`,
            timestamp: FieldValue.serverTimestamp(),
          });

          console.log(`[webhook/sendcloud] Order ${orderId}: ${currentOmsStatus} → ${omsStatus} (parcel ${parcelId})`);
        }
      }
    }

    // Event-driven sync: SendCloud status change → trigger full sync cascade
    emitSyncEvent('shipment:updated', {
      entityId: orderId || `parcel-${parcelId}`,
      tenantId: 'default',
      statusId,
      source: 'sendcloud-webhook',
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`[POST /api/webhooks/sendcloud] ${err.message}`, err);
    // Always return 200 to prevent SendCloud from retrying
    return res.status(200).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/webhooks/kaufland — Receive order/return events from Kaufland.
 *
 * Kaufland Push Notifications send JSON with event_name + payload.
 * We trigger a full sync on any relevant event.
 */
router.post('/webhooks/kaufland', async (req, res) => {
  try {
    const body = req.body || {};
    const eventName = body.event_name || body.event || '';
    const payload = body.data || body.payload || {};

    console.log(`[webhook/kaufland] event=${eventName} keys=${Object.keys(payload).join(',')}`);

    // Relevant events: new_order, order_unit_status_changed, return_created, etc.
    const orderEvents = ['new_order', 'order_unit_status_changed', 'order_cancelled', 'order_shipped'];
    const returnEvents = ['return_created', 'return_updated', 'return_accepted', 'return_rejected'];

    if (orderEvents.some((e) => eventName.includes(e))) {
      emitSyncEvent('order:updated', {
        entityId: payload.id_order || payload.order_id || 'kaufland',
        tenantId: 'default',
        source: `kaufland-webhook:${eventName}`,
      });
    }

    if (returnEvents.some((e) => eventName.includes(e))) {
      emitSyncEvent('return:created', {
        entityId: payload.id_return || payload.return_id || 'kaufland',
        tenantId: 'default',
        source: `kaufland-webhook:${eventName}`,
      });
    }

    // Fallback: any unknown event still triggers order sync
    if (!orderEvents.some((e) => eventName.includes(e)) && !returnEvents.some((e) => eventName.includes(e))) {
      emitSyncEvent('order:updated', {
        entityId: 'kaufland-unknown',
        tenantId: 'default',
        source: `kaufland-webhook:${eventName}`,
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`[POST /api/webhooks/kaufland] ${err.message}`, err);
    return res.status(200).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/webhooks/ebay — Receive marketplace notifications from eBay.
 *
 * eBay Platform Notifications (REST or Trading API) push JSON/XML.
 * We trigger appropriate syncs based on notification type.
 */
router.post('/webhooks/ebay', async (req, res) => {
  try {
    const body = req.body || {};

    // eBay Marketplace Account Deletion/Closure (GDPR) — required endpoint
    if (body.metadata?.topic === 'MARKETPLACE_ACCOUNT_DELETION') {
      console.log('[webhook/ebay] Account deletion notification received');
      return res.status(200).json({ ok: true });
    }

    const notificationType = body.metadata?.topic || body.NotificationEventName || body.topic || '';
    console.log(`[webhook/ebay] type=${notificationType}`);

    // eBay notification types
    const orderTypes = [
      'MARKETPLACE_ORDER_CREATED', 'MARKETPLACE_ORDER_COMPLETED',
      'ORDER_CREATED', 'FIXED_PRICE_TRANSACTION', 'CHECKOUT_COMPLETE',
      'ORDER_STATUS_CHANGE',
    ];
    const returnTypes = [
      'RETURN_CREATED', 'RETURN_CLOSED', 'RETURN_ESCALATED',
      'ITEM_RETURNED',
    ];

    if (orderTypes.some((t) => notificationType.includes(t))) {
      emitSyncEvent('order:updated', {
        entityId: body.resource?.orderId || body.OrderID || 'ebay',
        tenantId: 'default',
        source: `ebay-webhook:${notificationType}`,
      });
    }

    if (returnTypes.some((t) => notificationType.includes(t))) {
      emitSyncEvent('return:created', {
        entityId: body.resource?.returnId || 'ebay',
        tenantId: 'default',
        source: `ebay-webhook:${notificationType}`,
      });
    }

    // eBay challenge response (webhook verification)
    if (req.query.challenge_code) {
      const crypto = require('crypto');
      const verificationToken = process.env.EBAY_WEBHOOK_VERIFICATION_TOKEN || '';
      const endpoint = process.env.EBAY_WEBHOOK_ENDPOINT || '';
      const hash = crypto.createHash('sha256')
        .update(req.query.challenge_code + verificationToken + endpoint)
        .digest('hex');
      return res.status(200).json({ challengeResponse: hash });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`[POST /api/webhooks/ebay] ${err.message}`, err);
    return res.status(200).json({ ok: false, error: err.message });
  }
});

module.exports = router;
