const { Firestore, FieldValue, Timestamp } = require('@google-cloud/firestore');

const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
});

const JOBS_COLLECTION = 'identificationJobs';

function collection() {
  return firestore.collection(JOBS_COLLECTION);
}

function isSpecialFirestoreValue(value) {
  if (!value) return false;
  if (value instanceof Timestamp || value instanceof FieldValue) {
    return true;
  }
  const ctorName = value?.constructor?.name;
  return ctorName === 'FieldValue';
}

function sanitizeValue(value) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (isSpecialFirestoreValue(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    const cleaned = value
      .map((item) => sanitizeValue(item))
      .filter((item) => item !== undefined);
    return cleaned;
  }

  if (typeof value === 'object') {
    const cleaned = {};
    for (const [key, nested] of Object.entries(value)) {
      const sanitized = sanitizeValue(nested);
      if (sanitized !== undefined) {
        cleaned[key] = sanitized;
      }
    }
    return cleaned;
  }

  return value;
}

function serializeJob(snapshot) {
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  return {
    id: snapshot.id,
    ...data,
    createdAt: data.createdAt?.toDate?.().toISOString?.() || null,
    updatedAt: data.updatedAt?.toDate?.().toISOString?.() || null,
    startedAt: data.startedAt?.toDate?.().toISOString?.() || null,
    finishedAt: data.finishedAt?.toDate?.().toISOString?.() || null,
  };
}

async function createJob(payload, jobId = null) {
  const base = {
    status: 'pending',
    attempts: 0,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...payload,
  };
  const docRef = jobId ? collection().doc(jobId) : collection().doc();
  const sanitized = sanitizeValue(base);
  await docRef.set(sanitized);
  return { id: docRef.id, ...sanitized };
}

async function getJob(jobId) {
  const snapshot = await collection().doc(jobId).get();
  return serializeJob(snapshot);
}

async function updateJob(jobId, data) {
  const payload = sanitizeValue({
    ...data,
    updatedAt: Timestamp.now(),
  });
  await collection().doc(jobId).update(payload);
}

async function claimJob(jobId) {
  const docRef = collection().doc(jobId);
  return firestore.runTransaction(async (tx) => {
    const snapshot = await tx.get(docRef);
    if (!snapshot.exists) {
      throw new Error('Job not found');
    }
    const job = snapshot.data();
    if (job.status !== 'pending') {
      throw new Error('Job not pending');
    }

    const attempts = (job.attempts || 0) + 1;
    tx.update(docRef, {
      status: 'processing',
      attempts,
      startedAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });

    return { id: snapshot.id, ...job, status: 'processing', attempts };
  });
}

async function listJobs(options = {}) {
  const {
    statuses = null,
    limit = 50,
    cursor = null,
    order = 'desc',
  } = options || {};

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  let query = collection().orderBy('createdAt', order === 'asc' ? 'asc' : 'desc').limit(safeLimit);

  if (Array.isArray(statuses) && statuses.length > 0) {
    query = query.where('status', 'in', statuses.slice(0, 10));
  }

  if (cursor) {
    const cursorSnapshot = await collection().doc(cursor).get();
    if (cursorSnapshot.exists) {
      query = query.startAfter(cursorSnapshot);
    }
  }

  const snapshot = await query.get();
  const jobs = snapshot.docs.map(serializeJob).filter(Boolean);
  const nextCursor =
    snapshot.docs.length === safeLimit
      ? snapshot.docs[snapshot.docs.length - 1].id
      : null;

  return { jobs, nextCursor };
}

async function listJobsByStatus(statuses = ['pending']) {
  if (!Array.isArray(statuses) || statuses.length === 0) {
    return [];
  }
  const query = collection().where('status', 'in', statuses.slice(0, 10));
  const snapshot = await query.get();
  return snapshot.docs.map(serializeJob).filter(Boolean);
}

const DEAD_LETTER_COLLECTION = 'deadLetterJobs';

function deadLetterCollection() {
  return firestore.collection(DEAD_LETTER_COLLECTION);
}

async function moveToDeadLetter(jobId) {
  const docRef = collection().doc(jobId);
  const snapshot = await docRef.get();
  if (!snapshot.exists) return null;

  const data = snapshot.data();
  const dlRef = deadLetterCollection().doc(jobId);
  await dlRef.set({
    ...data,
    originalCollection: JOBS_COLLECTION,
    movedAt: Timestamp.now(),
  });
  await docRef.delete();
  return jobId;
}

async function listDeadLetterJobs(options = {}) {
  const { limit = 50, cursor = null } = options || {};
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  let query = deadLetterCollection()
    .orderBy('movedAt', 'desc')
    .limit(safeLimit);

  if (cursor) {
    const cursorSnapshot = await deadLetterCollection().doc(cursor).get();
    if (cursorSnapshot.exists) {
      query = query.startAfter(cursorSnapshot);
    }
  }

  const snapshot = await query.get();
  const jobs = snapshot.docs.map(serializeJob).filter(Boolean);
  const nextCursor =
    snapshot.docs.length === safeLimit
      ? snapshot.docs[snapshot.docs.length - 1].id
      : null;
  return { jobs, nextCursor };
}

module.exports = {
  createJob,
  getJob,
  updateJob,
  claimJob,
  listJobsByStatus,
  listJobs,
  moveToDeadLetter,
  listDeadLetterJobs,
  Timestamp,
  FieldValue,
};

