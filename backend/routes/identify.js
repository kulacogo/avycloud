'use strict';

const router = require('express').Router();
const multer = require('multer');
const crypto = require('crypto');
const { requirePermission } = require('../lib/rbac');
const { identifyLimiter } = require('../lib/rate-limit');
const { getProduct, findProductByStrictIdentifier, adjustPendingIntakeQuantity, firestore } = require('../lib/firestore');
const { saveProductV2 } = require('../lib/product-store');
const { getJob, listJobs, FieldValue } = require('../lib/jobs');
const { updateJob } = require('../lib/improve-jobs');
const { enqueueJob } = require('../services/job-runner');
const { ensureCategories, runDatasheetReview, prefetchWebEvidenceForIdentify, applyEbayTaxonomy, applyKauflandTaxonomy } = require('../services/enrichment');
const { runSerpapiFreePipeline } = require('../services/enrichment-v2');
const { buildProductFromV2Record } = require('../lib/v2-product-builder');
const { runProductChat } = require('../services/product-chat');
const { buildSessionId, getSession, appendMessages, clearSession, getGeminiHistory } = require('../lib/chat-sessions');
const { isBannedEbayBreadcrumb } = require('../lib/ebay-category-governance');
const { findEbayCategory } = require('../lib/ebay-taxonomy');
const { enrichPriceForProductBestEffort } = require('../lib/price-enrichment');

// --- Constants ---
const MAX_IMAGE_FILES = 30;
const MAX_CHAT_ATTACHMENTS = parseInt(process.env.CHAT_ATTACHMENT_MAX_FILES || '6', 10);
const MAX_CHAT_ATTACHMENT_SIZE = parseInt(process.env.CHAT_ATTACHMENT_MAX_SIZE || `${6 * 1024 * 1024}`, 10); // 6 MB per attachment
const CHAT_ATTACHMENT_TEXT_LIMIT = parseInt(process.env.CHAT_ATTACHMENT_TEXT_LIMIT || '6000', 10);
const CHAT_ATTACHMENT_MIME_WHITELIST = new Set([
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const MAX_IMAGE_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per file

const JOB_STATUS_FILTERS = ['pending', 'processing', 'failed', 'done'];

// --- Multer configurations ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_FILE_SIZE,
    files: MAX_IMAGE_FILES,
  },
});

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_CHAT_ATTACHMENT_SIZE,
    files: MAX_CHAT_ATTACHMENTS,
  },
  fileFilter(req, file, cb) {
    if (file.mimetype.startsWith('image/')) {
      return cb(null, true);
    }
    if (CHAT_ATTACHMENT_MIME_WHITELIST.has(file.mimetype)) {
      return cb(null, true);
    }
    return cb(new Error('UNSUPPORTED_CHAT_ATTACHMENT'));
  },
});

const chatUploadMiddleware = (req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    return chatUpload.array('attachments', MAX_CHAT_ATTACHMENTS)(req, res, (error) => {
      if (error) {
        const message =
          error.message === 'UNSUPPORTED_CHAT_ATTACHMENT'
            ? 'Unsupported attachment type. Allowed: JPG, PNG, WEBP, PDF, TXT, CSV, JSON.'
            : error.message;
        return res.status(400).json({
          ok: false,
          error: {
            code: 400,
            message,
          },
        });
      }
      return next();
    });
  }
  return next();
};

// --- Helper functions ---

const normalizeJobStatuses = (raw) => {
  if (!raw) {
    return null;
  }
  const values = Array.isArray(raw) ? raw : String(raw).split(',');
  const normalized = values
    .map((value) => value && value.toString().trim().toLowerCase())
    .filter((value) => value && JOB_STATUS_FILTERS.includes(value));
  return normalized.length ? Array.from(new Set(normalized)) : null;
};

