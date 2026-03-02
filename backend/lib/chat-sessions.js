'use strict';

const { FieldValue } = require('@google-cloud/firestore');
const { firestore } = require('./firestore');

const COLLECTION = 'chatSessions';
const MAX_MESSAGES = 20; // 10 conversation pairs (user + model per round)

/**
 * Creates a stable, Firestore-safe document ID for a (user, product) pair.
 * One active session per user per product.
 */
function buildSessionId(userId, productId) {
  const safe = (s) => String(s || '').replace(/[^a-zA-Z0-9\-]/g, '_').slice(0, 64);
  return `${safe(userId)}__${safe(productId)}`;
}

/**
 * Loads an existing chat session document or returns null if none exists.
 */
async function getSession(userId, productId) {
  const sessionId = buildSessionId(userId, productId);
  const doc = await firestore.collection(COLLECTION).doc(sessionId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

/**
 * Atomically appends a (user, model) message pair to the session.
 * Creates the session document if it doesn't exist.
 * Trims to MAX_MESSAGES to keep Firestore document size bounded.
 */
async function appendMessages(sessionId, userId, productId, userText, modelText) {
  const ref = firestore.collection(COLLECTION).doc(sessionId);
  const now = new Date().toISOString();

  await firestore.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const existing = doc.exists && Array.isArray(doc.data()?.messages) ? doc.data().messages : [];

    const updated = [
      ...existing,
      { role: 'user', text: String(userText || '').slice(0, 2000), ts: now },
      { role: 'model', text: String(modelText || '').slice(0, 4000), ts: now },
    ].slice(-MAX_MESSAGES);

    if (doc.exists) {
      tx.update(ref, { messages: updated, updatedAt: FieldValue.serverTimestamp() });
    } else {
      tx.set(ref, {
        id: sessionId,
        userId,
        productId,
        messages: updated,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });
}

/**
 * Deletes a session document (resets conversation history for the given user+product).
 */
async function clearSession(userId, productId) {
  const sessionId = buildSessionId(userId, productId);
  await firestore.collection(COLLECTION).doc(sessionId).delete();
}

/**
 * Converts stored session messages into the Gemini chat history format.
 * Enforces strictly alternating user/model turns (Gemini API requirement).
 * Returns [] if no history exists.
 */
function getGeminiHistory(session) {
  if (!Array.isArray(session?.messages) || !session.messages.length) return [];

  const history = [];
  for (const msg of session.messages) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'model')) continue;
    // Skip consecutive same-role messages to maintain alternating turns
    const lastRole = history.length > 0 ? history[history.length - 1].role : null;
    if (lastRole === msg.role) continue;
    history.push({ role: msg.role, parts: [{ text: msg.text || '' }] });
  }
  return history;
}

module.exports = {
  buildSessionId,
  getSession,
  appendMessages,
  clearSession,
  getGeminiHistory,
};
