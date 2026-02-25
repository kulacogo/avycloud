const { firestore } = require('./firestore');
const { FieldValue } = require('@google-cloud/firestore');

const SCOPES_COLLECTION = 'llmScopes';

// Simple in-memory cache to avoid repeated Firestore reads per request.
const cache = new Map(); // scopeId -> { value, expiresAt }
const CACHE_TTL_MS = parseInt(process.env.LLM_CONFIG_CACHE_TTL_MS || '30000', 10);

function now() {
  return Date.now();
}

function getCached(scopeId) {
  const hit = cache.get(scopeId);
  if (!hit) return null;
  if (hit.expiresAt < now()) {
    cache.delete(scopeId);
    return null;
  }
  return hit.value;
}

function setCached(scopeId, value) {
  cache.set(scopeId, { value, expiresAt: now() + CACHE_TTL_MS });
}

function listDefaultScopes() {
  return [
    {
      id: 'chat.product',
      name: 'Product Chat',
      purpose: 'Interactive assistant in AvyCloud product chat (datasheet edits, web lookup, image suggestions).',
      defaultModelEnvKey: 'GEMINI_CHAT_MODEL',
    },
    {
      id: 'identify.v2',
      name: 'Identify v2',
      purpose: 'SerpAPI-free identify/enrich pipeline (images + barcodes).',
      defaultModelEnvKey: 'GEMINI_IDENTIFY_MODEL',
    },
    {
      id: 'improve.product',
      name: 'Improve Product',
      purpose: 'Improve existing product datasheet and quality enhancements.',
      defaultModelEnvKey: 'GEMINI_IMPROVE_MODEL',
    },
    {
      id: 'quality.gate',
      name: 'Quality Gate',
      purpose: 'Validate product compliance against rules and marketplace constraints.',
      defaultModelEnvKey: 'GEMINI_QUALITY_MODEL',
    },
    {
      id: 'image.generation',
      name: 'Image Generation',
      purpose: 'Generate marketing images / renders.',
      defaultModelEnvKey: 'GEMINI_IMAGE_MODEL',
    },
  ];
}

