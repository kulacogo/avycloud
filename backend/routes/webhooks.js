'use strict';

/**
 * webhooks.js — Incoming webhook handlers for external services.
 *
 * These routes are PUBLIC (no auth middleware) because they receive
 * machine-to-machine callbacks from SendCloud, etc.
 * Security: Validated via shared secret or signature verification.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { Firestore } = require('@google-cloud/firestore');
const { emitSyncEvent } = require('../services/sync-event-bus');

const SHIPMENTS_COLLECTION = 'shipments';
const ORDERS_COLLECTION = 'orders';

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
    // Verify SendCloud webhook authenticity via secret key in query or basic auth
    const { getIntegrationSecret } = require('../services/integration-store');
    const webhookSecret = await getIntegrationSecret('SENDCLOUD_SECRET_KEY').catch(() => null);

    // HARDEN-4 (2026-05-20): fail-closed in Production wenn Secret fehlt.
    // Vorher: kein Secret → Block übersprungen → jede Anfrage akzeptiert.
    // Spoofed-Webhook konnte `omsStatus` und Stock pushen ohne Auth.
    if (!webhookSecret) {
      if (process.env.NODE_ENV === 'production') {
        console.error('[webhook/sendcloud] CRITICAL: SENDCLOUD_SECRET_KEY missing in production — refusing webhook');
        return res.status(503).json({ ok: false, error: 'webhook_secret_unavailable' });
      }
      // Dev / local: warn aber nicht blocken (kein Secret-Manager lokal).
      console.warn('[webhook/sendcloud] SENDCLOUD_SECRET_KEY missing — skipping verification (NODE_ENV != production)');
    }

    if (webhookSecret) {
      const authHeader = req.headers.authorization || '';
      const querySecret = req.query?.secret || '';
      // SendCloud can send Basic auth (public_key:secret_key) or we verify via query param
      let verified = false;
      if (authHeader.startsWith('Basic ')) {
        const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
        // HARDEN-4: nutze exakten Match auf `<public_key>:<secret_key>` statt naivem includes()
        // (vorher: ein böser public_key der den secret enthält wäre durchgekommen).
        const [, candidateSecret] = decoded.split(':');
        verified = typeof candidateSecret === 'string' && candidateSecret.length > 0 && candidateSecret === webhookSecret;
      }
      if (!verified && querySecret === webhookSecret) verified = true;
      if (!verified) {
        console.warn('[webhook/sendcloud] Unauthorized webhook attempt');
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
    }

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

        // HARDEN-Wave-7 (2026-05-22): zentraler Helper statt inline dupliziert.
        // Forward-Rank-Map (terminal-blocker mit cancelled=99/on_hold=98) lebt
        // jetzt in backend/lib/order-status-helpers.js — gleiche Semantik.
        const { getOmsForwardRank } = require('../lib/order-status-helpers');
        const currentIdx = getOmsForwardRank(currentOmsStatus);
        const newIdx = getOmsForwardRank(omsStatus);

        if (newIdx > currentIdx) {
          if (omsStatus === 'shipped' || omsStatus === 'delivered') {
            // State Machine nutzen fuer shipped/delivered (triggert Stock-Decrement + Side-Effects)
            const { transitionOrder, processShippedOrder } = require('../services/order-state-machine');
            const webhookTenantId = shipData.tenantId || 'default';
            const transResult = await transitionOrder({
              tenantId: webhookTenantId,
              orderId,
              toStatus: omsStatus,
              force: true,
              actor: { uid: 'system', email: 'sendcloud-webhook' },
              note: `SendCloud: ${statusMessage}`,
              timestamps: omsStatus === 'shipped'
                ? { shippedAt: new Date().toISOString() }
                : { deliveredAt: new Date().toISOString() },
            }).catch((err) => {
              console.warn(`[webhook/sendcloud] transitionOrder failed for ${orderId}: ${err.message}`);
              return { ok: false };
            });

            // Fallback: processShippedOrder wenn Transition fehlschlaegt (already shipped)
            if (!transResult.ok && omsStatus === 'shipped') {
              await processShippedOrder({ orderId, tenantId: webhookTenantId })
                .catch((err) => console.warn(`[webhook/sendcloud] processShippedOrder failed for ${orderId}: ${err.message}`));
            }

            // Tracking backfill
            if (trackingNumber || trackingUrl) {
              await orderRef.set({
                ...(trackingNumber ? { trackingNumber } : {}),
                ...(trackingUrl ? { trackingUrl } : {}),
              }, { merge: true });
            }
          } else {
            // CLAUDE.md Punkt 11: KEIN omsStatus-Direct-Write mehr.
            // Andere Status (z.B. 'returned' aus SendCloud-IDs 15/32/33) laufen
            // jetzt AUSSCHLIESSLICH ueber die State-Machine. force:true umgeht die
            // Transition-Whitelist (Out-of-Order-Webhooks). transitionOrder schreibt
            // omsStatus + Timestamp + den order_events-Log atomar in EINER Tx UND
            // emittiert `order:status_changed`, damit Post-Transition-Hooks feuern.
            // Forward-Rank-Guard oben verhindert weiterhin Rueckwaerts-Spruenge.
            const { transitionOrder } = require('../services/order-state-machine');
            const webhookTenantId = shipData.tenantId || 'default';
            await transitionOrder({
              tenantId: webhookTenantId,
              orderId,
              toStatus: omsStatus,
              force: true,
              source: 'sendcloud-webhook',
              actor: { uid: 'system', email: 'sendcloud-webhook' },
              note: `SendCloud: ${statusMessage}`,
            }).catch((err) => {
              console.warn(`[webhook/sendcloud] transitionOrder failed for ${orderId} (${omsStatus}): ${err.message}`);
            });

            // Tracking backfill (additive, never via omsStatus)
            if (trackingNumber || trackingUrl) {
              await orderRef.set({
                ...(trackingNumber ? { trackingNumber } : {}),
                ...(trackingUrl ? { trackingUrl } : {}),
              }, { merge: true });
            }
          }

          console.log(`[webhook/sendcloud] Order ${orderId}: ${currentOmsStatus} → ${omsStatus} (parcel ${parcelId})`);
        }
      }
    }

    // Event-driven sync: SendCloud status change → trigger full sync cascade
    // HARDEN-7 (2026-05-20): nutze den Tenant aus dem geladenen Shipment-Doc
    // statt hardcoded 'default'. Multi-Tenant-Sync-Cascade läuft sonst auf
    // falschem Tenant.
    emitSyncEvent('shipment:updated', {
      entityId: orderId || `parcel-${parcelId}`,
      tenantId: shipData.tenantId || 'default',
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
    // HARDEN-3 (2026-05-20): Kaufland Push-Notification Signatur-Verifikation.
    //
    // Spec (Kaufland Marketplace Seller API):
    //   - Header `Shop-Signature`: HMAC-SHA256 hex digest of the request.
    //   - Header `Shop-Timestamp`: Unix-Sekunden des Events.
    //   - "Same function as API signing" — wir prüfen zwei plausible Varianten:
    //     a) HMAC(secret, rawBody)                        — body-only
    //     b) HMAC(secret, "POST\n<path>\n<rawBody>\n<ts>") — full API-signing-style
    //
    // Wenn EINE Variante matched (timing-safe) → akzeptiert. Sonst:
    //   - production: 401
    //   - dev: warn + pass (kein lokales Kaufland-Setup)
    //
    // Vorheriger Code: re-stringify(req.body) → byte mismatch → HMAC immer falsch
    // ABER fail-open mit 200 bei missing secret → spoofable.
    //
    // GET-Challenge (?mode=subscribe&challenge=...) wird in einer separaten
    // GET-Route behandelt — siehe unten.
    const { getSecretValue } = require('../lib/secret-values');
    const webhookSecret = await getSecretValue('KAUFLAND_WEBHOOK_SECRET').catch(() => null);

    if (!webhookSecret) {
      if (process.env.NODE_ENV === 'production') {
        console.error('[webhook/kaufland] CRITICAL: KAUFLAND_WEBHOOK_SECRET missing in production — refusing webhook');
        return res.status(503).json({ ok: false, error: 'webhook_secret_unavailable' });
      }
      console.warn('[webhook/kaufland] KAUFLAND_WEBHOOK_SECRET missing — skipping verification (NODE_ENV != production)');
    }

    if (webhookSecret) {
      const signature = String(req.headers['shop-signature'] || req.headers['x-kaufland-signature'] || req.headers['x-signature'] || '').trim();
      const timestamp = String(req.headers['shop-timestamp'] || '').trim();
      const rawBuf = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}), 'utf8');

      if (!signature) {
        console.warn('[webhook/kaufland] missing Shop-Signature header');
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }

      // Variante A: HMAC(secret, body)
      const hmacBodyOnly = crypto.createHmac('sha256', webhookSecret).update(rawBuf).digest('hex');
      // Variante B: HMAC(secret, METHOD\nPATH\nBODY\nTIMESTAMP)
      const requestPath = req.originalUrl?.split('?')[0] || req.url?.split('?')[0] || '/api/webhooks/kaufland';
      const composite = Buffer.concat([
        Buffer.from(`POST\n${requestPath}\n`, 'utf8'),
        rawBuf,
        Buffer.from(`\n${timestamp}`, 'utf8'),
      ]);
      const hmacComposite = crypto.createHmac('sha256', webhookSecret).update(composite).digest('hex');

      function timingSafeMatch(a, b) {
        const ba = Buffer.from(a, 'utf8');
        const bb = Buffer.from(b, 'utf8');
        if (ba.length !== bb.length) return false;
        return crypto.timingSafeEqual(ba, bb);
      }

      const matched = timingSafeMatch(signature, hmacBodyOnly) || timingSafeMatch(signature, hmacComposite);
      if (!matched) {
        console.warn(`[webhook/kaufland] HMAC mismatch — possible spoofing (sig=${signature.slice(0, 12)}…, ts=${timestamp})`);
        return res.status(401).json({ ok: false, error: 'invalid_signature' });
      }
    }

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
    // HARDEN-2 (2026-05-20): eBay POST-Notification-Signatur-Verifikation.
    //
    // Spec (eBay Notification API):
    //   - Header `x-ebay-signature`: base64-encoded JSON {kid, alg, signature}
    //   - Vollständige Verifikation = ECC-signature über payload mit public key
    //     den man via getPublicKey API holt (1h cache). Komplex; SDK empfohlen.
    //
    // Phase-1 (heute): minimaler Schutz — Header MUSS vorhanden sein.
    //   - production: 412 Precondition Failed (per eBay spec) wenn header fehlt
    //   - dev: warn + pass
    // Phase-2 (eigener Sprint): voller ECC-verify mit Notification-API-Public-Key.
    //
    // Vorher: jede POST-Request wurde ungeprüft akzeptiert → emitSyncEvent-DoS,
    // potenzielle Pollution der Sync-Cascade.
    const sigHeader = String(req.headers['x-ebay-signature'] || '').trim();
    if (!sigHeader) {
      if (process.env.NODE_ENV === 'production') {
        console.warn('[webhook/ebay] missing x-ebay-signature header — rejecting (HARDEN-2 phase-1)');
        return res.status(412).json({ ok: false, error: 'precondition_failed_missing_signature' });
      }
      console.warn('[webhook/ebay] missing x-ebay-signature header — passing in non-production');
    }

    const body = req.body || {};

    // eBay Marketplace Account Deletion/Closure (GDPR) — required endpoint
    if (body.metadata?.topic === 'MARKETPLACE_ACCOUNT_DELETION') {
      console.log('[webhook/ebay] Account deletion notification received');
      // HARDEN-2 phase-2 TODO: voller ECC-verify mit getPublicKey API + cache.
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