const summarizeJobPayload = (payload = {}) => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const files = Array.isArray(payload.files)
    ? payload.files.map((file) => ({
      path: file?.path || null,
      originalName: file?.originalName || null,
      mimeType: file?.mimeType || null,
      size: Number.isFinite(file?.size) ? file.size : null,
    }))
    : [];
  return {
    locale: payload.locale || null,
    model: payload.model || null,
    barcodes: payload.barcodes || '',
    fileCount: files.length,
    files,
  };
};

const summarizeJobResult = (job = {}) => {
  if (!job || !job.result) {
    return null;
  }
  const products = Array.isArray(job.result?.products) ? job.result.products : [];
  if (!products.length) {
    return { productCount: 0, products: [] };
  }
  return {
    productCount: products.length,
    products: products.slice(0, 5).map((product) => ({
      id: product?.id || null,
      name: product?.identification?.name || product?.details?.identifiers?.sku || null,
      sku:
        product?.identification?.sku ||
        product?.details?.identifiers?.sku ||
        product?.details?.identifiers?.ean ||
        null,
    })),
  };
};

const formatJobForResponse = (job = {}) => ({
  id: job.id,
  status: job.status,
  attempts: job.attempts || 0,
  createdAt: job.createdAt || null,
  updatedAt: job.updatedAt || null,
  startedAt: job.startedAt || null,
  finishedAt: job.finishedAt || null,
  model: job.modelUsed || job.payload?.model || null,
  payload: summarizeJobPayload(job.payload),
  error: job.error || null,
  result: summarizeJobResult(job),
  reuseEvents: Array.isArray(job.reuseEvents) ? job.reuseEvents : undefined,
});

// ────────────────────────────────────────────────
// Routes (mounted at /api in index.js)
// ────────────────────────────────────────────────

// POST /api/jobs — Legacy tombstone (410 Gone)
router.post('/jobs', upload.array('images'), async (req, res) => {
  return res.status(410).json({
    ok: false,
    error: {
      code: 410,
      message: 'Legacy Identify-Jobs werden nicht mehr unterstützt. Bitte /api/v2/enrich verwenden.',
    },
  });
});

// POST /api/v2/enrich — SerpAPI-free pipeline, no DB write
router.post('/v2/enrich', requirePermission('identify', 'run'), identifyLimiter, upload.array('images'), async (req, res) => {
  try {
    const files = req.files || [];
    const barcodes = req.body?.barcodes || '';
    if (!files.length && (!barcodes || !barcodes.trim())) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: 'Bitte mindestens ein Bild oder einen Barcode bereitstellen.',
        },
      });
    }

    const locale = req.body?.locale || 'de-DE';
    const result = await runSerpapiFreePipeline({ files, barcodes, locale });

    return res.json({
      ok: true,
      data: result.record,
      meta: {
        locale: result.locale,
        barcodes: result.barcodes,
        ocr: result.ocr,
        llm: result.llm,
        barcodeInsights: result.barcodeInsights,
        quality: result.quality,
      },
    });
  } catch (error) {
    console.error('SerpAPI-free enrichment failed:', error);
    const detailsRaw = error?.message || 'Unknown error';
    const details = String(detailsRaw).replace(/\s+/g, ' ').trim().slice(0, 400);
    return res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: details
          ? `SerpAPI-freies Enrichment fehlgeschlagen. (${details})`
          : 'SerpAPI-freies Enrichment fehlgeschlagen.',
        details: details || 'Unknown error',
      },
    });
  }
});

