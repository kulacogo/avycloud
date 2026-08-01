const fs = require('fs');
const path = require('path');
const { firestore } = require('./firestore');
const { FieldValue } = require('@google-cloud/firestore');
const {
  DEFAULT_MODEL,
  DEFAULT_CHAT_TEMPERATURE,
  defaultThinkingConfig,
  buildGenerationConfig,
} = require('./gemini-config');
const { resolveModel: resolveModelPolicy } = require('./model-select');

const SCOPES_COLLECTION = 'llmScopes';
const SNAPSHOT_FILE = path.join(__dirname, 'llm-scopes-snapshot.json');

// Lazy snapshot cache to avoid repeated disk reads after first fallback.
let _snapshotCache = null;

function loadSnapshotFromDisk() {
  if (_snapshotCache !== null) return _snapshotCache;
  try {
    if (!fs.existsSync(SNAPSHOT_FILE)) {
      _snapshotCache = { scopes: [], snapshotGeneratedAt: null };
      return _snapshotCache;
    }
    const raw = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    _snapshotCache = {
      snapshotGeneratedAt: parsed?.snapshotGeneratedAt || null,
      scopes: Array.isArray(parsed?.scopes) ? parsed.scopes : [],
    };
    return _snapshotCache;
  } catch (err) {
    _snapshotCache = { scopes: [], snapshotGeneratedAt: null, error: err.message };
    return _snapshotCache;
  }
}

// Test-only helper to clear the snapshot cache between tests.
function __resetSnapshotCacheForTests() {
  _snapshotCache = null;
}

