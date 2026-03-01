/**
 * Webhook-System
 *
 * Ermöglicht externen Systemen, auf AvyCloud-Events zu reagieren.
 * Events: order.created, order.shipped, product.updated, etc.
 */
const crypto = require('crypto');
const { firestore } = require('../lib/firestore');

const WEBHOOKS_COLLECTION = 'webhooks';

/**
 * Webhook erstellen.
 */
async function createWebhook({ url, events, secret, createdBy }) {
  if (!url || !events || !events.length) {
    throw new Error('url and events[] are required');
  }
  const webhookSecret = secret || crypto.randomBytes(32).toString('hex');
  const docRef = firestore.collection(WEBHOOKS_COLLECTION).doc();
  const data = {
    url,
    events,
    secret: webhookSecret,
    active: true,
    createdBy: createdBy || null,
    createdAt: new Date().toISOString(),
  };
  await docRef.set(data);
  return { id: docRef.id, ...data };
}

/**
 * Alle aktiven Webhooks laden.
 */
async function listWebhooks() {
  const snap = await firestore.collection(WEBHOOKS_COLLECTION).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Webhook löschen.
 */
async function deleteWebhook(webhookId) {
  await firestore.collection(WEBHOOKS_COLLECTION).doc(webhookId).delete();
}

/**
 * Alle aktiven Webhooks für ein bestimmtes Event finden.
 */
async function getActiveWebhooksForEvent(event) {
  const snap = await firestore.collection(WEBHOOKS_COLLECTION)
    .where('active', '==', true)
    .where('events', 'array-contains', event)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Webhook-Event an alle registrierten Empfänger senden.
 * Fire-and-forget — blockiert den Hauptprozess nicht.
 */
async function dispatchWebhook(event, payload) {
  const hooks = await getActiveWebhooksForEvent(event);
  for (const hook of hooks) {
    const body = JSON.stringify({ event, payload, timestamp: Date.now() });
    const signature = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');

    fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
      },
      body,
    }).catch(err => {
      console.error(`[webhook] ${hook.url} failed for event ${event}: ${err.message}`);
    });
  }
}

module.exports = {
  createWebhook,
  listWebhooks,
  deleteWebhook,
  getActiveWebhooksForEvent,
  dispatchWebhook,
};