// v2 Identify (single pipeline): runs serpapi-free pipeline + server-side datasheet review,
// persists product in SYSTEM mode (so invariants like title policy + condition rules apply),
// and returns the saved product (already ready for Quality Gate).
router.post('/v2/identify', requirePermission('identify', 'run'), identifyLimiter, upload.array('images'), async (req, res) => {
  try {
    const files = req.files || [];
    const barcodes = req.body?.barcodes || '';
    const locale = req.body?.locale || 'de-DE';
    const inventoryId = req.body?.inventoryId || null;
    const paletteCode = req.body?.paletteCode || null;
    const hint = typeof req.body?.hint === 'string' && req.body.hint.trim()
      ? req.body.hint.trim().slice(0, 400)
      : null;

    if (!files.length && (!barcodes || !barcodes.trim())) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Bitte mindestens ein Bild oder einen Barcode bereitstellen.' },
      });
    }

    // Palette is required for new products
    if (!paletteCode || !paletteCode.trim()) {
      return res.status(400).json({
        ok: false,
        error: { code: 'PALETTE_REQUIRED', message: 'Paletten-Zuordnung ist Pflicht für neue Ware.' },
      });
    }

    // Validate palette exists as a BIN in warehouseBins
    const paletteBinSnap = await firestore.collection('warehouseBins').doc(paletteCode.trim()).get();
    if (!paletteBinSnap.exists) {
      return res.status(400).json({
        ok: false,
        error: { code: 'PALETTE_NOT_FOUND', message: `Palette ${paletteCode} existiert nicht.` },
      });
    }

    // 1) Identify + OCR + record
    const result = await runSerpapiFreePipeline({ files, barcodes, locale, inventoryId, hint });

    // 2) Stock protection: if this identifier already exists, never overwrite datasheet.
    const strictBarcodes = []
      .concat(Array.isArray(result?.barcodeInsights?.ranked) ? result.barcodeInsights.ranked.map((r) => r?.code) : [])
      .concat([result?.barcodeInsights?.selected?.ean, result?.barcodeInsights?.selected?.gtin])
      .concat(Array.isArray(result?.barcodes) ? result.barcodes : [])
      .filter(Boolean)
      .map((c) => String(c).trim())
      .filter(Boolean)
      .slice(0, 8);
    const strictSku =
      result?.record?.sku && typeof result.record.sku === 'string' && result.record.sku.trim() && result.record.sku.trim().toLowerCase() !== 'unknown'
        ? result.record.sku.trim()
        : null;

    const existing = await findProductByStrictIdentifier({ barcodes: strictBarcodes, sku: strictSku });
    if (existing?.id) {
      // Best-effort: mark incoming stock as pending intake (do not touch the datasheet)
      try {
        await adjustPendingIntakeQuantity(existing.id, 1);
      } catch (e) {
        console.warn('Failed to adjust pending intake for existing product:', e?.message || e);
      }
      // Track source palette on existing product (additive, never overwrites datasheet)
      if (paletteCode) {
        try {
          const { PRODUCTS_COLLECTION } = require('../lib/firestore');
          await firestore.collection(PRODUCTS_COLLECTION).doc(existing.id).update({
            'ops.sourcePalette': paletteCode,
            'ops.sourcePaletteAt': new Date().toISOString(),
          });
        } catch (e) {
          console.warn('Failed to set sourcePalette on existing product:', e?.message || e);
        }
      }
      const refreshed = await getProduct(existing.id);
      return res.json({
        ok: true,
        data: refreshed || existing,
        meta: {
          reused_existing: true,
          paletteCode: paletteCode || null,
          locale: result.locale,
          barcodes: result.barcodes,
          ocr: result.ocr,
          llm: result.llm,
          barcodeInsights: result.barcodeInsights,
          quality: result.quality,
        },
      });
    }

    // 3) Build initial product (server-side), then run taxonomy + datasheet review using OCR evidence.
    let product = buildProductFromV2Record(result.record, {
      fallbackId: crypto.randomUUID(),
      barcodes,
      locale,
      inventoryId: inventoryId || null,
    });

    // 3.0) Hard rule: no product may be persisted without an eBay category.
    // v2 records often contain only a free-text internalCategory; `saveProduct()` will clear
    // free-text categories when no valid `details.categoryId` exists, resulting in category-less products.
    await ensureCategories([product]);

    product = applyEbayTaxonomy(product);
    product = applyKauflandTaxonomy(product);

    // Provide evidence to the review step (OCR/web hints). This avoids "invented" specs and helps granularity.
    const evidence = {
      ocr: result.ocr || null,
      barcodes: result.barcodes || [],
      barcodeInsights: result.barcodeInsights || null,
      llm: result.llm || null,
    };

    // Optional: prefetch small web excerpts (BrightData-backed when configured) to push Identify towards 99% completeness.
    // This is SerpAPI-free and is used as *evidence only* (no guessing).
    const enablePrefetch =
      String(process.env.IDENTIFY_PREFETCH_WEB_EVIDENCE || 'true').toLowerCase() === 'true';
    if (enablePrefetch) {
      try {
        const webEnrich = await prefetchWebEvidenceForIdentify({
          barcodeList: result.barcodes || [],
          ocrTextSnippets: result?.ocr?.textSnippets || [],
          locale,
        });
        if (webEnrich) {
          evidence.web_enrich = webEnrich;
        }
      } catch (e) {
        // Best-effort: never fail Identify because web prefetch failed.
        console.warn('Identify web evidence prefetch failed (continuing):', e?.message || e);
      }
    }

    await runDatasheetReview([product], {
      locale,
      webEvidence: evidence,
      marketplaceEvidence: true,
      llmScopeId: 'identify.v2',
    });

    // Retry once if still not eBay-ready (title/desc/highlights/attrs). This keeps Identify outputs stable.
    try {
      const { evaluateEbayReady } = require('../lib/datasheet-quality');
      // The post-review retry is meant to fix text/spec issues. Pricing is enriched separately.
      const eval1 = evaluateEbayReady(product, { force: true, ignorePrice: true });
      if (!eval1.ok && eval1.issues && eval1.issues.length) {
        await runDatasheetReview([product], {
          locale,
          webEvidence: evidence,
          qualityIssuesById: { [product.id]: eval1.issues },
          marketplaceEvidence: true,
          llmScopeId: 'identify.v2',
        });
      }
    } catch (e) {
      console.warn('Identify post-review evaluation failed (continuing):', e?.message || e);
    }

    // 3.5) K-Typ enrichment (AUTO/MOTO only, MVL-backed, never guessing).
    // Best-effort: do not fail Identify if enrichment can't be done.
    try {
      const { enrichKTypIfPossible } = require('../lib/ktype-enrichment');
      await enrichKTypIfPossible(product, { reason: 'identify' });
    } catch (e) {
      console.warn('Identify K-Typ enrichment failed (continuing):', e?.message || e);
    }

    // 3.6) Price enrichment (best-effort). Identify outputs should include a price when possible.
    // This uses SerpAPI when enabled, otherwise falls back to BrightData-backed web search + unlocker scraping.
    try {
      await enrichPriceForProductBestEffort(product, { force: false, reason: 'identify' });
    } catch (e) {
      console.warn('Identify price enrichment failed (continuing):', e?.message || e);
    }

    // 3.7) Web image search — add up to 3 real product images from the web (BUG-088)
    try {
      const existingImages = Array.isArray(product?.details?.images) ? product.details.images : [];
      const hasEnoughImages = existingImages.filter(img => img?.url_or_base64?.startsWith('http')).length >= 3;
      if (!hasEnoughImages) {
        const { fetchMarketingImages } = require('../lib/marketing-images');
        const brand = product?.identification?.brand || '';
        const name = product?.identification?.name || '';
        const category = product?.identification?.category || '';
        const ids = product?.details?.identifiers || {};
        const identifiers = [ids.ean, ids.gtin, ids.upc, ids.mpn].filter(Boolean);
        const exclude = existingImages.map(img => img?.url_or_base64).filter(Boolean);

        const { images } = await fetchMarketingImages({
          brand,
          name,
          category,
          identifiers,
          mpn: ids.mpn || '',
          limit: 3,
          exclude,
        });

        if (images.length) {
          product.details = product.details || {};
          product.details.images = product.details.images || [];
          for (const img of images) {
            if (img?.url) {
              product.details.images.push({
                url_or_base64: img.url,
                source: img.source || 'web_search',
                variant: 'marketing',
              });
            }
          }
          console.log(`[identify] Added ${images.length} web images for ${product.id}`);
        }
      }
    } catch (e) {
      console.warn('Identify web image search failed (continuing):', e?.message || e);
    }

    // 3.8) Compute and persist quality snapshot (independent of QUALITY_GATE_ENABLED).
    // This powers UI/debug dashboards and helps explain "why not ebay-ready" without blocking saves.
    let finalQuality = null;
    try {
      const { evaluateEbayReady } = require('../lib/datasheet-quality');
      finalQuality = evaluateEbayReady(product, { force: true });
      product.ops = product.ops || {};
      product.ops.data_quality = product.ops.data_quality || {};
      product.ops.data_quality.identify_v2_quality_v1 = {
        checked_at_iso: new Date().toISOString(),
        ok: Boolean(finalQuality.ok),
        issues: Array.isArray(finalQuality.issues) ? finalQuality.issues.slice(0, 40) : [],
        issues_detailed: Array.isArray(finalQuality.issuesDetailed)
          ? finalQuality.issuesDetailed.slice(0, 60)
          : [],
        snapshot: finalQuality.snapshot || null,
      };
    } catch (e) {
      finalQuality = null;
    }

    // 3.9) Final invariant: refuse to save without a valid (allowed) eBay category id.
    const finalCategoryId = String(product?.details?.categoryId || '').trim();
    const finalCategory = finalCategoryId ? findEbayCategory(finalCategoryId) : null;
    const finalBreadcrumb = finalCategory?.breadcrumb ? String(finalCategory.breadcrumb) : '';
    if (
      !finalCategoryId ||
      !finalCategory ||
      !finalBreadcrumb ||
      !finalBreadcrumb.includes('>') ||
      isBannedEbayBreadcrumb(finalBreadcrumb)
    ) {
      throw new Error(
        `Identify (v2) refused to save product without valid eBay category (categoryId="${finalCategoryId || ''}")`
      );
    }

    // 4) Persist source palette reference if provided (Wareneingang tracking).
    if (paletteCode) {
      product.ops = product.ops || {};
      product.ops.sourcePalette = paletteCode;
      product.ops.sourcePaletteAt = new Date().toISOString();
    }

    // 4) Persist (SYSTEM mode => invariants enforced; never treated as manual UI edit).
    await saveProductV2(product, {
      allowCategoryChange: true,
      mode: 'system',
      source: 'identify',
      overwriteTextFields: true,
      replaceAttributes: true,
      syncIdentifiersFromBarcodes: true,
    });

    const saved = await getProduct(product.id);
    return res.json({
      ok: true,
      data: saved || product,
      meta: {
        reused_existing: false,
        locale: result.locale,
        barcodes: result.barcodes,
        ocr: result.ocr,
        llm: result.llm,
        barcodeInsights: result.barcodeInsights,
        quality: result.quality,
        ebayReady: finalQuality ? Boolean(finalQuality.ok) : null,
        ebayReadyIssues: finalQuality ? finalQuality.issues || [] : [],
        ebayReadyIssuesDetailed: finalQuality ? finalQuality.issuesDetailed || [] : [],
        ebayReadySnapshot: finalQuality ? finalQuality.snapshot || null : null,
      },
    });
  } catch (error) {
    console.error('v2 identify failed:', error);
    const detailsRaw = error?.message || 'Unknown error';
    const details = String(detailsRaw).replace(/\s+/g, ' ').trim().slice(0, 400);
    return res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: details ? `Identify (v2) fehlgeschlagen. (${details})` : 'Identify (v2) fehlgeschlagen.',
        details: details || 'Unknown error',
      },
    });
  }
});