// Test-only helper to clear the in-memory active-config cache between tests.
function __resetActiveConfigCacheForTests() {
  cache.clear();
}

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
        'Best-Match Fokus: Relevanz, Vollständigkeit und Qualität im Datenblatt priorisieren (Titel, Item Specifics, Bilder, Beschreibung).',
        'Wenn Daten fehlen (MPN/EAN/GPSR/K-Typ): Nutze WEB-EVIDENZ/Marktplatz-Suchergebnisse. Erfinde nichts; lass Felder leer, wenn nicht belegbar.',
      ].join('\n'),
      rulesText: [
        'Pflichtfelder (wenn belegbar): identifiers.mpn (Herstellernummer), GPSR Herstellerdaten (Name, Adresse, Ort, PLZ, Land, E-Mail, Telefon).',
        'Titel-Logik: erste 3–5 Wörter CTR-kritisch (Marke + Produkttyp + Kernmerkmal), 70–80 Zeichen bevorzugt, max. 80.',
        'Keyword-Governance: 2-3 Kernbegriffe + max. 1-2 Synonyme; kein Keyword-Stuffing und keine artikelfremden Keywords.',
        'Beschreibung: HTML-strukturiert (<p>, <ul>, <li>, <strong>) und bei ausreichender Beleglage substanziell (~180–240 Wörter).',
        'Bei Fahrzeugteilen: wenn Kategorie Fahrzeugverwendungsliste erlaubt, K-Typ als Attribut "K-Typ" pflegen (nur aus Evidence).',
        'Keine Fake-Antworten: Wenn du keine Belege findest, schreibe eine Warnung statt zu behaupten, dass Daten existieren.',
      ].join('\n'),
    },
    'improve.product': {
      promptMode: 'append',
      rulesMode: 'append',
      note: 'Default v1 (bootstrapped) – Improve fallback rules.',
      promptText:
        'IMPROVE: Verbessere vorhandene Daten, aber erfinde keine Spezifikationen. Nutze Web/Marketplace Evidence für Plausibilitätschecks und Best-Match-Relevanz.',
      rulesText: [
        'Wenn Pflicht-Aspekte fehlen, ergänze sie nur wenn belegbar. Falls nicht belegbar: Warnung setzen; keine Halluzinationen.',
        'Titel-Logik: erste 3–5 Wörter CTR-kritisch (Marke + Produkttyp + Kernmerkmal), 70–80 Zeichen bevorzugt, max. 80.',
        'Keyword-Governance: 2-3 Kernbegriffe + max. 1-2 Synonyme; kein Keyword-Stuffing und keine artikelfremden Keywords.',
        'Beschreibung: HTML-strukturiert (<p>, <ul>, <li>, <strong>) und bei ausreichender Beleglage substanziell (~180–240 Wörter).',
      ].join('\n'),
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
        'Best-Match Fokus: Relevanz + Vollständigkeit + Qualität. Priorisiere fehlende Pflichtmerkmale und klare Suchintention.',
        'Titel-Logik: erste 3–5 Wörter CTR-kritisch (Marke + Produkttyp + Kernmerkmal), 70–80 Zeichen bevorzugt, max. 80.',
        'Keyword-Governance: 2-3 Kernbegriffe + max. 1-2 Synonyme; kein Keyword-Stuffing und keine artikelfremden Keywords.',
        'Beschreibung: HTML-strukturiert (<p>, <ul>, <li>, <strong>) und bei ausreichender Beleglage substanziell (~180–240 Wörter).',
        'eBay-Ready (DE): Titel ≤ 80 Zeichen, keine artikelfremden Keywords; gültige eBay Kategorie + kategorieabhängige Pflicht-Artikelmerkmale (required aspects) müssen befüllt und nicht leer sein.',
        'Preis: nur setzen, wenn amount ≥ 1 EUR UND Evidence-URLs vorhanden sind (z.B. eBay itemWebUrl). Ohne Evidence: Preis leer lassen und Warning setzen.',
        'Beschreibung: keine Kontaktinfos/URLs zum Wegleiten, kein aktiver Inhalt (Skripte/Formulare).',
      ].join('\n'),
    },
    'quality.gate': {
      promptMode: 'append',
      rulesMode: 'append',
      note: 'Default v1 (bootstrapped) – Quality gate Best-Match compliance checks.',
      promptText:
        'QUALITY-GATE: Prüfe Datenblatt auf eBay-Relevanz, Vollständigkeit und Qualitätsmängel mit evidenzbasierter Begründung.',
      rulesText: [
        'Melde Titelprobleme (fehlende Kernbegriffe, Keyword-Stuffing, artikelfremde Keywords, >80 Zeichen).',
        'Melde fehlende/leer gelassene Pflicht-Item-Specifics und kritische Bildmängel (Wasserzeichen/Overlays/Hauptbild unklar).',
        'Unsicheres nur als WARN mit niedriger confidence; keine Halluzinationen.',
      ].join('\n'),
    },
    'image.generation': {
      promptMode: 'append',
      rulesMode: 'append',
      note: 'Default v1 (bootstrapped) – eBay-ready image generation constraints.',
      promptText:
        'IMAGE-GENERATION: Erzeuge realistische, eBay-taugliche Produktbilder auf Basis realer Referenzen, ohne Fantasieelemente.',
      rulesText: [
        'Hauptbild-Logik: Produkt vollständig sichtbar, neutraler Hintergrund, keine Overlays/Wasserzeichen/Badges.',
        'Keine Halluzinationen: keine neuen Teile, keine Perspektiv-Erfindungen, keine Lifestyle-Szenen, wenn nicht explizit gefordert.',
        'Bevorzuge mehrere klare Perspektiven und konsistente Produktidentität.',
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

/**
 * Phase F.1a — Schema-Extension (ADDITIVE, opt-in).
 *
 * Existing scope-versions remain functional. New optional fields per version:
 *   - userTemplate?: string         template-string for user-args (e.g. '{{productName}}')
 *   - outputSchemaHint?: string     JSON-schema hint for F.3 zod-migration
 *   - modelOverride?: string        per-scope model override
 *   - generationConfig?: object     per-scope generationConfig override
 *   - tenantOverrides?: object      per-tenant overrides: { [tenantId]: { version?, modelOverride?, generationConfig? } }
 *
 * Merge order (last wins): gemini-config defaults < scope.generationConfig
 *                         < tenantOverrides[tenantId].generationConfig
 *                         < callerOverrides.
 */

function _baseGenerationConfig() {
  // Mirrors the gemini-config standard agentic defaults.
  return buildGenerationConfig({
    temperature: DEFAULT_CHAT_TEMPERATURE,
    maxOutputTokens: 8192,
    thinkingConfig: defaultThinkingConfig(),
  });
}

function _mergeGenerationConfig(...layers) {
  const merged = {};
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    Object.assign(merged, layer);
  }
  return merged;
}

/**
 * Resolves the effective config for a scope considering optional tenant
 * override and per-call caller overrides.
 *
 * @param {string} scopeName       e.g. 'chat.product', 'identify.v2'
 * @param {string|null} tenantId   tenantId for per-tenant scope-version override
 * @param {object} callerOverrides ad-hoc generationConfig overrides. Accepts
 *                                 BOTH shapes (HIGH-10 cross-check fix):
 *                                 - flat:   { temperature: 0.5, model: 'x' }
 *                                 - nested: { generationConfig: { temperature: 0.5 }, model: 'x' }
 *                                 Top-level keys take precedence over nested
 *                                 ones if both are provided. `model` always
 *                                 stays at the top level.
 * @returns {Promise<object>} { system_prompt, rules_text, generationConfig, model, userTemplate?, outputSchemaHint? }
 */
async function resolveScopeConfig(scopeName, tenantId, callerOverrides = {}) {
  const id = String(scopeName || '').trim();
  if (!id) throw new Error('resolveScopeConfig: scopeName is required');

  // Unwrap nested `{ generationConfig: {...} }` shape so callers can pass
  // either flat or nested without silent no-ops. Top-level keys win over
  // nested values when both are present.
  if (
    callerOverrides &&
    typeof callerOverrides === 'object' &&
    callerOverrides.generationConfig &&
    typeof callerOverrides.generationConfig === 'object'
  ) {
    const nested = callerOverrides.generationConfig;
    const { generationConfig: _drop, ...topLevel } = callerOverrides;
    callerOverrides = { ...nested, ...topLevel };
  }

  // Load the scope-level metadata to discover active + tenantOverrides.
  const scope = await getScope(id);
  if (!scope) {
    const err = new Error(`resolveScopeConfig: unknown scope '${id}'`);
    err.statusCode = 404;
    throw err;
  }

  const tenantOverride =
    tenantId && scope.tenantOverrides && typeof scope.tenantOverrides === 'object'
      ? scope.tenantOverrides[tenantId] || null
      : null;

  // Resolve which version to load — tenantOverride.version wins if set.
  const effectiveVersionId =
    (tenantOverride && tenantOverride.version) || scope.activeVersionId || null;

  if (!effectiveVersionId) {
    const err = new Error(`resolveScopeConfig: scope '${id}' has no active version`);
    err.statusCode = 404;
    throw err;
  }

  const versionSnap = await firestore
    .collection(SCOPES_COLLECTION)
    .doc(id)
    .collection('versions')
    .doc(String(effectiveVersionId))
    .get();
  if (!versionSnap.exists) {
    const err = new Error(`resolveScopeConfig: version '${effectiveVersionId}' not found for scope '${id}'`);
    err.statusCode = 404;
    throw err;
  }
  const versionData = versionSnap.data() || {};

  // Merge generation-config layers — last writer wins per key (ADDITIVE,
  // not replace). tenantOverride.generationConfig is NOT a full-replacement
  // of the version-level config; both layers contribute fields and the
  // tenant layer can override per-field. callerOverrides win over both.
  const tenantGenCfg =
    tenantOverride && tenantOverride.generationConfig && typeof tenantOverride.generationConfig === 'object'
      ? tenantOverride.generationConfig
      : {};

  const generationConfig = _mergeGenerationConfig(
    _baseGenerationConfig(),
    versionData.generationConfig && typeof versionData.generationConfig === 'object' ? versionData.generationConfig : {},
    tenantGenCfg,
    callerOverrides && typeof callerOverrides === 'object' ? callerOverrides : {}
  );

  // Resolve model — caller > tenantOverride > version > scope default > DEFAULT_MODEL.
  const callerModel =
    callerOverrides && typeof callerOverrides === 'object' && typeof callerOverrides.model === 'string'
      ? callerOverrides.model.trim()
      : '';
  const tenantModel =
    tenantOverride && typeof tenantOverride.modelOverride === 'string' ? tenantOverride.modelOverride.trim() : '';
  const versionModel =
    typeof versionData.modelOverride === 'string' ? versionData.modelOverride.trim() : '';

  let model = callerModel || tenantModel || versionModel;
  if (!model) {
    // Honour scope.defaultModelEnvKey if set and env populated.
    const envKey = typeof scope.defaultModelEnvKey === 'string' ? scope.defaultModelEnvKey : '';
    const envVal = envKey ? String(process.env[envKey] || '').trim() : '';
    model = envVal || DEFAULT_MODEL;
  }
  // Zentrale Modell-Politik (2026-08-01): Gemini-3-Namen aus alten Scope-
  // Overrides oder ENVs werden auf 2.5 umgeleitet, nie roh an die API gereicht.
  model = resolveModelPolicy(model, undefined, DEFAULT_MODEL);

  return {
    scopeId: id,
    versionId: versionSnap.id,
    system_prompt: String(versionData.promptText || ''),
    rules_text: String(versionData.rulesText || ''),
    promptMode: versionData.promptMode === 'replace' ? 'replace' : 'append',
    rulesMode: versionData.rulesMode === 'replace' ? 'replace' : 'append',
    userTemplate: typeof versionData.userTemplate === 'string' ? versionData.userTemplate : '',
    outputSchemaHint: typeof versionData.outputSchemaHint === 'string' ? versionData.outputSchemaHint : '',
    generationConfig,
    model,
  };
}

/**
 * Resolves a model from a snapshot/version data object for the fallback path.
 * Honours version-level modelOverride, then scope.defaultModelEnvKey from ENV,
 * else DEFAULT_MODEL. (Mirrors resolveScopeConfig precedence without tenant/
 * caller layers since loadScopeWithFallback is the snapshot-only path.)
 *
 * @param {object} hit          snapshot scope entry (may include modelOverride, defaultModelEnvKey)
 * @returns {string} resolved model id
 */
function _resolveModelFromSnapshotHit(hit) {
  const versionModel =
    typeof hit?.modelOverride === 'string' && hit.modelOverride.trim()
      ? hit.modelOverride.trim()
      : '';
  if (versionModel) return resolveModelPolicy(versionModel, undefined, DEFAULT_MODEL);
  const envKey = typeof hit?.defaultModelEnvKey === 'string' ? hit.defaultModelEnvKey : '';
  const envVal = envKey ? String(process.env[envKey] || '').trim() : '';
  return resolveModelPolicy(envVal || DEFAULT_MODEL, undefined, DEFAULT_MODEL);
}

/**
 * Defensive loader that prefers Firestore but falls back to the bundled
 * snapshot file when Firestore is unreachable. Throws when both fail.
 *
 * Returns BOTH the legacy snapshot-shape fields (`promptText`/`rulesText`/
 * `modelOverride`) AND the normalized fields that `resolveScopeConfig`
 * exposes (`system_prompt`/`rules_text`/`model`). Callers may consume either
 * shape — both are populated additively for backwards-compat. (HIGH-2
 * cross-check fix.)
 *
 * @param {string} scopeName
 * @param {string|null} tenantId
 */
async function loadScopeWithFallback(scopeName, tenantId = null) {
  const id = String(scopeName || '').trim();
  if (!id) throw new Error('loadScopeWithFallback: scopeName is required');

  let firestoreError = null;
  try {
    const cfg = await getActiveLlmConfig(id);
    if (cfg) {
      return { ...cfg, source: 'firestore' };
    }
    firestoreError = new Error(`loadScopeWithFallback: scope '${id}' has no active version in Firestore`);
  } catch (err) {
    firestoreError = err;
  }

  // Fallback: bundled snapshot.
  let logger = null;
  try { logger = require('./logger'); } catch (_) { /* logger optional in tests */ }
  if (logger && typeof logger.warn === 'function') {
    logger.warn(
      { scopeId: id, tenantId: tenantId || null, reason: firestoreError ? firestoreError.message : 'unknown' },
      '[llm-config] Firestore-load failed, falling back to bundled snapshot'
    );
  }

  const snapshot = loadSnapshotFromDisk();
  if (!snapshot || !Array.isArray(snapshot.scopes) || snapshot.scopes.length === 0) {
    const e = new Error(
      `loadScopeWithFallback: Firestore failed AND no bundled snapshot available for scope '${id}' ` +
        `(firestoreError=${firestoreError ? firestoreError.message : 'n/a'})`
    );
    e.statusCode = 503;
    throw e;
  }

  const hit = snapshot.scopes.find((s) => s && s.id === id);
  if (!hit) {
    const e = new Error(
      `loadScopeWithFallback: scope '${id}' missing in snapshot and Firestore-load failed ` +
        `(firestoreError=${firestoreError ? firestoreError.message : 'n/a'})`
    );
    e.statusCode = 503;
    throw e;
  }

  const promptText = String(hit.promptText || hit.system_prompt || '');
  const rulesText = String(hit.rulesText || hit.rules_text || '');
  const generationConfig =
    hit.generationConfig && typeof hit.generationConfig === 'object' ? { ...hit.generationConfig } : {};
  const modelOverride = typeof hit.modelOverride === 'string' ? hit.modelOverride : null;
  const tenantOverrides =
    hit.tenantOverrides && typeof hit.tenantOverrides === 'object' ? hit.tenantOverrides : {};
  const resolvedModel = _resolveModelFromSnapshotHit(hit);

  return {
    scopeId: id,
    versionId: hit.versionId || hit.activeVersionId || null,
    // ── Legacy snapshot shape (backwards-compat — existing callers/tests) ──
    promptText,
    rulesText,
    promptMode: hit.promptMode === 'replace' ? 'replace' : 'append',
    rulesMode: hit.rulesMode === 'replace' ? 'replace' : 'append',
    userTemplate: typeof hit.userTemplate === 'string' ? hit.userTemplate : '',
    outputSchemaHint: typeof hit.outputSchemaHint === 'string' ? hit.outputSchemaHint : '',
    generationConfig,
    modelOverride,
    source: 'snapshot',
    snapshotGeneratedAt: snapshot.snapshotGeneratedAt || null,
    // ── Normalized shape (mirrors resolveScopeConfig — HIGH-2 fix) ─────────
    system_prompt: promptText,
    rules_text: rulesText,
    model: resolvedModel,
    user_template: typeof hit.userTemplate === 'string' ? hit.userTemplate : '',
    output_schema_hint: typeof hit.outputSchemaHint === 'string' ? hit.outputSchemaHint : '',
    generation_config: { ...generationConfig },
    tenantOverrides,
  };
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
  // Phase F.1a additions:
  resolveScopeConfig,
  loadScopeWithFallback,
  loadSnapshotFromDisk,
  __resetSnapshotCacheForTests,
  __resetActiveConfigCacheForTests,
  SNAPSHOT_FILE,
  SCOPES_COLLECTION,
};

