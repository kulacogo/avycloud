/**
 * Los-Verwaltung (Einkaufs-Zugehörigkeit von Ware).
 *
 * Ein "Los" ist die Herkunft eines Wareneingangs:
 *   L-MMYYNN  — Auktions-Los (Nummer 01-200 pro Monat; 1-99 zweistellig,
 *               100-200 dreistellig). Beispiel: L-072612.
 *   NL-MMYY   — Non-Los (nicht über Auktion erworben), eins pro Monat.
 *               Beispiel: NL-0726.
 *
 * Lose sind reine Zuordnungs-Metadaten (ops.sourceLot am Produkt) — KEIN
 * Bestand, KEINE Berührung mit bookStockIn/bookStockOut oder den
 * Oversell-Invarianten. Collection: warehouse_lots (Doc-ID = Los-Code,
 * tenantId-Feld gemäß CLAUDE.md Regel 8).
 *
 * Ersetzt die Paletten-Funktion (Zone 'P', PEG-Bins) — Owner-Entscheid
 * 2026-07-31, Spec: docs/superpowers/specs/2026-07-31-los-struktur-design.md
 */
const { Firestore, Timestamp } = require('@google-cloud/firestore');

const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
});

const LOTS_COLLECTION = 'warehouse_lots';
const lotsCollection = firestore.collection(LOTS_COLLECTION);

// Produkt-Collection wie in lib/warehouse.js aufgelöst (USE_PRODUCTS_V2).
const _lotUseV2Raw = (process.env.USE_PRODUCTS_V2 || '').toString().trim().toLowerCase();
const _lotUseV2 = _lotUseV2Raw === '1' || _lotUseV2Raw === 'true' || _lotUseV2Raw === 'yes' || _lotUseV2Raw === 'on';
const PRODUCTS_COLL_NAME = _lotUseV2 ? 'products_v2' : 'products';
const productsCollection = firestore.collection(PRODUCTS_COLL_NAME);

const LOT_TYPES = ['L', 'NL'];
const MIN_LOT_NUMBER = 1;
const MAX_LOT_NUMBER = 200;

// Nummernteil: 01-09 | 10-99 | 100-199 | 200 — KEINE führende Null bei
// dreistelligen Werten. Damit ist jeder Code eindeutig und kollidiert mit
// keinem BIN-Code-Format (BIN: {ZONE}{ETAGE}{GG}{RR}{E}, kein Bindestrich).
const L_CODE_REGEX = /^L-(0[1-9]|1[0-2])(\d{2})(0[1-9]|[1-9]\d|1\d\d|200)$/;
const NL_CODE_REGEX = /^NL-(0[1-9]|1[0-2])(\d{2})$/;

function normalizeYear(year) {
  const y = Number(year);
  if (!Number.isInteger(y)) throw new Error('Ungültiges Jahr für Los-Code.');
  if (y >= 2000 && y <= 2099) return y;
  if (y >= 0 && y <= 99) return 2000 + y;
  throw new Error('Ungültiges Jahr für Los-Code (erlaubt: 2000-2099 oder 00-99).');
}

/**
 * Baut einen Los-Code. { type: 'L'|'NL', month: 1-12, year: 2026|26, number?: 1-200 }
 */
function buildLotCode({ type, month, year, number } = {}) {
  if (!LOT_TYPES.includes(type)) {
    throw new Error(`Ungültiger Los-Typ. Erlaubt sind ${LOT_TYPES.join(', ')}.`);
  }
  const m = Number(month);
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    throw new Error('Ungültiger Monat für Los-Code (1-12).');
  }
  const fullYear = normalizeYear(year);
  const mm = String(m).padStart(2, '0');
  const yy = String(fullYear % 100).padStart(2, '0');
  if (type === 'NL') {
    if (number !== undefined && number !== null) {
      throw new Error('NL-Lose haben keine Nummer.');
    }
    return `NL-${mm}${yy}`;
  }
  const n = Number(number);
  if (!Number.isInteger(n) || n < MIN_LOT_NUMBER || n > MAX_LOT_NUMBER) {
    throw new Error(`Los-Nummer muss zwischen ${MIN_LOT_NUMBER} und ${MAX_LOT_NUMBER} liegen.`);
  }
  const numberPart = n < 100 ? String(n).padStart(2, '0') : String(n);
  return `L-${mm}${yy}${numberPart}`;
}