// GET /api/jobs — List identification jobs
router.get('/jobs', requirePermission('jobs', 'read'), async (req, res) => {
  try {
    const statuses = normalizeJobStatuses(req.query?.status) || ['pending', 'processing'];
    const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 100);
    const cursor = typeof req.query?.cursor === 'string' && req.query.cursor ? req.query.cursor : null;
    const order = req.query?.order === 'asc' ? 'asc' : 'desc';

    const { jobs, nextCursor } = await listJobs({
      statuses,
      limit,
      cursor,
      order,
    });

    const formatted = jobs.map(formatJobForResponse);
    const stats = formatted.reduce(
      (acc, job) => {
        const key = job.status || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        acc.total += 1;
        return acc;
      },
      { total: 0 }
    );

    res.json({
      ok: true,
      data: {
        jobs: formatted,
        nextCursor,
        hasMore: Boolean(nextCursor),
        stats,
        filters: {
          statuses,
          limit,
          order,
        },
      },
    });
  } catch (error) {
    console.error('Failed to list identification jobs:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to load identification jobs.',
      },
    });
  }
});

// GET /api/jobs/:id — Job detail
router.get('/jobs/:id', requirePermission('jobs', 'read'), async (req, res) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 404,
          message: 'Job not found',
        },
      });
    }

    const response = {
      id: job.id,
      status: job.status,
      attempts: job.attempts,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      model: job.payload?.model || null,
    };

    if (job.status === 'done') {
      response.result = job.result;
      response.serpTrace = job.serpTrace;
    }
    if (job.status === 'failed') {
      response.error = job.error;
    }

    res.json({
      ok: true,
      data: response,
    });
  } catch (error) {
    console.error('Failed to load job:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to load job',
        details: error.message,
      },
    });
  }
});

