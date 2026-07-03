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

module.exports = { buildNoteDoc, aggregateNoteCounts, addNote, listNotes, getNotesCounts, NOTES_COLLECTION };