/**
 * Parst einen Los-Code (case-/whitespace-tolerant für Scanner-Eingaben).
 * Rückgabe { code, type, month, year, number } oder null.
 */
function parseLotCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;
  const lMatch = normalized.match(L_CODE_REGEX);
  if (lMatch) {
    return {
      code: normalized,
      type: 'L',
      month: Number(lMatch[1]),
      year: 2000 + Number(lMatch[2]),
      number: Number(lMatch[3]),
    };
  }
  const nlMatch = normalized.match(NL_CODE_REGEX);
  if (nlMatch) {
    return {
      code: normalized,
      type: 'NL',
      month: Number(nlMatch[1]),
      year: 2000 + Number(nlMatch[2]),
      number: null,
    };
  }
  return null;
}

function isValidLotCode(code) {
  return parseLotCode(code) !== null;
}

/**
 * '12' oder '1-38' → [12] bzw. [1..38]. Bereich 1-200.
 */
function parseLotNumberSelection(input) {
  const trimmed = String(input == null ? '' : input).trim();
  if (!trimmed) {
    throw new Error(`Bitte eine Los-Nummer (${MIN_LOT_NUMBER}-${MAX_LOT_NUMBER}) oder einen Bereich wie "1-38" angeben.`);
  }
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    if (value < MIN_LOT_NUMBER || value > MAX_LOT_NUMBER) {
      throw new Error(`Los-Nummer ${value} muss zwischen ${MIN_LOT_NUMBER} und ${MAX_LOT_NUMBER} liegen.`);
    }
    return [value];
  }
  if (/^\d+\s*-\s*\d+$/.test(trimmed)) {
    const [start, end] = trimmed.split('-').map((x) => Number(x.trim()));
    if (start > end) throw new Error('Startwert darf nicht größer als Endwert sein.');
    if (start < MIN_LOT_NUMBER || end > MAX_LOT_NUMBER) {
      throw new Error(`Bereich muss zwischen ${MIN_LOT_NUMBER} und ${MAX_LOT_NUMBER} liegen.`);
    }
    const result = [];
    for (let i = start; i <= end; i += 1) result.push(i);
    return result;
  }
  throw new Error('Bitte eine einzelne Nummer oder einen Bereich im Format "Start-Ende" angeben.');
}

/**
 * Produktanzahl je Los via Firestore-count()-Aggregation.
 * Bewusst NUR über ops.sourceLot (Single-Field-Auto-Index): products_v2-
 * Altbestände tragen nicht garantiert ein tenantId-Feld — ein zusätzlicher
 * tenantId-Filter würde solche Docs still unterschlagen. Single-Tenant-
 * Realität (alle Prod-Daten tenantId='default', siehe Projekt-Memory).
 */
async function countProductsForLot(code) {
  try {
    const snap = await productsCollection
      .where('ops.sourceLot', '==', code)
      .count()
      .get();
    return snap.data().count || 0;
  } catch (err) {
    console.warn(`[warehouse-lots] count für ${code} fehlgeschlagen: ${err.message}`);
    return 0;
  }
}

function lotDocToJson(doc) {
  const data = doc.data() || {};
  return {
    code: doc.id,
    tenantId: data.tenantId || 'default',
    type: data.type || (doc.id.startsWith('NL-') ? 'NL' : 'L'),
    month: data.month ?? null,
    year: data.year ?? null,
    number: data.number ?? null,
    ekBrutto: data.ekBrutto ?? null,
    note: data.note ?? null,
    createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : data.createdAt || null,
    createdBy: data.createdBy || null,
  };
}

/**
 * Legt Lose an. NL: genau ein Code (MM/YY). L: numbers = '12' oder '1-38'.
 * Bereits existierende Codes werden übersprungen (idempotent).
 */
