/* eslint-disable no-console */
/**
 * Rulebook admin storage (active config + versioning).
 */

const { Firestore, Timestamp } = require('@google-cloud/firestore');
const { setRulebookConfigCached, DEFAULT_CONFIG } = require('./rulebook-config');

const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
});

const COLLECTION = 'rulebookConfigs';
const ACTIVE_DOC_ID = 'active';

function versionsCollection() {
  return firestore.collection(COLLECTION).doc(ACTIVE_DOC_ID).collection('versions');
}

async function getActiveRulebook() {
  const snap = await firestore.collection(COLLECTION).doc(ACTIVE_DOC_ID).get();
  if (!snap.exists) {
    return {
      id: ACTIVE_DOC_ID,
      versionId: null,
      config: DEFAULT_CONFIG,
      updatedAt: null,
      updatedBy: null,
      note: null,
    };
  }
  const data = snap.data() || {};
  return {
    id: ACTIVE_DOC_ID,
    versionId: data.versionId || null,
    config: data.config || DEFAULT_CONFIG,
    updatedAt: data.updatedAt?.toDate?.().toISOString?.() || null,
    updatedBy: data.updatedBy || null,
    note: data.note || null,
  };
}

async function createRulebookVersion({ config, note = null, updatedBy = 'admin' } = {}) {
  const cleaned = config && typeof config === 'object' ? config : DEFAULT_CONFIG;
  const docRef = versionsCollection().doc();
  const payload = {
    config: cleaned,
    note: note || null,
    createdAt: Timestamp.now(),
    createdBy: updatedBy || 'admin',
  };
  await docRef.set(payload);

  await firestore.collection(COLLECTION).doc(ACTIVE_DOC_ID).set(
    {
      versionId: docRef.id,
      config: cleaned,
      updatedAt: Timestamp.now(),
      updatedBy: updatedBy || 'admin',
      note: note || null,
    },
    { merge: true }
  );

  // Update in-memory cache immediately in this process.
  setRulebookConfigCached(cleaned, { source: `admin:${updatedBy || 'admin'}` });

  return { id: docRef.id, ...payload, createdAt: payload.createdAt.toDate().toISOString() };
}

module.exports = {
  getActiveRulebook,
  createRulebookVersion,
};

