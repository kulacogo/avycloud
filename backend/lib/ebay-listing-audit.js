const { FieldValue } = require('@google-cloud/firestore');
const { firestore } = require('./firestore');
const { getItemDetails } = require('./ebay-trading-api');
const { reviseFixedPriceItem, reviseItem } = require('./ebay-trading-api');
const { fetchCategoryTitleInsights, tokenizeTitle } = require('./ebay-browse-title-insights');
const { getCategoryAspectCatalog } = require('./ebay-taxonomy');

const EBAY_LISTINGS_COLLECTION = 'ebayListingsLive';
const EBAY_AUDITS_COLLECTION = 'ebayListingAudits';

const DEFAULT_AUDIT_TTL_MS = Math.max(60_000, parseInt(process.env.EBAY_LISTING_AUDIT_TTL_MS || '900000', 10) || 900000); // 15m

function safeString(value) {
  return value == null ? '' : String(value).trim();
}

function safeLower(value) {
  return safeString(value).toLowerCase();
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function toNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanUndefined(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  Object.entries(obj).forEach(([k, v]) => {
    if (v === undefined) return;
    out[k] = v;
  });
  return out;
}

function normalizeKeyToken(value) {
  return safeString(value)
    .toLowerCase()
    .replace(/\u00E4/g, 'ae')
    .replace(/\u00F6/g, 'oe')
    .replace(/\u00FC/g, 'ue')
    .replace(/\u00DF/g, 'ss')
    .replace(/[^a-z0-9]+/g, '');
}

function truncateToMaxChars(value, maxLen) {
  const limit = Math.max(1, Number(maxLen) || 80);
  const s = safeString(value).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length <= limit) return s;
  const cut = s.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace >= Math.floor(limit * 0.6)) {
    return cut.slice(0, lastSpace).trim();
  }
  return cut.trim();
}

function buildSpecificIndex(itemSpecifics) {
  const obj = itemSpecifics && typeof itemSpecifics === 'object' ? itemSpecifics : {};
  const byToken = new Map();
  Object.keys(obj).forEach((key) => {
    const token = normalizeKeyToken(key);
    if (!token) return;
    if (!byToken.has(token)) byToken.set(token, key);
  });
  return byToken;
}

function pickSpecificValue(itemSpecifics, keyCandidates = []) {
  const obj = itemSpecifics && typeof itemSpecifics === 'object' ? itemSpecifics : {};
  const byToken = buildSpecificIndex(obj);
  for (const candidate of keyCandidates) {
    const token = normalizeKeyToken(candidate);
    const key = token ? byToken.get(token) : null;
    if (!key) continue;
    const values = asArray(obj[key]).map((v) => safeString(v)).filter(Boolean);
    if (values.length) return { key, value: values[0], values };
  }
  return null;
}

function buildTitleQuery({ title, itemSpecifics }) {
  const plainTitle = safeString(title).slice(0, 120);
  const brand = pickSpecificValue(itemSpecifics, ['Marke', 'Brand', 'Hersteller', 'Manufacturer'])?.value || '';
  const mpn =
    pickSpecificValue(itemSpecifics, ['Herstellernummer', 'MPN', 'Manufacturer Part Number', 'ManufacturerPartNumber'])
      ?.value || '';
  const barcode = pickSpecificValue(itemSpecifics, ['EAN', 'GTIN', 'UPC'])?.value || '';

  if (barcode) return `${barcode} ${brand} ${mpn}`.trim().slice(0, 100);
  if (brand && mpn) return `${brand} ${mpn}`.trim().slice(0, 100);
  if (brand) return `${brand} ${plainTitle}`.trim().slice(0, 100);
  return plainTitle.slice(0, 100);
}

function buildListingSnapshot({ listingDoc, detail }) {
  const price = toNumber(detail?.currentPrice ?? listingDoc?.currentPrice);
  const currency = safeString(detail?.currency || listingDoc?.currency) || null;
  const pictureUrls = Array.isArray(detail?.pictureUrls) ? detail.pictureUrls : [];
  return cleanUndefined({
    itemId: safeString(detail?.itemId || listingDoc?.itemId),
    sku: safeString(detail?.sku || listingDoc?.sku) || null,
    title: safeString(detail?.title || listingDoc?.title) || null,
    subtitle: safeString(detail?.subtitle || listingDoc?.subtitle) || null,
    primaryCategoryId: safeString(detail?.primaryCategoryId || listingDoc?.primaryCategoryId) || null,
    listingType: safeString(detail?.listingType || listingDoc?.listingType) || null,
    listingStatus: safeString(detail?.listingStatus || listingDoc?.listingStatus) || null,
    viewItemUrl: safeString(detail?.viewItemUrl || listingDoc?.viewItemUrl) || null,
    price: price == null ? null : { value: price, currency: currency || null },
    pictureCount: pictureUrls.length,
    updatedAtIso: safeString(listingDoc?.updatedAtIso) || null,
  });
}

