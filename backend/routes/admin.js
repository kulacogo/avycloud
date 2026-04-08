/**
 * Admin routes — RBAC-managed admin endpoints.
 *
 * Mounted at /api/admin in index.js.
 * All routes require requirePermission('admin', ...).
 */
const router = require('express').Router();
const { requirePermission } = require('../lib/rbac');

// --- User & Group & Role Management ---
const {
  inviteUser,
  listUsers: listUsersAdmin,
  setUserRoles: setUserRolesAdmin,
  setUserGroups: setUserGroupsAdmin,
  setUserOverrides: setUserOverridesAdmin,
  listRoles: listRolesAdmin,
  updateRole: updateRoleAdmin,
  listGroups: listGroupsAdmin,
  createGroup: createGroupAdmin,
  updateGroup: updateGroupAdmin,
  deleteGroup: deleteGroupAdmin,
} = require('../services/admin-api');

// --- LLM Config ---
const {
  listLlmScopes,
  getScope,
  listScopeVersions,
  createScopeVersion,
  activateScopeVersion,
} = require('../lib/llm-config');
const { getGeminiApiKey, __unsafeGetCachedKeySource } = require('../lib/gemini-client');

// --- Rulebook ---
const { getActiveRulebook, createRulebookVersion } = require('../lib/rulebook-admin');
const { createJob: createRulebookApplyJob, getJob: getRulebookApplyJob } = require('../lib/rulebook-apply-jobs');
const { enqueueRulebookJob } = require('../services/rulebook-runner');

// --- Bulk Jobs ---
const { createJob: createAdminBulkJob, getJob: getAdminBulkJob } = require('../lib/admin-bulk-jobs');
const { enqueueAdminBulkJob } = require('../services/admin-bulk-runner');

// --- Cloud Run Jobs ---
const { runCloudRunJob } = require('../lib/cloud-run-jobs');
const { firestore } = require('../lib/firestore');

// --- Batch Optimize ---
const { runBatchOptimize, previewBatchOptimize } = require('../services/batch-optimize');

const GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';

// =====================================================================
// Users
// =====================================================================

router.get('/users', requirePermission('admin', 'users.read'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 500, 1), 1000);
    const users = await listUsersAdmin({ limit });
    res.json({ ok: true, data: users });
  } catch (error) {
    console.error('Admin list users failed:', error);
    res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to list users' } });
  }
});

router.post('/users', requirePermission('admin', 'users.write'), async (req, res) => {
  try {
    const email = req.body?.email;
    const roles = Array.isArray(req.body?.roles) ? req.body.roles : [];
    const result = await inviteUser({ actorUid: req.user?.uid, email, roles });
    res.json({ ok: true, data: { uid: result.uid, email: result.email } });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin invite user failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Invite failed' } });
  }
});

router.put('/users/:uid/roles', requirePermission('admin', 'users.write'), async (req, res) => {
  try {
    const targetUid = req.params?.uid;
    const roles = Array.isArray(req.body?.roles) ? req.body.roles : [];
    await setUserRolesAdmin({ actorUid: req.user?.uid, targetUid, roles });
    res.json({ ok: true });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin set user roles failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to set roles' } });
  }
});

router.put('/users/:uid/groups', requirePermission('admin', 'users.write'), async (req, res) => {
  try {
    const targetUid = req.params?.uid;
    const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
    await setUserGroupsAdmin({ actorUid: req.user?.uid, targetUid, groupIds });
    res.json({ ok: true });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin set user groups failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to set groups' } });
  }
});

router.put('/users/:uid/overrides', requirePermission('admin', 'users.write'), async (req, res) => {
  try {
    const targetUid = req.params?.uid;
    const overrides = req.body?.overrides || req.body || {};
    await setUserOverridesAdmin({ actorUid: req.user?.uid, targetUid, overrides });
    res.json({ ok: true });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin set user overrides failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to set overrides' } });
  }
});

// =====================================================================
// Groups
// =====================================================================

router.get('/groups', requirePermission('admin', 'groups.read'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 200, 1), 1000);
    const groups = await listGroupsAdmin({ limit });
    res.json({ ok: true, data: groups });
  } catch (error) {
    console.error('Admin list groups failed:', error);
    res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to list groups' } });
  }
});

router.post('/groups', requirePermission('admin', 'groups.write'), async (req, res) => {
  try {
    const name = req.body?.name;
    const groupId = req.body?.groupId;
    const roleIds = Array.isArray(req.body?.roleIds) ? req.body.roleIds : [];
    const created = await createGroupAdmin({ actorUid: req.user?.uid, name, groupId, roleIds });
    res.json({ ok: true, data: created });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin create group failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to create group' } });
  }
});

router.put('/groups/:groupId', requirePermission('admin', 'groups.write'), async (req, res) => {
  try {
    const groupId = req.params?.groupId;
    const patch = req.body || {};
    await updateGroupAdmin({ actorUid: req.user?.uid, groupId, patch });
    res.json({ ok: true });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin update group failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to update group' } });
  }
});

router.delete('/groups/:groupId', requirePermission('admin', 'groups.write'), async (req, res) => {
  try {
    const groupId = req.params?.groupId;
    await deleteGroupAdmin({ actorUid: req.user?.uid, groupId });
    res.status(204).send();
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin delete group failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to delete group' } });
  }
});

// =====================================================================
// Roles
// =====================================================================

router.get('/roles', requirePermission('admin', 'roles.read'), async (req, res) => {
  try {
    const roles = await listRolesAdmin();
    res.json({ ok: true, data: roles });
  } catch (error) {
    console.error('Admin list roles failed:', error);
    res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to list roles' } });
  }
});

router.put('/roles/:roleId', requirePermission('admin', 'roles.write'), async (req, res) => {
  try {
    const roleId = req.params?.roleId;
    const patch = req.body || {};
    await updateRoleAdmin({ actorUid: req.user?.uid, roleId, patch });
    res.json({ ok: true });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin update role failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to update role' } });
  }
});