async function ensureDefaultLlmScopes() {
  const defaults = listDefaultScopes();
  await Promise.all(
    defaults.map(async (scope) => {
      const ref = firestore.collection(SCOPES_COLLECTION).doc(scope.id);
      const snap = await ref.get();
      if (snap.exists) return;
      await ref.set(
        {
          scopeId: scope.id,
          name: scope.name,
          purpose: scope.purpose,
          defaultModelEnvKey: scope.defaultModelEnvKey,
          activeVersionId: null,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    })
  );
}

async function ensureDefaultLlmScopeVersions() {
  // Seed minimal-but-strong defaults ONLY when a scope has no active version yet.
  // This keeps behavior stable for new deployments while still allowing admin overrides.
  const defaultsByScope = {
    'identify.v2': {
      promptMode: 'append',
      rulesMode: 'append',
      note: 'Default v1 (bootstrapped) – Identify-first quality rules.',
      promptText: [
        'IDENTIFY-FIRST: Liefere maximal vollständige, belegbare Produktdaten. Identify ist die primäre Datenquelle; Improve/Chat sind nur Fallback.',
        'Wenn Daten fehlen (MPN/EAN/GPSR/K-Typ): Nutze WEB-EVIDENZ/Marktplatz-Suchergebnisse. Erfinde nichts; lass Felder leer, wenn nicht belegbar.',
      ].join('\n'),
      rulesText: [
        'Pflichtfelder (wenn belegbar): identifiers.mpn (Herstellernummer), GPSR Herstellerdaten (Name, Adresse, Ort, PLZ, Land, E-Mail, Telefon).',
        'Bei Fahrzeugteilen: wenn Kategorie Fahrzeugverwendungsliste erlaubt, K-Typ als Attribut "K-Typ" pflegen (nur aus Evidence).',
        'Keine Fake-Antworten: Wenn du keine Belege findest, schreibe eine Warnung statt zu behaupten, dass Daten existieren.',
      ].join('\n'),
    },
    'improve.product': {
      promptMode: 'append',
      rulesMode: 'append',
      note: 'Default v1 (bootstrapped) – Improve fallback rules.',
      promptText:
        'IMPROVE: Verbessere vorhandene Daten, aber erfinde keine Spezifikationen. Nutze Web/Marketplace Evidence für Plausibilitätschecks.',
      rulesText:
        'Wenn Pflicht-Aspekte fehlen, ergänze sie nur wenn belegbar. Falls nicht belegbar: Warnung setzen; keine Halluzinationen.',
    },
    'chat.product': {
      promptMode: 'append',
      rulesMode: 'append',
      note: 'Default v1 (bootstrapped) – Chat honesty + deep search.',
      promptText:
        'CHAT: Sei flexibel und handlungsorientiert. Wenn der Nutzer nach Daten fragt, führe selbstständig Web/Marketplace Searches aus und liefere Ergebnisse mit Quellen.',
      rulesText: [
        'Ehrlichkeit: Behaupte niemals, du hättest Daten gefunden, wenn keine Tool-Calls/Belege vorhanden sind.',
        'Wenn du suchst: nutze mehrere Quellen (mindestens Google + eBay + Amazon; optional Shopping/weitere).',
        'Jede neue Faktenbehauptung (EAN/MPN/GPSR etc.) muss aus Evidence stammen; sonst als "unbelegt" markieren oder leer lassen.',
        'eBay-Ready (DE): Titel ≤ 80 Zeichen, keine artikelfremden Keywords; gültige eBay Kategorie + kategorieabhängige Pflicht-Artikelmerkmale (required aspects) müssen befüllt und nicht leer sein.',
        'Preis: nur setzen, wenn amount ≥ 1 EUR UND Evidence-URLs vorhanden sind (z.B. eBay itemWebUrl). Ohne Evidence: Preis leer lassen und Warning setzen.',
        'Beschreibung: keine Kontaktinfos/URLs zum Wegleiten, kein aktiver Inhalt (Skripte/Formulare).',
      ].join('\n'),
    },
  };

  const defaults = listDefaultScopes();
  for (const scope of defaults) {
    const ref = firestore.collection(SCOPES_COLLECTION).doc(scope.id);
    const snap = await ref.get();
    if (!snap.exists) continue;
    const data = snap.data() || {};
    if (data.activeVersionId) continue;
    const def = defaultsByScope[scope.id];
    if (!def) continue;

    const versionRef = ref.collection('versions').doc();
    await versionRef.set({
      promptText: String(def.promptText || ''),
      rulesText: String(def.rulesText || ''),
      promptMode: def.promptMode === 'replace' ? 'replace' : 'append',
      rulesMode: def.rulesMode === 'replace' ? 'replace' : 'append',
      note: def.note ? String(def.note).slice(0, 500) : null,
      createdByUid: null,
      createdAt: FieldValue.serverTimestamp(),
    });
    await ref.set(
      {
        activeVersionId: versionRef.id,
        updatedAt: FieldValue.serverTimestamp(),
        activatedByUid: null,
      },
      { merge: true }
    );
    cache.delete(scope.id);
  }
}

async function listLlmScopes() {
  const snap = await firestore.collection(SCOPES_COLLECTION).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function getScope(scopeId) {
  const id = String(scopeId || '').trim();
  if (!id) return null;
  const snap = await firestore.collection(SCOPES_COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

async function listScopeVersions(scopeId, { limit = 20 } = {}) {
  const id = String(scopeId || '').trim();
  const capped = Math.min(Math.max(parseInt(String(limit || 0), 10) || 20, 1), 100);
  const snap = await firestore
    .collection(SCOPES_COLLECTION)
    .doc(id)
    .collection('versions')
    .orderBy('createdAt', 'desc')
    .limit(capped)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function createScopeVersion({ actorUid, scopeId, version }) {
  const id = String(scopeId || '').trim();
  if (!id) throw new Error('scopeId is required');
  const ref = firestore.collection(SCOPES_COLLECTION).doc(id).collection('versions').doc();
  const payload = {
    promptText: String(version?.promptText || ''),
    rulesText: String(version?.rulesText || ''),
    promptMode: version?.promptMode === 'replace' ? 'replace' : 'append',
    rulesMode: version?.rulesMode === 'replace' ? 'replace' : 'append',
    note: version?.note ? String(version.note).slice(0, 500) : null,
    createdByUid: actorUid || null,
    createdAt: FieldValue.serverTimestamp(),
  };
  await ref.set(payload);
  await firestore.collection(SCOPES_COLLECTION).doc(id).set(
    {
      activeVersionId: ref.id,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  cache.delete(id);
  return { versionId: ref.id };
}

async function activateScopeVersion({ actorUid, scopeId, versionId }) {
  const id = String(scopeId || '').trim();
  const vid = String(versionId || '').trim();
  if (!id || !vid) throw new Error('scopeId/versionId required');

  // Ensure version exists
  const snap = await firestore.collection(SCOPES_COLLECTION).doc(id).collection('versions').doc(vid).get();
  if (!snap.exists) {
    const err = new Error('Version not found');
    err.statusCode = 404;
    throw err;
  }

  await firestore.collection(SCOPES_COLLECTION).doc(id).set(
    {
      activeVersionId: vid,
      updatedAt: FieldValue.serverTimestamp(),
      activatedByUid: actorUid || null,
    },
    { merge: true }
  );
  cache.delete(id);
  return true;
}

async function getActiveLlmConfig(scopeId) {
  const id = String(scopeId || '').trim();
  if (!id) return null;

  const cached = getCached(id);
  if (cached) return cached;

  const scope = await getScope(id);
  if (!scope?.activeVersionId) {
    setCached(id, null);
    return null;
  }

  const snap = await firestore
    .collection(SCOPES_COLLECTION)
    .doc(id)
    .collection('versions')
    .doc(String(scope.activeVersionId))
    .get();
  if (!snap.exists) {
    setCached(id, null);
    return null;
  }
  const value = { scopeId: id, versionId: snap.id, ...snap.data() };
  setCached(id, value);
  return value;
}

module.exports = {
  ensureDefaultLlmScopes,
  ensureDefaultLlmScopeVersions,
  listLlmScopes,
  getScope,
  listScopeVersions,
  createScopeVersion,
  activateScopeVersion,
  getActiveLlmConfig,
};

