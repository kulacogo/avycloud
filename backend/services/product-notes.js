'use strict';

/**
 * product-notes.js — interne Mitarbeiter-Notizen an Produkten.
 *
 * Eigene Collection `product_notes`, komplett getrennt von products_v2. Diese
 * Notizen sind AvyCloud-intern, nur für Mitarbeiter sichtbar und dürfen NIEMALS
 * Teil eines Marktplatz-Angebots werden (deshalb NICHT auf dem Produkt-Doc).
 */

const NOTES_COLLECTION = 'product_notes';

/** Pure: baut das Notiz-Dokument. Wirft bei leerem Text / fehlendem Produkt. */
function buildNoteDoc({ productId, tenantId = 'default', user = {}, text, nowIso }) {
  const pid = String(productId || '').trim();
  if (!pid) throw new Error('productId ist erforderlich');
  const clean = String(text || '').trim();
  if (!clean) throw new Error('Notiztext darf nicht leer sein');
  return {
    productId: pid,
    tenantId,
    userId: user.uid || null,
    userEmail: user.email || null,
    userName: user.name || user.displayName || null,
    text: clean,
    createdAt: nowIso,
  };
}

/** Pure: zählt Notizen pro Produkt. */
function aggregateNoteCounts(notes) {
  const counts = {};
  for (const n of notes || []) {
    const pid = n && n.productId ? String(n.productId) : '';
    if (!pid) continue;
    counts[pid] = (counts[pid] || 0) + 1;
  }
  return counts;
}

async function addNote({ productId, tenantId = 'default', user, text }) {
  const { firestore } = require('../lib/firestore');
  const doc = buildNoteDoc({ productId, tenantId, user, text, nowIso: new Date().toISOString() });
  const ref = await firestore.collection(NOTES_COLLECTION).add(doc);
  return { id: ref.id, ...doc };
}

async function listNotes({ productId, tenantId = 'default', limit = 200 }) {
  const { firestore } = require('../lib/firestore');
  // Single-field equality + orderBy on the same query needs a composite index;
  // to avoid that we filter by productId (equality) and sort in-memory (a single
  // product never has many notes).
  const snap = await firestore
    .collection(NOTES_COLLECTION)
    .where('productId', '==', String(productId))
    .limit(limit)
    .get();
  const notes = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((n) => !n.tenantId || n.tenantId === tenantId);
  // chronologisch, neueste zuerst
  notes.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return notes;
}

async function getNotesCounts({ tenantId = 'default', limit = 20000 }) {
  const { firestore } = require('../lib/firestore');
  const snap = await firestore.collection(NOTES_COLLECTION).limit(limit).get();
  const notes = snap.docs.map((d) => d.data()).filter((n) => !n.tenantId || n.tenantId === tenantId);
  return aggregateNoteCounts(notes);
}

// --- Notizen-Uebersicht + Gelesen-Stand (Produkttabellen-Filter) ---------------
//
// Gelesen-Stand: EIN Doc je (tenant, user) in `product_note_reads` mit einer
// Map { productId: seenAtIso }. Ein einziger Read fuer die ganze Tabelle, ein
// merge-Write beim Oeffnen der Notizen. "Ungelesen" entscheidet das Frontend:
// lastNoteAt > seenAt (utils/productFilters.ts hasUnreadNotes — eine Quelle).

const NOTE_READS_COLLECTION = 'product_note_reads';

/** Pure: Anzahl + juengster Notiz-Zeitstempel je Produkt. */
function aggregateNotesOverview(notes) {
  const overview = {};
  for (const n of notes || []) {
    const pid = n && n.productId ? String(n.productId) : '';
    if (!pid) continue;
    const entry = overview[pid] || { count: 0, lastNoteAt: null, seenAt: null };
    entry.count += 1;
    const createdAt = typeof n.createdAt === 'string' && n.createdAt ? n.createdAt : null;
    if (createdAt && (!entry.lastNoteAt || createdAt > entry.lastNoteAt)) entry.lastNoteAt = createdAt;
    overview[pid] = entry;
  }
  return overview;
}

/** Pure: eigenen Gelesen-Stand (seen-Map) an die Uebersicht haengen. */
function mergeSeenIntoOverview(overview, seen) {
  const map = seen && typeof seen === 'object' ? seen : {};
  for (const pid of Object.keys(overview || {})) {
    const seenAt = typeof map[pid] === 'string' && map[pid] ? map[pid] : null;
    overview[pid].seenAt = seenAt;
  }
  return overview;
}

function seenDocId({ tenantId = 'default', userId }) {
  return `${tenantId}__${userId}`;
}

/** Pure: merge-faehiger Patch fuer das Gelesen-Doc. Wirft bei fehlender Identitaet. */
function buildSeenUpdate({ tenantId = 'default', userId, productId, nowIso }) {
  const uid = String(userId || '').trim();
  if (!uid) throw new Error('userId ist erforderlich');
  const pid = String(productId || '').trim();
  if (!pid) throw new Error('productId ist erforderlich');
  return { tenantId, userId: uid, seen: { [pid]: nowIso } };
}

async function getNotesOverview({ tenantId = 'default', userId = null, limit = 20000 }) {
  const { firestore } = require('../lib/firestore');
  const snap = await firestore.collection(NOTES_COLLECTION).limit(limit).get();
  const notes = snap.docs.map((d) => d.data()).filter((n) => !n.tenantId || n.tenantId === tenantId);
  const overview = aggregateNotesOverview(notes);
  if (!userId) return overview;
  const seenSnap = await firestore
    .collection(NOTE_READS_COLLECTION)
    .doc(seenDocId({ tenantId, userId }))
    .get()
    .catch(() => null);
  const seen = seenSnap && seenSnap.exists ? (seenSnap.data() || {}).seen : null;
  return mergeSeenIntoOverview(overview, seen);
}

async function markNotesSeen({ tenantId = 'default', userId, productId, nowIso = new Date().toISOString() }) {
  const { firestore } = require('../lib/firestore');
  const update = buildSeenUpdate({ tenantId, userId, productId, nowIso });
  await firestore
    .collection(NOTE_READS_COLLECTION)
    .doc(seenDocId({ tenantId, userId }))
    .set(update, { merge: true });
  return { productId: String(productId).trim(), seenAt: nowIso };
}

module.exports = {
  buildNoteDoc,
  aggregateNoteCounts,
  aggregateNotesOverview,
  mergeSeenIntoOverview,
  seenDocId,
  buildSeenUpdate,
  addNote,
  listNotes,
  getNotesCounts,
  getNotesOverview,
  markNotesSeen,
  NOTES_COLLECTION,
  NOTE_READS_COLLECTION,
};