function computeAudit({ listingDoc, detail, titleInsights, aspectCatalog }) {
  const findings = [];
  const suggestions = [];

  const title = safeString(detail?.title || listingDoc?.title);
  const titleLen = title.length;
  if (!title) {
    findings.push({
      id: 'title:missing',
      area: 'title',
      severity: 'critical',
      title: 'Titel fehlt',
      message: 'Das Listing hat keinen Titel (oder konnte nicht geladen werden).',
    });
  } else {
    if (titleLen > 80) {
      const trimmed = truncateToMaxChars(title, 80);
      findings.push({
        id: 'title:too_long',
        area: 'title',
        severity: 'warn',
        title: 'Titel zu lang',
        message: `Titel hat ${titleLen} Zeichen (eBay Hard-Max: 80).`,
        data: { length: titleLen, hardMax: 80 },
      });
      if (trimmed && trimmed !== title) {
        suggestions.push({
          id: 'title:trim_to_80',
          area: 'title',
          severity: 'warn',
          title: 'Titel auf 80 Zeichen kürzen',
          message: 'Kürze den Titel auf maximal 80 Zeichen (ohne neue Fakten hinzuzufügen).',
          patch: { title: trimmed },
          apply: { mode: 'trading_revise', fields: ['title'] },
        });
      }
    } else if (titleLen < 70) {
      findings.push({
        id: 'title:too_short',
        area: 'title',
        severity: 'info',
        title: 'Titel potenziell zu kurz',
        message: `Titel hat ${titleLen} Zeichen (bevorzugt: 70–80).`,
        data: { length: titleLen, preferredMin: 70, preferredMax: 80, hardMax: 80 },
      });

      const itemSpecifics = detail?.itemSpecifics || {};
      const brand = pickSpecificValue(itemSpecifics, ['Marke', 'Brand', 'Hersteller', 'Manufacturer'])?.value || '';
      const mpn =
        pickSpecificValue(itemSpecifics, ['Herstellernummer', 'MPN', 'Manufacturer Part Number', 'ManufacturerPartNumber'])
          ?.value || '';
      const addTokens = [];
      if (brand && !safeLower(title).includes(safeLower(brand))) addTokens.push(brand);
      if (mpn && !safeLower(title).includes(safeLower(mpn))) addTokens.push(mpn);
      if (addTokens.length) {
        const proposed = truncateToMaxChars(`${title} ${addTokens.join(' ')}`, 80);
        if (proposed && proposed !== title) {
          suggestions.push({
            id: 'title:append_known_identifiers',
            area: 'title',
            severity: 'info',
            title: 'Titel mit belegbaren Tokens ergänzen',
            message: 'Ergänze Brand/MPN aus den vorhandenen Item Specifics, um die Suchrelevanz zu erhöhen (ohne neue Fakten).',
            patch: { title: proposed },
            apply: { mode: 'trading_revise', fields: ['title'] },
          });
        }
      }
    }
  }

  // Competitor token ideas (informational)
  const topTokens = Array.isArray(titleInsights?.topTokens) ? titleInsights.topTokens : [];
  const competitorTokens = topTokens.map((t) => safeString(t?.token)).filter(Boolean);
  const titleTokens = title ? tokenizeTitle(title) : [];
  const missingCompetitorTokens = competitorTokens.filter((t) => !titleTokens.includes(t)).slice(0, 10);
  if (title && competitorTokens.length) {
    findings.push({
      id: 'title:competitor_token_coverage',
      area: 'title',
      severity: 'info',
      title: 'Keyword-Ideen aus ähnlichen Angeboten',
      message: missingCompetitorTokens.length
        ? `In ähnlichen Angeboten häufig: ${missingCompetitorTokens.slice(0, 8).join(', ')}`
        : 'Titel deckt viele häufige Tokens ähnlicher Angebote bereits ab.',
      data: {
        competitorTopTokens: topTokens.slice(0, 16),
        missingTokens: missingCompetitorTokens,
      },
    });
  }

  // Required/recommended aspects
  const requiredAspects = Array.isArray(aspectCatalog?.requiredAspects) ? aspectCatalog.requiredAspects : [];
  const recommendedAspects = Array.isArray(aspectCatalog?.recommendedAspects) ? aspectCatalog.recommendedAspects : [];
  const listingSpecifics = detail?.itemSpecifics && typeof detail.itemSpecifics === 'object' ? detail.itemSpecifics : {};
  const listingSpecificTokens = buildSpecificIndex(listingSpecifics);
  const hasAspect = (name) => listingSpecificTokens.has(normalizeKeyToken(name));

  const missingRequired = requiredAspects.filter((name) => name && !hasAspect(name));
  const missingRecommended = recommendedAspects.filter((name) => name && !hasAspect(name));

  if (requiredAspects.length) {
    if (missingRequired.length) {
      findings.push({
        id: 'specifics:missing_required',
        area: 'specifics',
        severity: 'critical',
        title: 'Pflichtmerkmale fehlen',
        message: `Pflichtmerkmale (eBay Kategorie): ${missingRequired.slice(0, 12).join(', ')}${missingRequired.length > 12 ? ' …' : ''}`,
        data: { missingRequired },
      });
      suggestions.push({
        id: 'specifics:fill_required',
        area: 'specifics',
        severity: 'critical',
        title: 'Pflichtmerkmale ergänzen',
        message:
          'Ergänze die fehlenden Pflichtmerkmale (idealerweise aus Herstellerdaten/Barcode/MPN/Evidence). AvyCloud kann Vorschläge ableiten, aber ohne sichere Evidence wird nichts automatisch gesetzt.',
        patch: null,
        apply: { mode: 'manual', fields: ['itemSpecifics'] },
        data: { missingRequired },
      });
    } else {
      findings.push({
        id: 'specifics:required_ok',
        area: 'specifics',
        severity: 'info',
        title: 'Pflichtmerkmale vorhanden',
        message: 'Die Pflichtmerkmale der Kategorie scheinen vollständig zu sein.',
      });
    }
  }

  if (recommendedAspects.length && missingRecommended.length) {
    findings.push({
      id: 'specifics:missing_recommended',
      area: 'specifics',
      severity: 'warn',
      title: 'Empfohlene Merkmale fehlen',
      message: `Empfohlene Merkmale: ${missingRecommended.slice(0, 12).join(', ')}${missingRecommended.length > 12 ? ' …' : ''}`,
      data: { missingRecommended },
    });
  }

  // Pictures
  const pictureUrls = Array.isArray(detail?.pictureUrls) ? detail.pictureUrls : [];
  if (!pictureUrls.length) {
    findings.push({
      id: 'images:none_detected',
      area: 'images',
      severity: 'warn',
      title: 'Keine Bilder erkannt',
      message: 'Es konnten keine Picture URLs aus dem Listing geladen werden.',
    });
  } else if (pictureUrls.length < 5) {
    findings.push({
      id: 'images:few',
      area: 'images',
      severity: 'warn',
      title: 'Zu wenige Bilder',
      message: `Nur ${pictureUrls.length} Bild(er) im Listing. Ziel: ≥ 5 für bessere Conversion.`,
      data: { pictureCount: pictureUrls.length },
    });
    suggestions.push({
      id: 'images:add_more',
      area: 'images',
      severity: 'warn',
      title: 'Mehr Bilder hinzufügen',
      message:
        'Ergänze weitere packshot-nahe Bilder (verschiedene Perspektiven, Details, ggf. Verpackung/Label). In v1 wird das nicht automatisch applied.',
      patch: null,
      apply: { mode: 'manual', fields: ['pictures'] },
    });
  }

  // Description
  const description = safeString(detail?.description);
  if (!description) {
    findings.push({
      id: 'description:missing',
      area: 'description',
      severity: 'warn',
      title: 'Beschreibung fehlt',
      message: 'Listing enthält keine Beschreibung (oder sie konnte nicht geladen werden).',
    });
  } else if (description.length < 200) {
    findings.push({
      id: 'description:short',
      area: 'description',
      severity: 'info',
      title: 'Beschreibung potenziell zu kurz',
      message: `Beschreibung hat ${description.length} Zeichen. Prüfe, ob wichtige Infos/Kompatibilität/Condition/Versand klar sind.`,
      data: { length: description.length },
    });
  }

  return { findings, suggestions };
}