// GET /api/jobs/:id/stream — SSE real-time job status stream
router.get('/jobs/:id/stream', requirePermission('jobs', 'read'), (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const jobId = req.params.id;
  const unsubscribe = firestore.collection('identificationJobs').doc(jobId)
    .onSnapshot((snap) => {
      if (snap.exists) {
        res.write(`data: ${JSON.stringify(snap.data())}\n\n`);
      }
    }, (err) => {
      console.error(`[SSE] Snapshot error for job ${jobId}:`, err.message);
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    });

  req.on('close', () => {
    unsubscribe();
    res.end();
  });
});

// POST /api/jobs/:id/retry — Reset job status + re-enqueue (NOTE: no requirePermission)
router.post('/jobs/:id/retry', async (req, res) => {
  const jobId = req.params?.id;
  if (!jobId) {
    return res.status(400).json({
      ok: false,
      error: {
        code: 400,
        message: 'Job-ID fehlt.',
      },
    });
  }
  try {
    const job = await getJob(jobId);
    if (!job) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 404,
          message: 'Job nicht gefunden.',
        },
      });
    }

    await updateJob(jobId, {
      status: 'pending',
      startedAt: FieldValue.delete(),
      finishedAt: FieldValue.delete(),
      error: FieldValue.delete(),
      result: FieldValue.delete(),
      serpTrace: FieldValue.delete(),
      reuseEvents: FieldValue.delete(),
    });
    enqueueJob(jobId, true);
    res.json({
      ok: true,
      data: {
        id: jobId,
        status: 'pending',
      },
    });
  } catch (error) {
    console.error(`Failed to retry job ${jobId}:`, error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Job konnte nicht neu gestartet werden.',
      },
    });
  }
});