async function createLots({ type, month, year, numbers, tenantId = 'default', createdBy = null } = {}) {
  if (!LOT_TYPES.includes(type)) {
    throw new Error(`Ungültiger Los-Typ. Erlaubt sind ${LOT_TYPES.join(', ')}.`);
  }
  const codes = [];
  const parsedMonth = Number(month);
  const fullYear = normalizeYear(year);
  if (type === 'NL') {
    codes.push(buildLotCode({ type: 'NL', month: parsedMonth, year: fullYear }));
  } else {
    const nums = parseLotNumberSelection(numbers);
    nums.forEach((n) => codes.push(buildLotCode({ type: 'L', month: parsedMonth, year: fullYear, number: n })));
  }

  const refs = codes.map((code) => lotsCollection.doc(code));
  const snaps = await firestore.getAll(...refs);
  const created = [];
  const skipped = [];
  const batch = firestore.batch();
  snaps.forEach((snap, i) => {
    const code = codes[i];
    if (snap.exists) {
      skipped.push(code);
      return;
    }
    const parsed = parseLotCode(code);
    batch.set(refs[i], {
      code,
      tenantId,
      type,
      month: parsed.month,
      year: parsed.year,
      number: parsed.number,
      ekBrutto: null,
      note: null,
      createdAt: Timestamp.now(),
      createdBy: createdBy || null,
    });
    created.push(code);
  });
  if (created.length) await batch.commit();
  return { created, skipped };
}

/**
 * Alle Lose eines Tenants, neueste zuerst (Jahr/Monat absteigend, L vor NL,
 * Nummern aufsteigend), inkl. productCount.
 */
async function listLots({ tenantId = 'default' } = {}) {
  const snapshot = await lotsCollection.where('tenantId', '==', tenantId).get();
  const lots = snapshot.docs.map(lotDocToJson);
  lots.sort((a, b) => {
    if ((b.year || 0) !== (a.year || 0)) return (b.year || 0) - (a.year || 0);
    if ((b.month || 0) !== (a.month || 0)) return (b.month || 0) - (a.month || 0);
    if (a.type !== b.type) return a.type === 'L' ? -1 : 1;
    return (a.number || 0) - (b.number || 0);
  });
  const counts = await Promise.all(lots.map((lot) => countProductsForLot(lot.code)));
  return lots.map((lot, i) => ({ ...lot, productCount: counts[i] }));
}

async function getLotByCode(code) {
  const parsed = parseLotCode(code);
  if (!parsed) return null;
  const snap = await lotsCollection.doc(parsed.code).get();
  if (!snap.exists) return null;
  const productCount = await countProductsForLot(parsed.code);
  return { ...lotDocToJson(snap), productCount };
}

async function lotExists(code) {
  const parsed = parseLotCode(code);
  if (!parsed) return false;
  const snap = await lotsCollection.doc(parsed.code).get();
  return snap.exists;
}

/**
 * Pflegt EK (brutto, EUR) und Notiz am Los. Nur übergebene Felder werden geschrieben.
 */
async function updateLot(code, { ekBrutto, note } = {}) {
  const parsed = parseLotCode(code);
  if (!parsed) throw new Error(`Ungültiger Los-Code: ${code}`);
  const ref = lotsCollection.doc(parsed.code);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Los ${parsed.code} existiert nicht.`);

  const update = {};
  if (ekBrutto !== undefined) {
    if (ekBrutto === null || ekBrutto === '') {
      update.ekBrutto = null;
    } else {
      const value = Number(ekBrutto);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error('EK (brutto) muss eine Zahl ≥ 0 sein.');
      }
      update.ekBrutto = value;
    }
  }
  if (note !== undefined) {
    update.note = note === null ? null : String(note).slice(0, 500);
  }
  if (!Object.keys(update).length) {
    throw new Error('Keine Änderungen übergeben (ekBrutto oder note).');
  }
  await ref.update(update);
  const fresh = await ref.get();
  return lotDocToJson(fresh);
}

/**
 * Löscht ein Los — fail-closed: nur wenn KEIN Produkt zugeordnet ist.
 */
async function deleteLot(code) {
  const parsed = parseLotCode(code);
  if (!parsed) throw new Error(`Ungültiger Los-Code: ${code}`);
  const ref = lotsCollection.doc(parsed.code);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Los ${parsed.code} existiert nicht.`);
  const productCount = await countProductsForLot(parsed.code);
  if (productCount > 0) {
    throw new Error(`Los ${parsed.code} hat ${productCount} zugeordnete Produkte und kann nicht gelöscht werden.`);
  }
  await ref.delete();
  return { deleted: parsed.code };
}

module.exports = {
  LOTS_COLLECTION,
  LOT_TYPES,
  MIN_LOT_NUMBER,
  MAX_LOT_NUMBER,
  buildLotCode,
  parseLotCode,
  isValidLotCode,
  parseLotNumberSelection,
  createLots,
  listLots,
  getLotByCode,
  lotExists,
  updateLot,
  deleteLot,
};