// =====================================================================
// LLM Scopes
// =====================================================================

router.get('/llm/scopes', requirePermission('admin', 'llm.read'), async (req, res) => {
  try {
    const scopes = await listLlmScopes();
    res.json({ ok: true, data: scopes });
  } catch (error) {
    console.error('Admin list LLM scopes failed:', error);
    res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to list llm scopes' } });
  }
});

// Quick diagnostics endpoint to debug "LLM down" scenarios.
// Returns whether a Gemini API key is configured and (best-effort) which models are available for the key.
router.get('/llm/health', requirePermission('admin', 'llm.read'), async (req, res) => {
  try {
    let apiKeyConfigured = false;
    let keyError = null;
    let keySource = null;
    let models = null;
    let modelsError = null;
    const parseBool = (raw) => {
      const v = (raw ?? '').toString().trim().toLowerCase();
      if (!v) return null;
      if (v === '1' || v === 'true' || v === 'yes' || v === 'y') return true;
      if (v === '0' || v === 'false' || v === 'no' || v === 'n') return false;
      return null;
    };
    const normalizeBucketName = (raw) => {
      const s = raw == null ? '' : String(raw).trim();
      if (!s) return '';
      return s.replace(/^gs:\/\//i, '').replace(/\/+$/, '').trim();
    };
    const titlePolicyDisabledFlag = parseBool(process.env.TITLE_POLICY_DISABLED ?? process.env.DISABLE_TITLE_POLICY);
    const titlePolicyEnabledFlag = parseBool(process.env.TITLE_POLICY_ENABLED);
    const titlePolicyDisabled =
      titlePolicyDisabledFlag !== null ? titlePolicyDisabledFlag : titlePolicyEnabledFlag !== null ? !titlePolicyEnabledFlag : false;

    try {
      const key = await getGeminiApiKey();
      apiKeyConfigured = Boolean(key && String(key).trim());
      keySource = typeof __unsafeGetCachedKeySource === 'function' ? __unsafeGetCachedKeySource() : null;

      if (apiKeyConfigured) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(String(key))}`;
          const resp = await fetch(url, { method: 'GET' });
          const text = await resp.text().catch(() => '');
          const json = text && text.trim().startsWith('{') ? JSON.parse(text) : null;
          if (!resp.ok) {
            const msg = json?.error?.message || `models.list failed (${resp.status})`;
            throw new Error(msg);
          }
          const list = Array.isArray(json?.models) ? json.models : [];
          models = list
            .map((m) => String(m?.baseModelId || '').trim() || String(m?.name || '').replace(/^models\//, '').trim())
            .filter(Boolean)
            .slice(0, 80);
        } catch (e) {
          modelsError = e?.message || String(e);
        }
      }
    } catch (e) {
      apiKeyConfigured = false;
      keyError = e?.message || String(e);
      keySource = typeof __unsafeGetCachedKeySource === 'function' ? __unsafeGetCachedKeySource() : null;
    }

    return res.json({
      ok: true,
      data: {
        apiKeyConfigured,
        keySource,
        keyError,
        models,
        modelsError,
        flags: {
          qualityGateEnabled: parseBool(process.env.QUALITY_GATE_ENABLED) === true,
          rulebookEnabled: parseBool(process.env.RULEBOOK_ENABLED) === true,
          titlePolicyDisabled,
          storageBucket: normalizeBucketName(process.env.STORAGE_BUCKET) || 'prodsandjobs',
        },
      },
    });
  } catch (error) {
    console.error('Admin LLM health failed:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Failed to run LLM health check', details: error?.message || String(error) },
    });
  }
});

router.get('/llm/scopes/:scopeId', requirePermission('admin', 'llm.read'), async (req, res) => {
  try {
    const scopeId = req.params?.scopeId;
    const scope = await getScope(scopeId);
    if (!scope) {
      return res.status(404).json({ ok: false, error: { code: 404, message: 'Scope not found' } });
    }
    const versions = await listScopeVersions(scopeId, { limit: 25 });
    res.json({ ok: true, data: { scope, versions } });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin get LLM scope failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to load scope' } });
  }
});

router.post('/llm/scopes/:scopeId/versions', requirePermission('admin', 'llm.write'), async (req, res) => {
  try {
    const scopeId = req.params?.scopeId;
    const version = req.body || {};
    const created = await createScopeVersion({ actorUid: req.user?.uid, scopeId, version });
    res.json({ ok: true, data: created });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin create LLM version failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to create version' } });
  }
});

router.post('/llm/scopes/:scopeId/activate/:versionId', requirePermission('admin', 'llm.write'), async (req, res) => {
  try {
    const scopeId = req.params?.scopeId;
    const versionId = req.params?.versionId;
    await activateScopeVersion({ actorUid: req.user?.uid, scopeId, versionId });
    res.json({ ok: true });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin activate LLM version failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to activate version' } });
  }
});

// =====================================================================
// Rulebook
// =====================================================================

router.get('/rulebook', requirePermission('admin', 'rules.read'), async (req, res) => {
  try {
    const active = await getActiveRulebook();
    return res.status(200).json({ ok: true, data: active });
  } catch (error) {
    console.error('Failed to load rulebook:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to load rulebook', details: error.message } });
  }
});

router.put('/rulebook', requirePermission('admin', 'rules.write'), async (req, res) => {
  try {
    const config = req.body?.config;
    const note = req.body?.note || null;
    const updatedBy = req.user?.email || req.user?.uid || 'admin';
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'config object required' } });
    }
    const version = await createRulebookVersion({ config, note, updatedBy });
    return res.status(200).json({ ok: true, data: { versionId: version.id } });
  } catch (error) {
    console.error('Failed to update rulebook:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to update rulebook', details: error.message } });
  }
});

router.post('/rulebook/apply', requirePermission('admin', 'jobs.run'), async (req, res) => {
  try {
    const invId = String(req.body?.inventoryId || '78659').trim();
    const limit = Number(req.body?.limit || 0);
    const chunkSize = Number(req.body?.chunkSize || 200);
    const minQty =
      req.body?.minQty != null && String(req.body.minQty).trim() !== '' ? Math.max(1, Math.min(9999, Number(req.body.minQty))) : null;
    const requireBin = typeof req.body?.requireBin === 'boolean' ? req.body.requireBin : null;
    const job = await createRulebookApplyJob({
      payload: { inventoryId: invId, limit, chunkSize, minQty, requireBin },
      requestedBy: req.user?.email || req.user?.uid || 'admin',
    });
    enqueueRulebookJob(job.id, true);
    return res.status(202).json({ ok: true, data: { jobId: job.id } });
  } catch (error) {
    console.error('Failed to enqueue rulebook apply job:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to enqueue rulebook job', details: error.message } });
  }
});

router.get('/rulebook/apply/:id', requirePermission('admin', 'jobs.read'), async (req, res) => {
  try {
    const job = await getRulebookApplyJob(String(req.params.id));
    if (!job) return res.status(404).json({ ok: false, error: { code: 404, message: 'Job not found' } });
    return res.status(200).json({ ok: true, data: job });
  } catch (error) {
    console.error('Failed to load rulebook apply job:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to load rulebook apply job', details: error.message } });
  }
});

// =====================================================================
// Admin Metrics — Product Coverage
// =====================================================================

router.get('/metrics/product-coverage', requirePermission('admin', 'users.read'), async (req, res) => {
  try {
    const { getAllProducts } = require('../lib/firestore');
    const { getVehicleFitmentMode } = require('../lib/vehicle-fitment');
    const { coerceTitleToPolicy, validateTitleToPolicy, inferTitleCategory } = require('../lib/title-policy');
    const { getRulebookConfigCached } = require('../lib/rulebook-config');
    const { normalizeManufacturerKey, normalizeGpsrObject } = require('../lib/gpsr-manufacturer-registry');
    const products = await getAllProducts();

    const safe = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
    const lower = (v) => safe(v).toLowerCase();
    const isPlaceholder = (val) => {
      const v = lower(val);
      if (!v) return false;
      return (
        v.includes('musterstraße') ||
        v.includes('muster str') ||
        v.includes('musterstadt') ||
        v.includes('musterbundesland') ||
        v === '12345' ||
        v.includes('info@muster') ||
        v.includes('+49 000') ||
        v === 'germany'
      );
    };

    const gpsrRequired = [
      'entity_country',
      'manufacturer_address',
      'manufacturer_city',
      'manufacturer_postalcode',
      'manufacturer_state_province',
      'manufacturer_name',
      'email',
      'manufacturer_phone',
    ];

    const gpsrRequiredFilledHistogram = {};
    const gpsrRequiredFilledHistogramIncludingPlaceholders = {};
    const totalProducts = Array.isArray(products) ? products.length : 0;

    const cfg = getRulebookConfigCached();
    const idealMinLen = 65;
    const idealMaxLen = 75;
    const hardMaxLen = Number(cfg?.title?.maxLen || 80);
    const defaultMobileMaxLen = Number(cfg?.title?.mobileMaxLen || 60);

    let titlePolicyOk = 0;
    let titlePolicyNotOk = 0;
    let titleIdealLenOk = 0;
    let ktypWithValue = 0;
    let gpsrAnyFieldPresent = 0;
    let gpsrFullRequiredPresent = 0;
    let gpsrFullRequiredNoPlaceholders = 0;
    let gpsrCandidatesNeedingEnrich = 0;

    const titleNotOkIds = [];
    const titleOkIds = [];
    const titleNotIdealLenIds = [];
    let ktypFitmentTotal = 0;
    const ktypWithValueIds = [];
    const ktypMissingInFitmentIds = [];
    const gpsrFilledCountIds = {};
    const gpsrFilledCountInclPlaceholdersIds = {};
    const gpsrFullRequiredIds = [];
    const gpsrFullRequiredNoPlaceholdersIds = [];
    const gpsrCandidatesNeedingEnrichIds = [];

    const minPrice =
      req.query?.minPrice != null && String(req.query.minPrice).trim() !== '' ? Number(req.query.minPrice) : null;
    const maxPrice =
      req.query?.maxPrice != null && String(req.query.maxPrice).trim() !== '' ? Number(req.query.maxPrice) : null;
    const priceMissingIds = [];
    const priceOkIds = [];
    const priceOutOfRangeIds = [];
    const priceNoSourcesIds = [];
    const priceStaleIds = [];
    const priceLowConfidenceIds = [];
    const priceSimilarMatchIds = [];
    const priceMaxAgeDays =
      req.query?.priceMaxAgeDays != null && String(req.query.priceMaxAgeDays).trim() !== ''
        ? Math.max(0, Number(req.query.priceMaxAgeDays) || 0)
        : 14;
    const daysSinceIso = (iso) => {
      if (!iso) return Infinity;
      const t = Date.parse(String(iso));
      if (!Number.isFinite(t)) return Infinity;
      return (Date.now() - t) / (1000 * 60 * 60 * 24);
    };
    const hasSimilarPriceWarning = (p) => {
      const warnings = Array.isArray(p?.notes?.warnings) ? p.notes.warnings : [];
      return warnings.some((w) => String(w || '').includes('Preis basiert auf ähnlichem Produkt (Specs-Match)'));
    };

    const mainCategoryCounts = {};
    const mainCategoryIds = {};
    const metricErrors = [];

    const hasBin = (p) => {
      const direct = safe(p?.storage?.binCode);
      if (direct) return true;
      const bins = Array.isArray(p?.storageBins) ? p.storageBins : [];
      return bins.some((b) => safe(b?.code || b?.binCode) && (Number(b?.quantity) || 0) > 0);
    };
    const pickQty = (p) => {
      const inv = p?.inventory?.quantity;
      if (typeof inv === 'number' && Number.isFinite(inv) && inv >= 0) return inv;
      const bins = Array.isArray(p?.storageBins) ? p.storageBins : [];
      return bins.reduce((s, b) => s + (Number(b?.quantity) || 0), 0);
    };
    const pickCategoryId = (p) =>
      safe(p?.details?.categoryId) || safe(p?.details?.ebayCategoryId) || safe(p?.details?.ebay_category_id) || '';
    const isFitmentCategory = (p) => {
      const catId = pickCategoryId(p);
      if (!catId) return false;
      try {
        return Boolean(getVehicleFitmentMode(String(catId)));
      } catch {
        return false;
      }
    };
    const hasKTyp = (p) => {
      const attrs = p?.details?.attributes && typeof p.details.attributes === 'object' ? p.details.attributes : {};
      const key = Object.keys(attrs).find((k) => {
        const l = lower(k);
        return l === 'k-typ' || l === 'ktyp' || l === 'k typ';
      });
      return Boolean(key && safe(attrs[key]));
    };
    const pickPrice = (p) => {
      const lp = p?.details?.pricing?.lowest_price || {};
      const v = lp?.amount != null ? lp.amount : lp?.price;
      const n = typeof v === 'string' ? Number(String(v).replace(',', '.')) : Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const pickMainCategory = (p) => {
      const raw = safe(p?.identification?.category);
      if (!raw) return 'Uncategorized';
      const first = raw.split('>').map((x) => safe(x)).filter(Boolean)[0];
      return first || 'Uncategorized';
    };

    const stableJson = (obj) => {
      const o = obj && typeof obj === 'object' ? obj : {};
      const keys = Object.keys(o).sort();
      const out = {};
      keys.forEach((k) => {
        out[k] = o[k];
      });
      return JSON.stringify(out);
    };

    const registryByKey = new Map();
    try {
      const snap = await firestore.collection('gpsrManufacturers').get();
      snap.forEach((doc) => {
        const data = doc.data() || {};
        const gpsr = normalizeGpsrObject(data.gpsr);
        if (gpsr && Object.keys(gpsr).length) {
          registryByKey.set(String(doc.id || '').trim(), gpsr);
        }
      });
    } catch (e) {
      // non-blocking: registry metrics will degrade gracefully
    }
    const gpsrRegistryStats = new Map();

    for (const p of Array.isArray(products) ? products : []) {
      try {
      const pid = safe(p?.id);
      const currentTitle = safe(p?.identification?.name);
      const bucket = inferTitleCategory(p);
      const bySchema = cfg?.title?.rulesBySchema && typeof cfg.title.rulesBySchema === 'object' ? cfg.title.rulesBySchema : {};
      const rule = (bySchema && bySchema[bucket]) || cfg?.title || {};
      const minLen = Number(rule?.minLen || idealMinLen);
      const softMaxLen = Number(rule?.softMaxLen || idealMaxLen);
      const maxLen = Number(rule?.maxLen || hardMaxLen);
      const ruleMobileMaxLen = Number(rule?.mobileMaxLen || defaultMobileMaxLen);

      const issues = validateTitleToPolicy(p, currentTitle, { maxLen, mobileMaxLen: ruleMobileMaxLen }) || [];
      const ok = Array.isArray(issues) ? issues.length === 0 : true;
      const len = safe(currentTitle).length;
      const idealOk = ok && len >= idealMinLen && len <= idealMaxLen;

      if (ok) {
        titlePolicyOk += 1;
        if (pid) titleOkIds.push(pid);
      } else {
        titlePolicyNotOk += 1;
        if (pid) titleNotOkIds.push(pid);
      }
      if (idealOk) {
        titleIdealLenOk += 1;
      } else if (pid) {
        titleNotIdealLenIds.push(pid);
      }

      const fitment = isFitmentCategory(p);
      if (fitment) ktypFitmentTotal += 1;
      const ktyp = hasKTyp(p);
      if (ktyp) {
        ktypWithValue += 1;
        if (pid) ktypWithValueIds.push(pid);
      } else if (fitment && pid) {
        ktypMissingInFitmentIds.push(pid);
      }

      const g = p?.details?.gpsr && typeof p.details.gpsr === 'object' ? p.details.gpsr : {};

      const brand = safe(p?.identification?.brand);
      if (brand) {
        const brandKey = normalizeManufacturerKey(brand);
        if (brandKey) {
          const rec =
            gpsrRegistryStats.get(brandKey) || {
              brand,
              total: 0,
              distinctGpsr: new Set(),
              mismatchingRegistry: 0,
              missingRegistry: 0,
            };
          rec.total += 1;
          const normalized = normalizeGpsrObject(g);
          rec.distinctGpsr.add(stableJson(normalized));
          const registryGpsr = registryByKey.get(brandKey) || null;
          if (!registryGpsr) {
            rec.missingRegistry += 1;
          } else {
            const same = stableJson(normalized) === stableJson(registryGpsr);
            if (!same) rec.mismatchingRegistry += 1;
          }
          gpsrRegistryStats.set(brandKey, rec);
        }
      }

      if (gpsrRequired.some((k) => safe(g[k]))) gpsrAnyFieldPresent += 1;

      const filledNonEmpty = gpsrRequired.reduce((n, k) => (safe(g[k]) ? n + 1 : n), 0);
      gpsrRequiredFilledHistogramIncludingPlaceholders[String(filledNonEmpty)] =
        (gpsrRequiredFilledHistogramIncludingPlaceholders[String(filledNonEmpty)] || 0) + 1;
      if (pid) {
        gpsrFilledCountInclPlaceholdersIds[String(filledNonEmpty)] =
          gpsrFilledCountInclPlaceholdersIds[String(filledNonEmpty)] || [];
        gpsrFilledCountInclPlaceholdersIds[String(filledNonEmpty)].push(pid);
      }

      const filledNoPH = gpsrRequired.reduce((n, k) => {
        const v = safe(g[k]);
        return v && !isPlaceholder(v) ? n + 1 : n;
      }, 0);
      gpsrRequiredFilledHistogram[String(filledNoPH)] = (gpsrRequiredFilledHistogram[String(filledNoPH)] || 0) + 1;
      if (pid) {
        gpsrFilledCountIds[String(filledNoPH)] = gpsrFilledCountIds[String(filledNoPH)] || [];
        gpsrFilledCountIds[String(filledNoPH)].push(pid);
      }

      const full = gpsrRequired.every((k) => safe(g[k]));
      if (full) {
        gpsrFullRequiredPresent += 1;
        if (pid) gpsrFullRequiredIds.push(pid);
      }

      const fullNoPH = gpsrRequired.every((k) => {
        const v = safe(g[k]);
        return v && !isPlaceholder(v);
      });
      if (fullNoPH) {
        gpsrFullRequiredNoPlaceholders += 1;
        if (pid) gpsrFullRequiredNoPlaceholdersIds.push(pid);
      }

      const needsGpsr = gpsrRequired.some((k) => {
        const v = safe(g[k]);
        return !v || isPlaceholder(v);
      });
      if (hasBin(p) && pickQty(p) >= 1 && needsGpsr) {
        gpsrCandidatesNeedingEnrich += 1;
        if (pid) gpsrCandidatesNeedingEnrichIds.push(pid);
      }

      const price = pickPrice(p);
      if (price == null || price <= 0) {
        if (pid) priceMissingIds.push(pid);
      } else {
        const lp = p?.details?.pricing?.lowest_price || {};
        const src = Array.isArray(lp?.sources) ? lp.sources : [];
        if (!src.length && pid) priceNoSourcesIds.push(pid);
        const conf = p?.details?.pricing?.price_confidence;
        if (typeof conf === 'number' && Number.isFinite(conf) && conf > 0 && conf < 0.5 && pid) {
          priceLowConfidenceIds.push(pid);
        }
        if (priceMaxAgeDays > 0 && daysSinceIso(lp?.last_checked_iso) > priceMaxAgeDays && pid) {
          priceStaleIds.push(pid);
        }
        if (hasSimilarPriceWarning(p) && pid) priceSimilarMatchIds.push(pid);
        const outOfRange =
          (Number.isFinite(minPrice) && minPrice != null && price < minPrice) ||
          (Number.isFinite(maxPrice) && maxPrice != null && price > maxPrice);
        if (outOfRange) {
          if (pid) priceOutOfRangeIds.push(pid);
        } else {
          if (pid) priceOkIds.push(pid);
        }
      }

      const main = pickMainCategory(p);
      mainCategoryCounts[main] = (mainCategoryCounts[main] || 0) + 1;
      if (pid) {
        mainCategoryIds[main] = mainCategoryIds[main] || [];
        mainCategoryIds[main].push(pid);
      }
      } catch (e) {
        if (metricErrors.length < 20) {
          metricErrors.push({
            id: safe(p?.id),
            message: e?.message || String(e),
          });
        }
      }
    }

    return res.status(200).json({
      ok: true,
      data: {
        totalProducts,
        title: {
          policyOkCount: titlePolicyOk,
          policyNotOkCount: titlePolicyNotOk,
          idealLenOkCount: titleIdealLenOk,
          idealMinLen,
          idealMaxLen,
          hardMaxLen,
          mobileMaxLen: defaultMobileMaxLen,
        },
        ktyp: { withValue: ktypWithValue, fitmentTotal: ktypFitmentTotal },
        gpsr: {
          requiredFields: gpsrRequired,
          requiredFilledHistogram: gpsrRequiredFilledHistogram,
          requiredFilledHistogramIncludingPlaceholders: gpsrRequiredFilledHistogramIncludingPlaceholders,
          anyFieldPresent: gpsrAnyFieldPresent,
          fullRequiredFieldsPresent: gpsrFullRequiredPresent,
          fullRequiredFieldsNoPlaceholders: gpsrFullRequiredNoPlaceholders,
          candidatesNeedingEnrich: gpsrCandidatesNeedingEnrich,
        },
        gpsr_registry: (() => {
          const entries = Array.from(gpsrRegistryStats.entries()).map(([brandKey, rec]) => ({
            brandKey,
            brand: rec.brand,
            total: rec.total,
            distinctGpsr: rec.distinctGpsr.size,
            mismatchingRegistry: rec.mismatchingRegistry,
            missingRegistry: rec.missingRegistry,
          }));
          const brandsTotal = entries.length;
          const brandsWithVariance = entries.filter((e) => e.distinctGpsr > 1).length;
          const brandsMissingRegistry = entries.filter((e) => e.missingRegistry === e.total).length;
          const productsMismatchingRegistry = entries.reduce((s, e) => s + (Number(e.mismatchingRegistry) || 0), 0);
          const topBrandsByMismatch = [...entries]
            .filter((e) => (e.mismatchingRegistry || 0) > 0)
            .sort((a, b) => (b.mismatchingRegistry - a.mismatchingRegistry) || (b.total - a.total))
            .slice(0, 12);
          return {
            brandsTotal,
            brandsWithVariance,
            brandsMissingRegistry,
            productsMismatchingRegistry,
            topBrandsByMismatch,
          };
        })(),
        price: {
          minPrice: Number.isFinite(minPrice) ? minPrice : null,
          maxPrice: Number.isFinite(maxPrice) ? maxPrice : null,
          missingCount: priceMissingIds.length,
          okCount: priceOkIds.length,
          outOfRangeCount: priceOutOfRangeIds.length,
          noSourcesCount: priceNoSourcesIds.length,
          staleCount: priceStaleIds.length,
          lowConfidenceCount: priceLowConfidenceIds.length,
          similarMatchCount: priceSimilarMatchIds.length,
          priceMaxAgeDays,
        },
        categories: {
          mainCategoryCounts,
        },
        errors: metricErrors.length ? { count: metricErrors.length, sample: metricErrors } : null,
        buckets: {
          titleOkIds,
          titleNotOkIds,
          titleNotIdealLenIds,
          ktypWithValueIds,
          ktypMissingInFitmentIds,
          gpsrFilledCountIds,
          gpsrFilledCountInclPlaceholdersIds,
          gpsrFullRequiredIds,
          gpsrFullRequiredNoPlaceholdersIds,
          gpsrCandidatesNeedingEnrichIds,
          priceMissingIds,
          priceOkIds,
          priceOutOfRangeIds,
          priceNoSourcesIds,
          priceStaleIds,
          priceLowConfidenceIds,
          priceSimilarMatchIds,
          mainCategoryIds,
        },
      },
    });
  } catch (error) {
    console.error('Error in GET /api/admin/metrics/product-coverage:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Failed to compute product coverage metrics', details: error.message },
    });
  }
});

// =====================================================================
// Admin Bulk Actions
// =====================================================================

router.post('/bulk/run', requirePermission('admin', 'jobs.run'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = String(body.action || '').trim().toLowerCase();
    if (!action) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing action' } });
    }
    const payload = {
      action,
      apply: Boolean(body.apply),
      limit: Number.isFinite(Number(body.limit)) ? Number(body.limit) : 500,
      offset: Number.isFinite(Number(body.offset)) ? Number(body.offset) : 0,
      debug: Boolean(body.debug),
      maxAgeDays: Number.isFinite(Number(body.maxAgeDays)) ? Number(body.maxAgeDays) : undefined,
      force: Boolean(body.force),
      includeUi: Boolean(body.includeUi),
      inventoryId: typeof body.inventoryId === 'string' ? body.inventoryId : undefined,
      storefront: typeof body.storefront === 'string' ? body.storefront : undefined,
      marketplaceId: typeof body.marketplaceId === 'string' ? body.marketplaceId : undefined,
      titleInsights: body.titleInsights === undefined ? undefined : Boolean(body.titleInsights),
      titleInsightsQuery: typeof body.titleInsightsQuery === 'string' ? body.titleInsightsQuery : undefined,
      titleInsightsForceRefresh:
        body.titleInsightsForceRefresh === undefined ? undefined : Boolean(body.titleInsightsForceRefresh),
      titleInsightsLimit: Number.isFinite(Number(body.titleInsightsLimit)) ? Number(body.titleInsightsLimit) : undefined,
      titleInsightsMaxHints:
        Number.isFinite(Number(body.titleInsightsMaxHints)) ? Number(body.titleInsightsMaxHints) : undefined,
      requestedBy: req.user?.email || req.user?.uid || 'admin',
    };

    const job = await createAdminBulkJob({ payload, requestedBy: payload.requestedBy, action });
    enqueueAdminBulkJob(job.id, true);
    return res.status(202).json({ ok: true, data: { jobId: job.id } });
  } catch (error) {
    console.error('Failed to enqueue admin bulk job:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Failed to enqueue admin bulk job', details: error.message },
    });
  }
});

router.get('/bulk/jobs/:id', requirePermission('admin', 'jobs.read'), async (req, res) => {
  try {
    const job = await getAdminBulkJob(String(req.params.id));
    if (!job) return res.status(404).json({ ok: false, error: { code: 404, message: 'Job not found' } });
    return res.status(200).json({ ok: true, data: job });
  } catch (error) {
    console.error('Failed to load admin bulk job:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to load job', details: error.message } });
  }
});

// =====================================================================
// GPSR Web Enrich — Cloud Run Job Trigger
// =====================================================================

router.post('/jobs/gpsr-web-enrich/run', requirePermission('admin', 'jobs.run'), async (req, res) => {
  try {
    const jobName = String(process.env.GPSR_WEB_ENRICH_JOB_NAME || '').trim();
    const location = String(process.env.CLOUD_RUN_JOBS_LOCATION || '').trim();
    const jobId = String(process.env.GPSR_WEB_ENRICH_JOB_ID || '').trim();

    if (!jobName && (!location || !jobId)) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message:
            'Cloud Run Job config missing. Set GPSR_WEB_ENRICH_JOB_NAME (recommended) or CLOUD_RUN_JOBS_LOCATION + GPSR_WEB_ENRICH_JOB_ID.',
          details: {
            GPSR_WEB_ENRICH_JOB_NAME: jobName ? 'set' : 'missing',
            CLOUD_RUN_JOBS_LOCATION: location ? 'set' : 'missing',
            GPSR_WEB_ENRICH_JOB_ID: jobId ? 'set' : 'missing',
          },
        },
      });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const limit = Number.isFinite(Number(body.limit)) ? Math.max(1, Math.min(20000, Number(body.limit))) : null;
    const concurrency = Number.isFinite(Number(body.concurrency))
      ? Math.max(1, Math.min(10, Number(body.concurrency)))
      : null;
    const minQty = Number.isFinite(Number(body.minQty)) ? Math.max(1, Math.min(9999, Number(body.minQty))) : null;
    const requireBin = body.requireBin === false ? false : true;
    const apply = body.apply === true;
    const debug = body.debug === true;

    const containerName = String(process.env.GPSR_WEB_ENRICH_CONTAINER || '').trim();
    let overrides = null;
    if (containerName && (apply || limit || concurrency || minQty || debug)) {
      const env = [];
      if (apply) env.push({ name: 'APPLY', value: '1' });
      if (debug) env.push({ name: 'DEBUG', value: '1' });
      if (limit) env.push({ name: 'LIMIT', value: String(limit) });
      if (concurrency) env.push({ name: 'CONCURRENCY', value: String(concurrency) });
      if (minQty) env.push({ name: 'MIN_QTY', value: String(minQty) });
      env.push({ name: 'REQUIRE_BIN', value: requireBin ? '1' : '0' });
      overrides = {
        containerOverrides: [
          {
            name: containerName,
            env,
          },
        ],
      };
    }

    const operation = await runCloudRunJob({
      name: jobName || '',
      projectId: GCP_PROJECT,
      location,
      jobId,
      overrides,
      validateOnly: false,
    });

    try {
      const { createJobRun } = require('../lib/admin-job-runs');
      const opName = operation?.name ? String(operation.name).trim() : null;
      await createJobRun({
        type: 'gpsr-web-enrich',
        operationName: opName,
        params: { apply, limit, concurrency, minQty, requireBin, debug },
        requestedBy: req.user?.email || req.user?.uid || 'admin',
      });
    } catch (e) {
      console.warn('[admin-job-runs] failed to persist gpsr-web-enrich run (non-blocking):', e?.message || e);
    }

    return res.json({ ok: true, data: operation });
  } catch (error) {
    console.error('Failed to run GPSR Cloud Run Job:', error);
    return res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to run GPSR Cloud Run Job',
        details: error?.message || String(error),
      },
    });
  }
});

// =====================================================================
// Admin Jobs Status (aggregate view)
// =====================================================================

router.get('/jobs/status', requirePermission('admin', 'jobs.read'), async (req, res) => {
  try {
    const { listJobsByStatus } = require('../lib/rulebook-apply-jobs');
    const { listJobRunsByType } = require('../lib/admin-job-runs');
    const { getCloudRunOperation } = require('../lib/cloud-run-jobs');
    const { listJobsByStatus: listAdminBulkJobsByStatus } = require('../lib/admin-bulk-jobs');

    const rulebookRunning = await listJobsByStatus(['pending', 'processing']);
    const adminBulkRunning = await listAdminBulkJobsByStatus(['pending', 'processing']);

    const gpsrRuns = await listJobRunsByType('gpsr-web-enrich', { limit: 5 });
    const latestGpsr = gpsrRuns?.[0] || null;

    let gpsrOperation = null;
    if (latestGpsr?.operationName) {
      try {
        gpsrOperation = await getCloudRunOperation({ name: latestGpsr.operationName });
      } catch (e) {
        gpsrOperation = { ok: false, error: e?.message || String(e) };
      }
    }

    res.json({
      ok: true,
      data: {
        rulebookApply: {
          runningCount: Array.isArray(rulebookRunning) ? rulebookRunning.length : 0,
          running: Array.isArray(rulebookRunning) ? rulebookRunning.slice(0, 10) : [],
        },
        adminBulk: {
          runningCount: Array.isArray(adminBulkRunning) ? adminBulkRunning.length : 0,
          running: Array.isArray(adminBulkRunning) ? adminBulkRunning.slice(0, 10) : [],
        },
        gpsrWebEnrich: {
          latestRun: latestGpsr,
          operation: gpsrOperation,
          recentRuns: Array.isArray(gpsrRuns) ? gpsrRuns : [],
        },
      },
    });
  } catch (error) {
    console.error('Failed to load admin jobs status:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Failed to load admin jobs status', details: error?.message || String(error) },
    });
  }
});

// --- Email Templates ---
const { listTemplates, renderEmail } = require('../lib/email-templates');

router.get('/email-templates', requirePermission('admin', 'read'), async (req, res) => {
  try {
    res.json({ ok: true, data: listTemplates() });
  } catch (error) {
    console.error('[GET /api/admin/email-templates] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/email-templates/:name/preview', requirePermission('admin', 'read'), async (req, res) => {
  try {
    const { name } = req.params;
    const sampleVars = {
      resetLink: 'https://avycloud.web.app/reset-password?oobCode=example123',
      verifyLink: 'https://avycloud.web.app/verify?oobCode=example456',
      orderNumber: 'AVC-2026-0001',
      date: new Date().toLocaleDateString('de-DE'),
      itemCount: 3,
      total: '149,99 \u20AC',
      carrier: 'DHL',
      trackingNumber: '00340434161094015902',
      trackingUrl: 'https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=00340434161094015902',
      productName: 'Samsung Galaxy S24 Ultra',
      sku: 'SAM-S24U-256',
      currentStock: 2,
      minStock: 5,
    };
    const result = renderEmail(name, sampleVars);
    res.json({ ok: true, data: { ...result, templateName: name } });
  } catch (error) {
    if (error.message.includes('Unknown email template')) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: error.message } });
    }
    console.error('[GET /api/admin/email-templates/:name/preview] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

// --- Pricing Runner Status ---
router.get('/pricing/runner-status', requirePermission('admin', 'read'), async (req, res) => {
  try {
    const { getPricingRunnerStatus } = require('../services/pricing-runner');
    res.json({ ok: true, data: getPricingRunnerStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// --- Audit Log ---
const { queryAuditLog } = require('../services/audit-log');

router.get('/audit-log', requirePermission('admin', 'read'), async (req, res) => {
  try {
    const { action, resourceType, resourceId, userId, limit, startAfter } = req.query;
    const entries = await queryAuditLog({
      action: action || null,
      resourceType: resourceType || null,
      resourceId: resourceId || null,
      userId: userId || null,
      limit: limit ? parseInt(String(limit), 10) : 100,
      startAfter: startAfter || null,
    });
    res.json({ ok: true, data: entries });
  } catch (error) {
    console.error('[GET /api/admin/audit-log] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

// ─── Marketplace Tracking Retry ─────────────────────────────────────────
/**
 * POST /api/admin/marketplace-tracking/retry
 * Retry failed marketplace tracking pushes for shipped orders.
 * Body: { maxAge?: number (days, default 7) }
 */
router.post('/admin/marketplace-tracking/retry', requirePermission('admin', 'write'), async (req, res) => {
  try {
    const { maxAge = 7 } = req.body;
    const { retryFailedMarketplacePushes } = require('../services/marketplace-tracking');
    const result = await retryFailedMarketplacePushes({ maxAge });
    res.json({ ok: true, data: result });
  } catch (error) {
    console.error('[POST /api/admin/marketplace-tracking/retry] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

/**
 * POST /api/admin/marketplace-tracking/push/:orderId
 * Force-push tracking for a specific order.
 */
router.post('/admin/marketplace-tracking/push/:orderId', requirePermission('admin', 'write'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const { ensureMarketplaceTrackingPushed } = require('../services/marketplace-tracking');
    const result = await ensureMarketplaceTrackingPushed({ orderId });
    res.json({ ok: true, data: result });
  } catch (error) {
    console.error(`[POST /api/admin/marketplace-tracking/push/${req.params.orderId}] Error:`, error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

// ── Backfill order marketplaces ───────────────────────────────────────────
// Scans all orders and resolves marketplace from raw data, writing the fix
// back to Firestore. Runs on Cloud Run which has full Firestore access.
// Usage: POST /api/admin/backfill-order-marketplaces (admin:write)
router.post('/admin/backfill-order-marketplaces', requirePermission('admin', 'write'), async (req, res) => {
  const { firestore } = require('../lib/firestore');

  const KNOWN = new Set(['ebay', 'kaufland', 'amazon', 'otto', 'shopify']);

  function detectMarketplace(order) {
    const stored = String(order.marketplace || order.source || '').toLowerCase();
    if (KNOWN.has(stored)) return null; // Already correct, no write needed

    const raw = order.raw || {};
    const rawSrc = String(raw.order_source || '').toLowerCase();
    if (rawSrc.includes('ebay')) return 'ebay';
    if (rawSrc.includes('kaufland') || rawSrc.includes('real.de') || rawSrc.includes('real')) return 'kaufland';
    if (rawSrc.includes('amazon')) return 'amazon';
    if (rawSrc.includes('otto')) return 'otto';

    const extId = String(order.marketplaceOrderId || order.externalOrderId || order.orderSourceId || '');
    if (/^\d{2}-\d{5,}-\d{5,}$/.test(extId)) return 'ebay';

    return null;
  }

  try {
    const dryRun = req.query.dry_run === 'true';
    const snap = await firestore.collection('orders').get();

    let checked = 0;
    let fixed = 0;
    let unchanged = 0;
    let unresolvable = 0;
    const BATCH_LIMIT = 400;
    let batch = firestore.batch();
    let batchCount = 0;

    const flush = async () => {
      if (batchCount > 0 && !dryRun) await batch.commit();
      batch = firestore.batch();
      batchCount = 0;
    };

    for (const doc of snap.docs) {
      checked++;
      const order = doc.data();
      const marketplace = detectMarketplace(order);

      if (!marketplace) {
        const stored = String(order.marketplace || order.source || '').toLowerCase();
        if (KNOWN.has(stored)) unchanged++;
        else unresolvable++;
        continue;
      }

      fixed++;
      if (!dryRun) {
        batch.update(doc.ref, { marketplace, source: marketplace });
        batchCount++;
        if (batchCount >= BATCH_LIMIT) await flush();
      }
    }

    await flush();

    res.json({
      ok: true,
      data: { checked, fixed, unchanged, unresolvable, dryRun },
    });
  } catch (error) {
    console.error('[POST /api/admin/backfill-order-marketplaces] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

// ─── User Sessions (Admin Read) ─────────────────────────────────────────
const { querySessions, getActiveSessions } = require('../services/user-sessions');

router.get('/sessions', requirePermission('admin', 'read'), async (req, res) => {
  try {
    const { userId, limit, startAfter } = req.query;
    const sessions = await querySessions({
      tenantId: 'default',
      userId: userId || null,
      limit: limit ? parseInt(String(limit), 10) : 50,
      startAfter: startAfter || null,
    });
    res.json({ ok: true, data: sessions });
  } catch (error) {
    console.error('[GET /api/admin/sessions] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/sessions/active', requirePermission('admin', 'read'), async (req, res) => {
  try {
    const sessions = await getActiveSessions({ tenantId: 'default' });
    res.json({ ok: true, data: sessions });
  } catch (error) {
    console.error('[GET /api/admin/sessions/active] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

// =====================================================================
// Batch Optimize (Gemini "Alles optimieren" for BIN-assigned, non-eBay products)
// =====================================================================

/**
 * GET /api/admin/batch-optimize/preview
 * Preview which products would be optimized.
 */
router.get('/batch-optimize/preview', requirePermission('admin', 'products.write'), async (req, res) => {
  try {
    const tenantId = req.query.tenantId || req.user?.tenantId || null;
    const preview = await previewBatchOptimize({ tenantId });
    res.json({ ok: true, data: preview });
  } catch (error) {
    console.error('[GET /api/admin/batch-optimize/preview]', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

/**
 * POST /api/admin/batch-optimize/run
 * Start batch optimization. Body:
 *   { dryRun?: boolean, limit?: number, offset?: number }
 *
 * Returns results synchronously (long-running — use generous timeout).
 */
router.post('/batch-optimize/run', requirePermission('admin', 'products.write'), async (req, res) => {
  try {
    const { dryRun = false, limit = 0, offset = 0 } = req.body || {};
    const tenantId = req.body?.tenantId || req.user?.tenantId || null;

    console.log(`[POST /api/admin/batch-optimize/run] user=${req.user?.uid}, dryRun=${dryRun}, limit=${limit}, offset=${offset}`);

    const result = await runBatchOptimize({
      dryRun: Boolean(dryRun),
      limit: Number(limit) || 0,
      offset: Number(offset) || 0,
      tenantId,
    });

    res.json({ ok: true, data: result });
  } catch (error) {
    console.error('[POST /api/admin/batch-optimize/run]', error.message, error);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

module.exports = router;
