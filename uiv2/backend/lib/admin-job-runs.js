const { Firestore, Timestamp } = require('@google-cloud/firestore');

const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
});

const COLLECTION = 'adminJobRuns';

function collection() {
  return firestore.collection(COLLECTION);
}

function serialize(snapshot) {
  if (!snapshot?.exists) return null;
  const data = snapshot.data() || {};
  return {
    id: snapshot.id,
    ...data,
    createdAt: data.createdAt?.toDate?.().toISOString?.() || null,
    updatedAt: data.updatedAt?.toDate?.().toISOString?.() || null,
  };
}

async function createJobRun({ type, operationName = null, params = null, requestedBy = null, note = null } = {}) {
  const doc = {
    type: String(type || '').trim() || 'unknown',
    operationName: operationName ? String(operationName).trim() : null,
    params: params && typeof params === 'object' ? params : null,
    requestedBy: requestedBy ? String(requestedBy).trim() : null,
    note: note ? String(note) : null,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  };
  const ref = collection().doc();
  await ref.set(doc);
  return { id: ref.id, ...doc };
}

async function listJobRunsByType(type, { limit = 10 } = {}) {
  const t = String(type || '').trim();
  if (!t) return [];
  const snap = await collection()
    .where('type', '==', t)
    .orderBy('createdAt', 'desc')
    .limit(Math.max(1, Math.min(50, Number(limit) || 10)))
    .get();
  return snap.docs.map(serialize).filter(Boolean);
}

module.exports = {
  createJobRun,
  listJobRunsByType,
};