async function getListingAudit(itemId) {
  const key = safeString(itemId);
  if (!key) return null;
  const snap = await firestore.collection(EBAY_AUDITS_COLLECTION).doc(key).get();
  if (!snap.exists) return null;
  return { ...(snap.data() || {}), itemId: snap.id };
}

async function computeListingAudit(itemId, { forceRefresh = false, actor = null, runId = null, timeoutMs = 25000 } = {}) {
  const key = safeString(itemId);
  if (!key) {
    const error = new Error('Missing itemId');
    error.code = 'EBAY_AUDIT_ITEM_ID_REQUIRED';
    throw error;
  }

  const auditRef = firestore.collection(EBAY_AUDITS_COLLECTION).doc(key);
  if (!forceRefresh) {
    const cached = await auditRef.get();
    if (cached.exists) {
      const data = cached.data() || {};
      const updatedAtIso = safeString(data.updatedAtIso);
      const updatedAtMs = updatedAtIso ? Date.parse(updatedAtIso) : NaN;
      if (Number.isFinite(updatedAtMs) && updatedAtMs > Date.now() - DEFAULT_AUDIT_TTL_MS) {
        return { ...data, itemId: key, fromCache: true };
      }
    }
  }

  const listingSnap = await firestore.collection(EBAY_LISTINGS_COLLECTION).doc(key).get();
  const listingDoc = listingSnap.exists ? listingSnap.data() || {} : null;
  if (!listingDoc) {
    const error = new Error('Listing not found (run light-sync or full sync first).');
    error.code = 'EBAY_LISTING_NOT_FOUND';
    throw error;
  }

  const detailResult = await getItemDetails(key, { timeoutMs });
  const detail = detailResult?.item || {};
  const categoryId = safeString(detail?.primaryCategoryId || listingDoc?.primaryCategoryId);
  const title = safeString(detail?.title || listingDoc?.title);
  const itemSpecifics = detail?.itemSpecifics || {};

  const aspectCatalog = categoryId ? getCategoryAspectCatalog(categoryId) : getCategoryAspectCatalog(null);
  const query = buildTitleQuery({ title, itemSpecifics });
  const titleInsights = categoryId
    ? await fetchCategoryTitleInsights({ categoryId, query, limit: 80, forceRefresh: false })
    : { ok: false, categoryId: '', query, titles: [], topTokens: [], error: 'missing_category_id', fromCache: false };

  const { findings, suggestions } = computeAudit({
    listingDoc,
    detail,
    titleInsights: titleInsights && titleInsights.ok ? titleInsights : null,
    aspectCatalog,
  });

  const nowIso = new Date().toISOString();
  const payload = cleanUndefined({
    itemId: key,
    status: 'fresh',
    updatedAtIso: nowIso,
    actor: safeString(actor) || null,
    runId: safeString(runId) || null,
    listingSnapshot: buildListingSnapshot({ listingDoc, detail }),
    evidence: {
      titleInsights: titleInsights && titleInsights.ok ? titleInsights : null,
      aspects: cleanUndefined({
        categoryId: categoryId || null,
        requiredAspects: Array.isArray(aspectCatalog?.requiredAspects) ? aspectCatalog.requiredAspects : [],
        recommendedAspects: Array.isArray(aspectCatalog?.recommendedAspects) ? aspectCatalog.recommendedAspects : [],
      }),
    },
    findings,
    suggestions,
  });

  const existingAudit = await auditRef.get();
  const existingCreatedAt = existingAudit.exists ? existingAudit.data()?.createdAt || null : null;

  await auditRef.set(
    {
      ...payload,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: existingCreatedAt || FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { ...payload, fromCache: false };
}

function resolveReviseCallName(listingDetail) {
  const type = safeLower(listingDetail?.listingType);
  if (type.includes('fixed')) return 'ReviseFixedPriceItem';
  return 'ReviseItem';
}

function normalizeAuditPatch(patch = {}) {
  const input = patch && typeof patch === 'object' ? patch : {};
  const out = {};
  if (typeof input.title === 'string' && input.title.trim()) {
    out.title = truncateToMaxChars(input.title, 80);
  }
  if (typeof input.subtitle === 'string') {
    const s = safeString(input.subtitle);
    if (s) out.subtitle = s;
  }
  if (typeof input.description === 'string') {
    // Keep HTML as-is; Trading API supports CDATA
    out.description = input.description;
  }
  if (input.itemSpecifics && typeof input.itemSpecifics === 'object') {
    const map = {};
    Object.entries(input.itemSpecifics).forEach(([k, v]) => {
      const key = safeString(k);
      if (!key) return;
      const values = asArray(v).map((x) => safeString(x)).filter(Boolean);
      if (!values.length) return;
      map[key] = values;
    });
    if (Object.keys(map).length) out.itemSpecifics = map;
  }
  return out;
}

async function applyListingAuditSuggestions(
  itemId,
  { suggestionIds = null, patch = null, actor = null, timeoutMs = 25000, runId = null } = {}
) {
  const key = safeString(itemId);
  if (!key) {
    const error = new Error('Missing itemId');
    error.code = 'EBAY_APPLY_ITEM_ID_REQUIRED';
    throw error;
  }

  const auditRef = firestore.collection(EBAY_AUDITS_COLLECTION).doc(key);
  const auditSnap = await auditRef.get();
  const auditDoc = auditSnap.exists ? auditSnap.data() || {} : null;
  if (!auditDoc) {
    const error = new Error('Audit not found. Run audit first.');
    error.code = 'EBAY_AUDIT_NOT_FOUND';
    throw error;
  }

  const selectedIds = Array.isArray(suggestionIds)
    ? suggestionIds.map((x) => safeString(x)).filter(Boolean)
    : null;

  const suggestionList = Array.isArray(auditDoc?.suggestions) ? auditDoc.suggestions : [];
  const selectedSuggestions = selectedIds ? suggestionList.filter((s) => selectedIds.includes(safeString(s?.id))) : [];

  const mergedPatch = (() => {
    if (patch && typeof patch === 'object') return patch;
    const out = {};
    selectedSuggestions.forEach((s) => {
      if (!s?.patch || typeof s.patch !== 'object') return;
      Object.assign(out, s.patch);
    });
    return out;
  })();

  const normalizedPatch = normalizeAuditPatch(mergedPatch);
  const hasPatchFields =
    Boolean(normalizedPatch?.title) ||
    Boolean(normalizedPatch?.subtitle) ||
    typeof normalizedPatch?.description === 'string' ||
    Boolean(Object.keys(normalizedPatch?.itemSpecifics || {}).length);
  if (!hasPatchFields) {
    const error = new Error('No applicable patch fields found in selected suggestions.');
    error.code = 'EBAY_APPLY_NO_PATCH';
    throw error;
  }

  // Always re-fetch live listing details before revise (prevents stale required specifics/constraints).
  const live = await getItemDetails(key, { timeoutMs });
  const listing = live?.item || {};
  const callName = resolveReviseCallName(listing);
  const revisePayload = { itemId: key, ...normalizedPatch };

  try {
    const response = callName === 'ReviseFixedPriceItem' ? await reviseFixedPriceItem(revisePayload) : await reviseItem(revisePayload);
    await auditRef.set(
      cleanUndefined({
        status: 'stale',
        lastApplyAtIso: new Date().toISOString(),
        lastApplyRunId: safeString(runId) || null,
        lastApplyActor: safeString(actor) || null,
        lastApplyOk: true,
        lastApplyError: null,
        updatedAt: FieldValue.serverTimestamp(),
      }),
      { merge: true }
    );
    return {
      ok: true,
      itemId: key,
      callName,
      ack: response?.ack || 'Success',
      appliedSuggestionIds: selectedIds || null,
      patch: normalizedPatch,
    };
  } catch (error) {
    const message = error?.message || String(error);
    const isInventoryModel = safeLower(message).includes('inventory model') || safeLower(message).includes('inventory api');
    await auditRef.set(
      cleanUndefined({
        status: 'stale',
        lastApplyAtIso: new Date().toISOString(),
        lastApplyRunId: safeString(runId) || null,
        lastApplyActor: safeString(actor) || null,
        lastApplyOk: false,
        lastApplyError: message,
        updatedAt: FieldValue.serverTimestamp(),
      }),
      { merge: true }
    );
    const err = new Error(
      isInventoryModel
        ? `Trading-Revise nicht erlaubt (Inventory-Model Listing). ${message}`
        : `eBay Revise fehlgeschlagen: ${message}`
    );
    err.code = isInventoryModel ? 'EBAY_APPLY_INVENTORY_MODEL' : 'EBAY_APPLY_FAILED';
    throw err;
  }
}

module.exports = {
  EBAY_AUDITS_COLLECTION,
  getListingAudit,
  computeListingAudit,
  applyListingAuditSuggestions,
};