// POST /api/identify — Legacy tombstone (410 Gone)
router.post('/identify', upload.array('images'), async (req, res) => {
  return res.status(410).json({
    ok: false,
    error: {
      code: 410,
      message: 'Legacy /api/identify wird nicht mehr unterstützt. Bitte /api/v2/enrich verwenden.',
    },
  });
});

// GET /api/chat/session/:productId — Load existing chat session history
router.get('/chat/session/:productId', requirePermission('ai', 'chat'), async (req, res) => {
  try {
    const userId = req.user?.uid;
    const { productId } = req.params;
    if (!userId || !productId) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'userId and productId required' } });
    }
    const session = await getSession(userId, productId);
    res.json({ ok: true, session });
  } catch (error) {
    console.error('[GET /api/chat/session] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

// DELETE /api/chat/session/:productId — Clear chat session history
router.delete('/chat/session/:productId', requirePermission('ai', 'chat'), async (req, res) => {
  try {
    const userId = req.user?.uid;
    const { productId } = req.params;
    if (!userId || !productId) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'userId and productId required' } });
    }
    await clearSession(userId, productId);
    res.json({ ok: true });
  } catch (error) {
    console.error('[DELETE /api/chat/session] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

// POST /api/chat — Product chat via Gemini
// Supports ?stream=true for SSE streaming (progress events + final result)
router.post('/chat', requirePermission('ai', 'chat'), identifyLimiter, chatUploadMiddleware, async (req, res) => {
  const streamMode = req.query.stream === 'true';

  try {
    const { productId, message, model: bodyModel, scope } = req.body;
    const modelOverride = req.query?.model || bodyModel || null;
    const attachments =
      Array.isArray(req.files) && req.files.length
        ? req.files.map((file) => ({
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          buffer: file.buffer,
        }))
        : [];
    const hasAttachments = attachments.length > 0;
    const normalizedMessage = typeof message === 'string' ? message.trim() : '';

    if (!productId || (!normalizedMessage && !hasAttachments)) {
      if (streamMode) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Product ID und entweder eine Nachricht oder Dateianhänge sind erforderlich.' })}\n\n`);
        return res.end();
      }
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Product ID und entweder eine Nachricht oder Dateianhänge sind erforderlich.' },
      });
    }

    const product = await getProduct(productId);
    if (!product) {
      if (streamMode) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Product not found' })}\n\n`);
        return res.end();
      }
      return res.status(404).json({ ok: false, error: { code: 404, message: 'Product not found' } });
    }

    // Load conversation history for this user+product session
    const userId = req.user?.uid;
    const sessionId = buildSessionId(userId, productId);
    let session = null;
    let conversationHistory = [];
    try {
      session = await getSession(userId, productId);
      conversationHistory = getGeminiHistory(session);
    } catch (e) {
      console.warn('[chat] Could not load session history:', e.message);
    }

    const payloadMessage = normalizedMessage || 'Bitte analysiere die angehängten Dateien.';
    const normalizedScope = typeof scope === 'string' ? scope.trim() : null;

    if (streamMode) {
      // SSE streaming mode: write progress events as they happen
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const writeEvent = (event) => {
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          // Client disconnected
        }
      };

      const onProgress = (event) => writeEvent(event);

      try {
        const chatResult = await runProductChat(product, payloadMessage, {
          modelOverride,
          attachments,
          scope: normalizedScope,
          history: conversationHistory,
          onProgress,
        });

        // Save messages to session (best-effort, non-blocking)
        appendMessages(sessionId, userId, productId, payloadMessage, chatResult.message || '').catch((e) => {
          console.warn('[chat] Failed to save session:', e.message);
        });

        writeEvent({ type: 'result', data: chatResult, model: chatResult.modelUsed });
        writeEvent({ type: 'done' });
      } catch (error) {
        console.error('[chat stream] Error:', error.message);
        writeEvent({ type: 'error', message: String(error?.message || 'Unknown error').slice(0, 500) });
      }
      return res.end();
    }

    // Sync mode (default): await full result, respond with JSON
    const chatResult = await runProductChat(product, payloadMessage, {
      modelOverride,
      attachments,
      scope: normalizedScope,
      history: conversationHistory,
    });

    // Save messages to session (best-effort, non-blocking)
    appendMessages(sessionId, userId, productId, payloadMessage, chatResult.message || '').catch((e) => {
      console.warn('[chat] Failed to save session:', e.message);
    });

    res.json({ ok: true, model: chatResult.modelUsed, data: chatResult });

  } catch (error) {
    console.error('Error in chat endpoint:', error);
    const detailsRaw = error?.message || 'Unknown error';
    const details = String(detailsRaw).replace(/\s+/g, ' ').trim().slice(0, 500);
    if (streamMode && !res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ type: 'error', message: details })}\n\n`);
      return res.end();
    }
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        model: error.modelUsed,
        error: {
          code: 500,
          message: details ? `Failed to process chat request (${details})` : 'Failed to process chat request',
          details: details || 'Unknown error',
        },
      });
    }
  }
});

// --- Image grouping endpoint (Auto-Separation) ---
router.post('/v2/group-images', requirePermission('identify', 'run'), upload.array('images'), async (req, res) => {
  try {
    const files = req.files || [];
    const barcodes = req.body?.barcodes || '';

    if (files.length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'NO_IMAGES', message: 'Mindestens ein Bild erforderlich.' } });
    }

    const imageBuffers = files.map((f, idx) => ({
      id: idx,
      buffer: f.buffer,
      mimeType: f.mimetype,
      filename: f.originalname,
    }));

    // Single image: use multi-product detection instead of standard grouping
    if (files.length === 1) {
      const { detectMultipleProducts } = require('../services/image-grouping');

      let detectedProducts = [];
      try {
        detectedProducts = await detectMultipleProducts(imageBuffers);
      } catch (err) {
        console.warn('[group-images] multi-product detection failed, falling back to single group:', err.message);
      }

      let groups;
      if (detectedProducts.length > 1) {
        groups = detectedProducts.map((p, idx) => {
          const hintParts = [
            p.label,
            p.brand_hint ? `Marke: ${p.brand_hint}` : null,
            p.category_hint ? `Kategorie: ${p.category_hint}` : null,
            p.barcode_hint ? `Barcode: ${p.barcode_hint}` : null,
            p.bounding_description ? `Position: ${p.bounding_description}` : null,
          ].filter(Boolean);
          return {
            id: `group_${idx}`,
            label: p.label || `Produkt ${idx + 1}`,
            image_indices: [0],
            confidence: p.confidence,
            reason: p.bounding_description || '',
            detected_barcode: p.barcode_hint || null,
            hint: hintParts.join('. '),
          };
        });
      } else {
        // Single product or detection failed — normal single group
        groups = [{
          id: 'group_0',
          label: detectedProducts[0]?.label || 'Produkt 1',
          image_indices: [0],
          confidence: detectedProducts[0]?.confidence ?? 1,
          reason: detectedProducts[0]?.bounding_description || '',
          detected_barcode: detectedProducts[0]?.barcode_hint || null,
          hint: null,
        }];
      }

      return res.json({ ok: true, data: { groups, imageCount: 1 } });
    }

    // BUG-090: Use structured output with image compression + batching
    const { groupImagesStructured } = require('../services/image-grouping');

    let groups = [];
    try {
      groups = await groupImagesStructured(imageBuffers, files.length);
    } catch (err) {
      console.warn(`[group-images] Structured grouping failed for ${files.length} images:`, err.message);
    }

    // Ensure every image is in at least one group
    const allIndices = new Set();
    groups.forEach((g) => g.image_indices.forEach((i) => allIndices.add(i)));
    const orphaned = [];
    for (let i = 0; i < files.length; i++) {
      if (!allIndices.has(i)) orphaned.push(i);
    }
    if (orphaned.length && groups.length) {
      groups[0].image_indices.push(...orphaned);
    }

    // BUG-090 Fix 3: Log warning on fallback instead of silently swallowing
    if (!groups.length) {
      console.warn(`[group-images] Empty grouping result for ${files.length} images — falling back to single group.`);
      groups = [{
        id: 'group_0',
        label: 'Produkt 1',
        image_indices: Array.from({ length: files.length }, (_, i) => i),
        confidence: 1,
        reason: 'Fallback: alle Bilder in eine Gruppe',
        detected_barcode: null,
      }];
    }

    res.json({ ok: true, data: { groups, imageCount: files.length } });
  } catch (err) {
    console.error(`[POST /api/v2/group-images] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'GROUPING_FAILED', message: err.message } });
  }
});

module.exports = router;
