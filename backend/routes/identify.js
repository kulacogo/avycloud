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
const { ensureCategories, runDatasheetReview, prefetchWebEvidenceForIdentify, prefetchWebEvidenceParallel, applyEbayTaxonomy, applyKauflandTaxonomy } = require('../services/enrichment');
const { runSerpapiFreePipeline } = require('../services/enrichment-v2');
const { buildProductFromV2Record } = require('../lib/v2-product-builder');
const { runProductChat } = require('../services/product-chat');
const { runProductChatV2 } = require('../services/product-chat-v2');
const { runProductChatV3, chatV3Enabled } = require('../services/product-chat-v3');
const { buildSessionId, getSession, appendMessages, clearSession, getGeminiHistory } = require('../lib/chat-sessions');
const { isBannedEbayBreadcrumb } = require('../lib/ebay-category-governance');
const { findEbayCategory } = require('../lib/ebay-taxonomy');
const { enrichPriceParallel } = require('../lib/price-enrichment');
const { searchProductImages } = require('../lib/image-search');
const { recordIdentifyMetric, getIdentifyHealth } = require('../lib/identify-metrics');
const { getExternalApiStats } = require('../lib/external-api-tracker');
const logger = require('../lib/logger');

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

    // Wall-clock for the heavy path must start HERE — not after V4 / OCR / uploads.
    // Otherwise elapsedMs() ignores early work while the browser timer runs from fetch()
    // start, producing client AbortErrors ("Timeout"/"Failed to fetch") mid-response.
    // Default aligns with IDENTIFY_TOTAL_TIMEOUT_MS in api/client.ts + Cloud Run (--timeout 600).
    const requestStartedAt = Date.now();
    const IDENTIFY_TOTAL_TIMEOUT_MS = parseInt(process.env.IDENTIFY_TOTAL_TIMEOUT_MS || '360000', 10);
    const elapsedMs = () => Date.now() - requestStartedAt;
    const remainingMs = () => Math.max(0, IDENTIFY_TOTAL_TIMEOUT_MS - elapsedMs());

    let v3Meta = null;
    let v4Meta = null;
    let pipelineUsed = null;
    let product = null;
    let groundingUsed = false;
    let legacyResult = null;

    // Sprint 1 — Observability. Single fire-and-forget Firestore write per request via
    // res.on('finish'). All variables below are captured by closure so the hook always
    // sees the final state. Validation errors (4xx) are skipped — they reflect user input,
    // not pipeline behavior. Never throws; never blocks the response.
    const tenantIdForMetric = req.tenantId || req.user?.tenantId || 'default';
    const imageCountForMetric = files.length;
    const barcodeCountForMetric = String(barcodes || '')
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean).length;
    let metricErrorMessage = null;
    let metricDuplicateReused = false;
    res.on('finish', () => {
      const code = res.statusCode;
      let status;
      if (code >= 200 && code < 300) {
        status = metricDuplicateReused ? 'duplicate_reused' : 'success';
      } else if (code === 504 || code === 408) {
        status = 'timeout';
      } else if (code >= 500) {
        status = 'error';
      } else {
        // 4xx (validation, palette missing, etc.) — not a pipeline signal
        return;
      }
      recordIdentifyMetric({
        tenantId: tenantIdForMetric,
        pipeline:
          pipelineUsed ||
          (v3Meta ? 'v3' : groundingUsed ? 'grounding' : legacyResult ? 'legacy' : 'unknown'),
        durationMs: elapsedMs(),
        status,
        errorCode: code !== 200 ? `HTTP_${code}` : null,
        errorMessage: metricErrorMessage,
        imageCount: imageCountForMetric,
        barcodeCount: barcodeCountForMetric,
        productId: product?.id || null,
      });
    });
    let groundingImageQuery = '';

    // ─── IDENTIFY V4: opt-in pipeline (IDENTIFY_V4=true) ───
    // Runs BEFORE V3/V2/Legacy grounding. On throw or ok:false, falls through
    // to the existing pipeline below — never returns a 500 from V4 itself.
    try {
      const { identifyProductV4, identifyV4Enabled } = require('../services/identify-v4');
      // Canary support — also activate V4 for a sampled fraction of traffic
      // even when the master flag is off. Set IDENTIFY_V4_CANARY_RATE=0.1 to
      // run V4 for 10 % of requests. Tenant whitelisting via
      // IDENTIFY_V4_CANARY_TENANTS=tenantA,tenantB.
      const canaryRate = Number(process.env.IDENTIFY_V4_CANARY_RATE || '0');
      const canaryTenants = String(process.env.IDENTIFY_V4_CANARY_TENANTS || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const reqTenant = req.tenantId || req.user?.tenantId || null;
      const v4ByCanaryRate =
        Number.isFinite(canaryRate) && canaryRate > 0 && Math.random() < Math.min(1, canaryRate);
      const v4ByTenant = canaryTenants.length > 0 && reqTenant && canaryTenants.includes(reqTenant);
      const v4FlagEnabled =
        typeof identifyV4Enabled === 'function' && identifyV4Enabled();
      const useV4 = v4FlagEnabled || v4ByCanaryRate || v4ByTenant;

      if (useV4) {
        // Inject a pre-built Gemini client so identity-worker, attributes-
        // worker, image-worker and critic-worker can actually run their
        // Gemini-backed branches. Without this `aiClient` is null and the
        // workers run in a heavily degraded "atomic-tools-only" mode that's
        // worse than V3 — exactly the failure mode flagged in the V4 audit.
        let injectedAiClient = null;
        try {
          const { getGenAIClient } = require('../lib/gemini3-client');
          injectedAiClient = await getGenAIClient();
        } catch (clientErr) {
          console.warn(
            '[identify] V4: failed to construct aiClient, workers will run degraded:',
            clientErr?.message || clientErr,
          );
        }

        try {
          const v4Result = await identifyProductV4({
            files,
            barcodes,
            locale,
            hint,
            paletteCode,
            inventoryId,
            tenantId: reqTenant,
            userId: req.userId || req.user?.uid || null,
            aiClient: injectedAiClient,
            // The route owns final persistence and must stay the single writer.
            autosave: false,
          });
          if (v4Result && v4Result.ok) {
            product = v4Result.product || null;
            v4Meta = {
              ...(v4Result.meta || {}),
              pipeline: 'v4',
              v4_route: v4FlagEnabled ? 'flag' : (v4ByTenant ? 'tenant_canary' : 'rate_canary'),
            };
            pipelineUsed = 'v4';
            groundingImageQuery = [
              product?.identification?.brand,
              product?.identification?.name?.split(' ').slice(0, 3).join(' '),
            ].filter(Boolean).join(' ').trim();
          } else {
            console.warn(
              '[identify] V4 returned ok:false, falling back to V3:',
              v4Result?.error || 'unknown',
            );
          }
        } catch (v4Err) {
          console.warn('[identify] V4 threw, falling back to V3:', v4Err?.message || v4Err);
        }
        // Fall through to V3 below (no return)
      }
    } catch (v4RequireErr) {
      // identify-v4 module not yet shipped — silently skip so V3 path runs.
      console.warn('[identify] V4 module unavailable, using V3:', v4RequireErr?.message || v4RequireErr);
    }

    // ─── PERF-001 v2: Google Search Grounding Pipeline ───
    // Single Gemini call with images + Google Search + Structured Output.
    // Replaces: runSerpapiFreePipeline + prefetchWebEvidence + runDatasheetReview ×2 + enrichPrice + fetchMarketingImages

    const GROUNDING_ENABLED =
      String(process.env.IDENTIFY_GROUNDING || 'true').toLowerCase() === 'true';

    // 1) OCR + Image Upload (parallel)
    const { extractOcrPayload } = require('../lib/vision-ocr');
    const { uploadImage } = require('../lib/storage');
    const sharp = require('sharp');

    const [ocrPayload, uploadedImages] = await Promise.all([
      extractOcrPayload(files),
      Promise.all(
        files.map(async (f, idx) => {
          if (!f?.buffer) return null;
          try {
            const result = await uploadImage(f.buffer, f.mimetype || 'image/jpeg', 'identify-uploads', `v2_${Date.now()}_${idx}`);
            return { url: result.url, width: result.width, height: result.height };
          } catch { return null; }
        })
      ).then((results) => results.filter(Boolean)),
    ]);

    // Explicit barcodes from the request (per-group specific)
    const explicitBarcodes = barcodes ? barcodes.split(/[\s,;|]+/).filter(Boolean) : [];
    // All barcodes including OCR (for grounding pipeline identification)
    const mergedBarcodes = [
      ...new Set([
        ...explicitBarcodes,
        ...(ocrPayload.barcodes || []),
      ]),
    ];
    // Duplikat-Reuse-Quelle (Incident 2026-07-08): NUR physisch belegte
    // Identifier — explizite Barcodes + OCR-Barcodes aus GENAU diesen Bildern.
    // KI-/Grounding-aufgeloeste EAN/GTIN/UPC/SKU duerfen NIE ein Reuse
    // triggern: bei Grounding-Timeouts halluzinierte Gemini eine fremde
    // ATE-EAN, drei verschiedene Produkte matchten dasselbe Bestandsprodukt
    // und die frischen Identify-Ergebnisse wurden stillschweigend verworfen.
    const physicalReuseBarcodes = mergedBarcodes.slice(0, 12);

    // 2) Stock protection: check if product already exists
    //    ONLY use explicit per-group barcodes, NOT OCR barcodes.
    //    OCR extracts ALL barcodes from ALL images — in multi-product scenarios
    //    (e.g. 5 products in 3 images) this would match unrelated products.
    const existing = explicitBarcodes.length
      ? await findProductByStrictIdentifier({
          barcodes: explicitBarcodes.slice(0, 8),
          sku: null,
        })
      : null;
    if (existing?.id) {
      try { await adjustPendingIntakeQuantity(existing.id, 1); } catch {}
      if (paletteCode) {
        try {
          const { PRODUCTS_COLLECTION } = require('../lib/firestore');
          await firestore.collection(PRODUCTS_COLLECTION).doc(existing.id).update({
            'ops.sourcePalette': paletteCode,
            'ops.sourcePaletteAt': new Date().toISOString(),
          });
        } catch {}
      }
      const refreshed = await getProduct(existing.id);
      metricDuplicateReused = true;
      return res.json({
        ok: true,
        data: refreshed || existing,
        meta: { reused_existing: true, paletteCode: paletteCode || null, locale, barcodes: mergedBarcodes },
      });
    }

    // ─── IDENTIFY V3: Multi-Stage Pipeline ───
    // Aligned with CLAUDE.md "IDENTIFY_V3=true (default-on)". Explicit
    // IDENTIFY_V3=false in env disables it again. Total wall-clock starts after
    // palette validation (IDENTIFY_TOTAL_TIMEOUT_MS); V3 cap is min(V3_TIMEOUT_MS, remainingMs()).
    const V3_ENABLED = String(process.env.IDENTIFY_V3 || 'true').toLowerCase() === 'true';

    if (!product && V3_ENABLED) {
      try {
        const { identifyProductV3 } = require('../services/identify-v3');
        console.log('[identify] Using V3 multi-stage pipeline');
        const V3_TIMEOUT_MS = parseInt(process.env.V3_TIMEOUT_MS || '120000', 10);
        // Cap V3 by whichever is smaller: its own budget or the remaining wall-clock budget.
        const v3Cap = Math.min(V3_TIMEOUT_MS, remainingMs());
        const v3Result = await Promise.race([
          identifyProductV3({ files, barcodes, locale, hint, paletteCode, inventoryId }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`V3 pipeline timeout after ${v3Cap}ms`)), v3Cap)
          ),
        ]);
        product = v3Result.product;
        v3Meta = v3Result.meta;
        pipelineUsed = 'v3';
        groundingUsed = Boolean(v3Meta?.stages?.stage1?.groundingUsed);
        groundingImageQuery = [
          product.identification?.brand,
          product.identification?.name?.split(' ').slice(0, 3).join(' '),
        ].filter(Boolean).join(' ').trim();

        // Post-V3 duplicate check — NUR physische Barcodes (explizit + OCR
        // dieser Bilder). KI-aufgeloeste Identifier (details.identifiers,
        // identification.barcodes aus Grounding) sind hier TABU, siehe
        // physicalReuseBarcodes-Kommentar oben (Incident 2026-07-08).
        if (physicalReuseBarcodes.length) {
          const v3Existing = await findProductByStrictIdentifier({
            barcodes: physicalReuseBarcodes,
            sku: null,
          });
          if (v3Existing?.id) {
            console.log(`[identify] Post-V3 duplicate found: ${v3Existing.id}`);
            try { await adjustPendingIntakeQuantity(v3Existing.id, 1); } catch {}
            if (paletteCode) {
              try {
                const { PRODUCTS_COLLECTION } = require('../lib/firestore');
                await firestore.collection(PRODUCTS_COLLECTION).doc(v3Existing.id).update({
                  'ops.sourcePalette': paletteCode,
                  'ops.sourcePaletteAt': new Date().toISOString(),
                });
              } catch {}
            }
            const refreshed = await getProduct(v3Existing.id);
            metricDuplicateReused = true;
            return res.json({
              ok: true,
              data: refreshed || v3Existing,
              meta: { reused_existing: true, paletteCode: paletteCode || null, locale, barcodes: physicalReuseBarcodes },
            });
          }
        }
      } catch (v3Error) {
        console.warn('[identify] V3 pipeline failed, falling back to V2 grounding:', v3Error?.message);
        product = null;
        v3Meta = null;
        // Fall through to existing PERF-001 grounding pipeline
      }
    }

    // 3) Build inline image parts for Gemini (compressed, base64) — skipped when V3 succeeded
    const MAX_IMAGES = 4;
    const MAX_EDGE = 1600;
    const JPEG_QUALITY = 78;
    const imageParts = [];
    if (!product) {
      for (const f of files.slice(0, MAX_IMAGES)) {
        if (!f?.buffer || !f?.mimetype?.startsWith('image/')) continue;
        try {
          const compressed = await sharp(f.buffer)
            .rotate()
            .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:2:0' })
            .toBuffer();
          imageParts.push({
            data: compressed.toString('base64'),
            mimeType: 'image/jpeg',
          });
        } catch {
          // Skip unprocessable image
        }
      }
    }

    const ocrText = (ocrPayload.textSnippets || []).filter(Boolean).join('\n');

    // 4) Try Google Search Grounding pipeline (preferred) — skip if V3 already produced a product
    if (!product && GROUNDING_ENABLED && (imageParts.length || mergedBarcodes.length)) {
      // Wall-clock guard: if there isn't enough budget left to plausibly complete grounding
      // AND still leave room for the legacy fallback, surface a 504 immediately rather than
      // letting the frontend AbortController fire mid-call (which leaves the user with a
      // generic "Timeout nach 3 Minuten" message).
      const MIN_GROUNDING_BUDGET_MS = 15000;
      if (remainingMs() < MIN_GROUNDING_BUDGET_MS) {
        console.warn(`[identify] Total budget exhausted (elapsed=${elapsedMs()}ms), skipping grounding pipeline`);
        return res.status(504).json({
          ok: false,
          error: {
            code: 'IDENTIFY_TOTAL_TIMEOUT',
            message: 'Produkterkennung dauerte zu lange. Bitte mit weniger oder kleineren Bildern erneut versuchen.',
            elapsedMs: elapsedMs(),
          },
        });
      }
      try {
        const { identifyProductWithGrounding } = require('../lib/gemini3-client');
        console.log(`[identify] Starting grounding pipeline (${imageParts.length} images, ${mergedBarcodes.length} barcodes, elapsed=${elapsedMs()}ms)`);

        const GROUNDING_TIMEOUT_MS = parseInt(process.env.GROUNDING_TIMEOUT_MS || '45000', 10);
        const groundingCap = Math.min(GROUNDING_TIMEOUT_MS, remainingMs());
        const groundingPromise = identifyProductWithGrounding({
          imageParts,
          ocrText,
          barcodes: mergedBarcodes,
          locale,
          hint,
        });
        Promise.resolve(groundingPromise).catch(() => {});
        const groundedRecord = await Promise.race([
          groundingPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Grounding timeout after ' + groundingCap + 'ms')), groundingCap)
          ),
        ]);

        // Map grounded record to product format
        const productId = crypto.randomUUID();
        product = {
          id: productId,
          identification: {
            name: groundedRecord.title_ebay || '',
            brand: groundedRecord.brand || 'unknown',
            category: groundedRecord.internalCategory || '',
            sku: groundedRecord.sku || '',
            barcodes: mergedBarcodes,
          },
          details: {
            categoryId: null,
            short_description: groundedRecord.description_ebay || '',
            key_features: Array.isArray(groundedRecord.key_features) ? groundedRecord.key_features : [],
            attributes: {},
            identifiers: {
              ean: groundedRecord.ean || '',
              gtin: groundedRecord.gtin || '',
              upc: groundedRecord.upc || '',
              mpn: groundedRecord.mpn || '',
            },
            images: uploadedImages.map((img) => ({
              url_or_base64: img.url,
              source: 'upload',
              variant: 'reference',
            })),
            pricing: {},
          },
          marketplace: {
            ebay: {
              title: groundedRecord.title_ebay || '',
              description: groundedRecord.description_ebay || '',
            },
            kaufland: {
              title: groundedRecord.title_kaufland || '',
              description: groundedRecord.description_kaufland || '',
            },
          },
          ops: {
            weight_grams: groundedRecord.weight_grams || null,
          },
          notes: {},
        };

        // Map item_specifics → attributes
        if (Array.isArray(groundedRecord.item_specifics)) {
          for (const spec of groundedRecord.item_specifics) {
            if (spec?.key && spec?.value) {
              product.details.attributes[spec.key] = String(spec.value).slice(0, 60);
            }
          }
        }

        // Map price
        if (groundedRecord.price_eur && groundedRecord.price_eur > 0) {
          product.details.pricing = {
            lowest_price: {
              amount: groundedRecord.price_eur,
              currency: 'EUR',
              sources: groundedRecord.price_source_url
                ? [{ url: groundedRecord.price_source_url, name: groundedRecord.price_source_name || 'web' }]
                : [],
              last_checked_iso: new Date().toISOString(),
            },
            price_confidence: 0.75,
          };
        }

        // SerpAPI image search moved to post-grounding parallel block (PERF-002)
        groundingImageQuery = [
          groundedRecord.brand,
          groundedRecord.model,
          groundedRecord.ean || groundedRecord.gtin,
        ].filter(Boolean).join(' ').trim();

        // Map GPSR (canonical location: details.gpsr; canonical field names per schema)
        if (groundedRecord.gpsr_manufacturer_name) {
          product.details = product.details || {};
          product.details.gpsr = {
            manufacturer_name: groundedRecord.gpsr_manufacturer_name || '',
            manufacturer_address: groundedRecord.gpsr_manufacturer_address || '',
            email: groundedRecord.gpsr_manufacturer_email || '',
            manufacturer_phone: groundedRecord.gpsr_manufacturer_phone || '',
            entity_country: groundedRecord.gpsr_manufacturer_country || '',
          };
        }

        // Grounding metadata
        if (groundedRecord._grounding) {
          product.ops.identify_grounding = groundedRecord._grounding;
        }
        if (groundedRecord.notes) {
          product.notes.identify_notes = groundedRecord.notes;
        }

        groundingUsed = true;
        pipelineUsed = 'grounding';
        console.log(`[identify] Grounding pipeline complete for ${productId}`);

        // Post-grounding duplicate check — NUR physische Barcodes (explizit +
        // OCR dieser Bilder). groundedRecord.ean/gtin/upc/sku sind
        // KI-Aufloesungen und TABU als Reuse-Trigger, siehe
        // physicalReuseBarcodes-Kommentar oben (Incident 2026-07-08).
        if (physicalReuseBarcodes.length) {
          const groundedExisting = await findProductByStrictIdentifier({
            barcodes: physicalReuseBarcodes,
            sku: null,
          });
          if (groundedExisting?.id) {
            console.log(`[identify] Post-grounding duplicate found: ${groundedExisting.id}`);
            try { await adjustPendingIntakeQuantity(groundedExisting.id, 1); } catch {}
            if (paletteCode) {
              try {
                const { PRODUCTS_COLLECTION } = require('../lib/firestore');
                await firestore.collection(PRODUCTS_COLLECTION).doc(groundedExisting.id).update({
                  'ops.sourcePalette': paletteCode,
                  'ops.sourcePaletteAt': new Date().toISOString(),
                });
              } catch {}
            }
            const refreshed = await getProduct(groundedExisting.id);
            metricDuplicateReused = true;
            return res.json({
              ok: true,
              data: refreshed || groundedExisting,
              meta: { reused_existing: true, paletteCode: paletteCode || null, locale, barcodes: physicalReuseBarcodes },
            });
          }
        }
      } catch (e) {
        console.warn('[identify] Grounding pipeline failed, falling back to legacy:', e?.message || e);
        product = null;
      }
    }

    // 5) Fallback: Legacy pipeline (if grounding failed or disabled)
    if (!product) {
      // Wall-clock guard before legacy: if grounding ate up the budget, fail fast with a
      // proper 504 rather than starting another long-running pipeline that will overrun
      // the frontend AbortController.
      const MIN_LEGACY_BUDGET_MS = 25000;
      if (remainingMs() < MIN_LEGACY_BUDGET_MS) {
        console.warn(`[identify] Total budget exhausted (elapsed=${elapsedMs()}ms), skipping legacy fallback`);
        return res.status(504).json({
          ok: false,
          error: {
            code: 'IDENTIFY_TOTAL_TIMEOUT',
            message: 'Produkterkennung dauerte zu lange. Bitte mit weniger oder kleineren Bildern erneut versuchen.',
            elapsedMs: elapsedMs(),
          },
        });
      }
      console.log(`[identify] Starting legacy pipeline (elapsed=${elapsedMs()}ms, remaining=${remainingMs()}ms)`);
      const result = await runSerpapiFreePipeline({ files, barcodes, locale, inventoryId, hint });
      legacyResult = result;
      pipelineUsed = 'legacy';

      // Re-check stock protection — NUR physische Barcodes (explizit + OCR
      // dieser Bilder). Legacy-Pipeline-Aufloesungen (barcodeInsights,
      // record.sku) sind KI-Ergebnisse und TABU als Reuse-Trigger, siehe
      // physicalReuseBarcodes-Kommentar oben (Incident 2026-07-08).
      const legacyExisting = physicalReuseBarcodes.length
        ? await findProductByStrictIdentifier({ barcodes: physicalReuseBarcodes, sku: null })
        : null;
      if (legacyExisting?.id) {
        try { await adjustPendingIntakeQuantity(legacyExisting.id, 1); } catch {}
        if (paletteCode) {
          try {
            const { PRODUCTS_COLLECTION } = require('../lib/firestore');
            await firestore.collection(PRODUCTS_COLLECTION).doc(legacyExisting.id).update({
              'ops.sourcePalette': paletteCode, 'ops.sourcePaletteAt': new Date().toISOString(),
            });
          } catch {}
        }
        const refreshed = await getProduct(legacyExisting.id);
        metricDuplicateReused = true;
        return res.json({
          ok: true, data: refreshed || legacyExisting,
          meta: { reused_existing: true, paletteCode: paletteCode || null, locale: result.locale, barcodes: result.barcodes },
        });
      }

      product = buildProductFromV2Record(result.record, {
        fallbackId: crypto.randomUUID(), barcodes, locale, inventoryId: inventoryId || null,
      });

      // Legacy post-processing (category + review + enrichments)
      // Category resolution is best-effort: never fail the identify if Gemini
      // or the eBay taxonomy API hiccups — a product without category can be
      // fixed later via Improve/Chat (see Line 719 warn-only check).
      try {
        await ensureCategories([product]);
      } catch (catErr) {
        console.warn('[identify] ensureCategories (legacy) failed:', catErr?.message || catErr);
      }
      product = applyEbayTaxonomy(product);
      product = applyKauflandTaxonomy(product);

      const evidence = {
        ocr: result.ocr || null, barcodes: result.barcodes || [],
        barcodeInsights: result.barcodeInsights || null, llm: result.llm || null,
      };

      try {
        // Parallel variant: 3 queries × up to 4 page fetches concurrently with
        // 8s per fetch instead of serial 25s. Cuts the legacy-pipeline web
        // evidence step from a worst-case ~5min to ~10s and is the single
        // biggest budget eater in the legacy fallback path.
        const webEnrich = await prefetchWebEvidenceParallel({
          barcodeList: result.barcodes || [],
          ocrTextSnippets: result?.ocr?.textSnippets || [],
          locale,
        });
        if (webEnrich) evidence.web_enrich = webEnrich;
      } catch {}

      await runDatasheetReview([product], {
        locale, webEvidence: evidence, marketplaceEvidence: true, llmScopeId: 'identify.v2',
      });

      try {
        await enrichPriceParallel(product, { force: false, reason: 'identify' });
      } catch {}
    }

    // 6) PERF-002: Post-processing (parallel where possible)
    if (pipelineUsed !== 'legacy') {
      // Category resolution + SerpAPI images + KTyp run in parallel (independent tasks).
      // allSettled ensures one task throwing (e.g. a sync error in applyTaxonomy slipping
      // past the inner try/catch) cannot abort the others or 500 the request.
      const postProcessingResults = await Promise.allSettled([
        // Category + Taxonomy (best-effort; must not fail the identify request)
        (async () => {
          try {
            await ensureCategories([product]);
          } catch (catErr) {
            console.warn('[identify] ensureCategories failed:', catErr?.message || catErr);
          }
          try {
            product = applyEbayTaxonomy(product);
            product = applyKauflandTaxonomy(product);
          } catch (taxErr) {
            console.warn('[identify] applyTaxonomy failed:', taxErr?.message || taxErr);
          }
        })(),
        // SerpAPI product images — skip for V3 (Stage 2 already fetched web images)
        (async () => {
          if (product.ops?.identify_pipeline === 'v3') return;
          if (!groundingImageQuery) return;
          try {
            const serpImages = await searchProductImages(product, {
              query: groundingImageQuery,
              limit: 3,
              minWidth: 400,
              minHeight: 400,
            });
            for (const img of serpImages) {
              product.details.images.push({
                url_or_base64: img.url,
                source: 'web_search',
                variant: 'marketing',
                notes: img.title || '',
              });
            }
          } catch (imgErr) {
            console.warn('[identify] SerpAPI image search failed:', imgErr?.message);
          }
        })(),
        // K-Typ enrichment
        (async () => {
          try {
            const { enrichKTypIfPossible } = require('../lib/ktype-enrichment');
            await enrichKTypIfPossible(product, { reason: 'identify' });
          } catch {}
        })(),
      ]);
      for (const r of postProcessingResults) {
        if (r.status === 'rejected') {
          console.warn('[identify] post-processing task rejected:', r.reason?.message || r.reason);
        }
      }
    } else {
      // Legacy path: KTyp only (categories already done above)
      try {
        const { enrichKTypIfPossible } = require('../lib/ktype-enrichment');
        await enrichKTypIfPossible(product, { reason: 'identify' });
      } catch {}
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

    // 3.9) eBay category check — warn but don't throw. Missing category can be resolved later.
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
      console.warn(
        `[identify] Product saved without valid eBay category (categoryId="${finalCategoryId || ''}") — can be resolved via Improve or Chat`
      );
      product.ops = product.ops || {};
      product.ops.missing_ebay_category = true;
    }

    // 4) Persist source palette reference if provided (Wareneingang tracking).
    if (paletteCode) {
      product.ops = product.ops || {};
      product.ops.sourcePalette = paletteCode;
      product.ops.sourcePaletteAt = new Date().toISOString();
    }

    // Wer hat erfasst? — dauerhaft am Produkt (Anzeige "Erfasst von", admin-only).
    // Nur beim ERSTEN Erfassen stempeln; eine Re-Identifikation überschreibt den
    // ursprünglichen Erfasser nicht.
    product.ops = product.ops || {};
    if (req.user?.uid && !product.ops.identified_by) {
      product.ops.identified_by = {
        uid: req.user.uid,
        email: req.user.email || null,
        name: req.user.name || req.user.displayName || null,
        at: new Date().toISOString(),
      };
    }

    // 4) Persist (SYSTEM mode => invariants enforced; never treated as manual UI edit).
    // allowCategoryChange: only for NEW products (no existing category yet).
    // Existing products with a category set by UI must not have it overwritten by Identify.
    const existingDoc = await getProduct(product.id);
    const existingHasCategory = Boolean(existingDoc?.details?.categoryId);
    await saveProductV2(product, {
      allowCategoryChange: !existingHasCategory,
      mode: 'system',
      source: 'identify',
      overwriteTextFields: true,
      replaceAttributes: true,
      syncIdentifiersFromBarcodes: true,
    });

    // Track "erfasst" for the Mitarbeiter-Leistung scoreboard (best-effort, non-blocking).
    try {
      const { logAudit } = require('../services/audit-log');
      await logAudit({
        action: 'product.identified',
        userId: req.user?.uid || null,
        tenantId: req.tenantId || req.user?.tenantId || 'default',
        details: { productId: product.id },
      });
    } catch (_) { /* Tracking darf den Erfassen-Flow nie brechen */ }

    const saved = await getProduct(product.id);
    return res.json({
      ok: true,
      data: saved || product,
      meta: {
        reused_existing: false,
        pipeline: pipelineUsed || (v3Meta ? 'v3' : (groundingUsed ? 'grounding' : 'legacy')),
        grounding: groundingUsed,
        locale: legacyResult?.locale || locale,
        barcodes: legacyResult?.barcodes || mergedBarcodes,
        ocr: legacyResult?.ocr || ocrPayload || null,
        llm: legacyResult?.llm || null,
        barcodeInsights: legacyResult?.barcodeInsights || null,
        quality: legacyResult?.quality || null,
        ebayReady: finalQuality ? Boolean(finalQuality.ok) : null,
        ebayReadyIssues: finalQuality ? finalQuality.issues || [] : [],
        ebayReadyIssuesDetailed: finalQuality ? finalQuality.issuesDetailed || [] : [],
        ebayReadySnapshot: finalQuality ? finalQuality.snapshot || null : null,
        v3: v3Meta ? {
          pipeline: v3Meta.pipeline,
          totalDurationMs: v3Meta.totalDurationMs,
          overallScore: v3Meta.confidence?.overallScore,
          fieldConfidence: v3Meta.confidence?.fieldConfidence,
          aspectCoverage: v3Meta.confidence?.requiredAspectsCoverage,
          marketplaceReadiness: v3Meta.confidence?.marketplaceReadiness,
        } : undefined,
        v4: v4Meta || undefined,
      },
    });
  } catch (error) {
    // logger.error (Pino → severity=ERROR) gets auto-picked up by Cloud Error Reporting.
    // Stack trace is required for grouping in the Error Reporting UI.
    logger.error(
      {
        err: error?.message,
        stack: error?.stack,
        route: 'POST /api/v2/identify',
      },
      'v2 identify failed',
    );
    const detailsRaw = error?.message || 'Unknown error';
    const details = String(detailsRaw).replace(/\s+/g, ' ').trim().slice(0, 400);
    metricErrorMessage = details;
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

// GET /api/health/external-apis — Aggregated usage stats for BrightData / SerpAPI
// and any other instrumented external HTTP service. Drives the operator decision
// "do we still need this service?" with hard numbers (calls/day, success rate, latency).
router.get('/health/external-apis', async (req, res) => {
  try {
    const windowHours = Math.max(1, Math.min(168, parseInt(req.query?.hours, 10) || 24));
    const service = typeof req.query?.service === 'string' && req.query.service.trim()
      ? req.query.service.trim()
      : null;
    const stats = await getExternalApiStats({
      service,
      windowMs: windowHours * 60 * 60 * 1000,
    });
    return res.json({ ok: true, data: stats });
  } catch (error) {
    logger.error(
      { err: error?.message, stack: error?.stack, route: 'GET /api/health/external-apis' },
      'external api stats aggregation failed',
    );
    return res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL', message: error?.message || 'Unknown error' },
    });
  }
});

// GET /api/health/identify — Aggregated identify pipeline health for the last 24h.
// Returns counts by status/pipeline/error, success rate, avg/p50/p95 durations, and the
// most recent failure. Used by the frontend dashboard tile and by ops for live triage.
// No auth on read — the data is operational, not sensitive (no product details, no PII).
router.get('/health/identify', async (req, res) => {
  try {
    const windowHours = Math.max(1, Math.min(168, parseInt(req.query?.hours, 10) || 24));
    const tenantId = typeof req.query?.tenantId === 'string' && req.query.tenantId.trim()
      ? req.query.tenantId.trim()
      : null;
    const health = await getIdentifyHealth({
      tenantId,
      windowMs: windowHours * 60 * 60 * 1000,
    });
    return res.json({ ok: true, data: health });
  } catch (error) {
    logger.error(
      { err: error?.message, stack: error?.stack, route: 'GET /api/health/identify' },
      'identify health aggregation failed',
    );
    return res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL', message: error?.message || 'Unknown error' },
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

// Pipeline override helper — parses optional `pipeline` param from body/query.
// Valid values: 'v3' | 'v2' | 'legacy' | 'auto'. Invalid values fall back to
// 'auto' (which defers to CHAT_V3 / CHAT_GROUNDING env flags).
const VALID_CHAT_PIPELINES = new Set(['v3', 'v2', 'legacy', 'auto']);
function normalizePipelineOverride(raw) {
  if (raw == null) return 'auto';
  const v = String(raw).trim().toLowerCase();
  return VALID_CHAT_PIPELINES.has(v) ? v : 'auto';
}

// Persist the pipeline tag on the chat session doc (best-effort, non-blocking).
// Separate write from appendMessages so we do not alter the shared lib signature.
async function tagSessionPipeline(sessionId, pipeline) {
  if (!sessionId || !pipeline) return;
  try {
    await firestore.collection('chatSessions').doc(sessionId).set(
      { pipeline, pipelineUpdatedAt: new Date().toISOString() },
      { merge: true },
    );
  } catch (err) {
    console.warn('[chat] Failed to tag session pipeline:', err.message);
  }
}

// POST /api/chat — Product chat via Gemini
// Supports ?stream=true for SSE streaming (progress events + final result)
// Pipeline cascade: V3 (CHAT_V3 / ?pipeline=v3) → V2 (CHAT_GROUNDING) → legacy.
// Each tier falls back to the next on error, preserving production resilience.
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

      // CHAT_GROUNDING: Use V2 pipeline (Google Search Grounding) with fallback to legacy
      const chatGrounding = (process.env.CHAT_GROUNDING || 'true').toString().trim().toLowerCase();
      const useChatV2 = chatGrounding === 'true' || chatGrounding === '1';

      // Pipeline override from request (body or query). 'auto' = follow env flags.
      const pipelineOverride = normalizePipelineOverride(
        req.body?.pipeline != null ? req.body.pipeline : req.query?.pipeline,
      );

      // Should V3 be attempted? Explicit 'v3' override OR ('auto' + CHAT_V3=true).
      const shouldTryV3 =
        pipelineOverride === 'v3' ||
        (pipelineOverride === 'auto' && chatV3Enabled());

      // V2 is attempted unless explicitly forced to 'legacy'.
      const allowV2 = pipelineOverride !== 'legacy';

      // V2 runs when env flag says so, OR when override explicitly requests 'v2'.
      const shouldTryV2 =
        pipelineOverride === 'v2' ||
        (allowV2 && useChatV2);

      const runV2V3AttachmentParts = Array.isArray(attachments) ? attachments : [];

      try {
        let chatResult = null;
        let pipelineUsed = 'legacy';
        const pipelineErrors = {};

        // ---- Attempt 1: V3 (context-circulation) ----
        if (shouldTryV3) {
          try {
            chatResult = await runProductChatV3({
              product,
              message: payloadMessage,
              history: conversationHistory,
              attachments: runV2V3AttachmentParts,
              onProgress,
              tenantId: req.user?.tenantId || null,
              userId,
              modelOverride,
            });
            pipelineUsed = 'v3';
          } catch (v3Error) {
            pipelineErrors.v3 = v3Error?.message || String(v3Error);
            console.warn('[chat] V3 failed, falling back to V2:', pipelineErrors.v3);
            try { onProgress({ type: 'tool_start', tool: 'fallback_v2', error: pipelineErrors.v3 }); } catch {}
          }
        }

        // ---- Attempt 2: V2 (Google Search Grounding) ----
        if (!chatResult && shouldTryV2) {
          try {
            chatResult = await runProductChatV2(product, payloadMessage, {
              modelOverride,
              attachments,
              scope: normalizedScope,
              history: conversationHistory,
              onProgress,
              tenantId: req.user?.tenantId || null,
            });
            pipelineUsed = 'v2';
          } catch (v2Error) {
            pipelineErrors.v2 = v2Error?.message || String(v2Error);
            console.warn('[chat] V2 grounding failed, falling back to legacy:', pipelineErrors.v2);
            console.error('[chat] V2 full error:', v2Error);
            try { onProgress({ type: 'tool_start', tool: 'fallback_legacy', error: pipelineErrors.v2 }); } catch {}
          }
        }

        // ---- Attempt 3: Legacy ----
        if (!chatResult && pipelineOverride !== 'v3' && pipelineOverride !== 'v2') {
          try {
            chatResult = await runProductChat(product, payloadMessage, {
              modelOverride,
              attachments,
              scope: normalizedScope,
              history: conversationHistory,
              onProgress,
            });
            pipelineUsed = 'legacy';
          } catch (legacyError) {
            pipelineErrors.legacy = legacyError?.message || String(legacyError);
            console.error('[chat] Legacy also failed:', pipelineErrors.legacy);
          }
        }

        if (!chatResult) {
          // All attempted pipelines failed (or explicit override blocked fallback).
          writeEvent({
            type: 'error',
            code: 'CHAT_ALL_PIPELINES_FAILED',
            message: 'V3, V2, and Legacy all failed',
            details: pipelineErrors,
          });
          return res.end();
        }

        // Enrich low-confidence flag for V3 results (others leave it undefined).
        if (chatResult.confidence && chatResult.confidence.readyForPublish === false) {
          chatResult.needsHumanReview = true;
          chatResult.lowConfidenceFields = chatResult.confidence.missingCritical || [];
        }
        chatResult.pipeline = pipelineUsed;

        console.log('[chat] pipeline=%s model=%s product=%s', pipelineUsed, chatResult.model || chatResult.modelUsed, productId);

        // Save messages to session (best-effort, non-blocking)
        appendMessages(sessionId, userId, productId, payloadMessage, chatResult.message || '').catch((e) => {
          console.warn('[chat] Failed to save session:', e.message);
        });
        tagSessionPipeline(sessionId, pipelineUsed);

        writeEvent({
          type: 'result',
          data: chatResult,
          model: chatResult.model || chatResult.modelUsed,
          pipeline: pipelineUsed,
        });
        writeEvent({ type: 'done' });
      } catch (error) {
        console.error('[chat stream] Error:', error.message);
        writeEvent({ type: 'error', message: String(error?.message || 'Unknown error').slice(0, 500) });
      }
      return res.end();
    }

    // Sync mode (default): await full result, respond with JSON
    const chatGroundingSync = (process.env.CHAT_GROUNDING || 'true').toString().trim().toLowerCase();
    const useChatV2Sync = chatGroundingSync === 'true' || chatGroundingSync === '1';

    const pipelineOverrideSync = normalizePipelineOverride(
      req.body?.pipeline != null ? req.body.pipeline : req.query?.pipeline,
    );
    const shouldTryV3Sync =
      pipelineOverrideSync === 'v3' ||
      (pipelineOverrideSync === 'auto' && chatV3Enabled());
    const allowV2Sync = pipelineOverrideSync !== 'legacy';
    const shouldTryV2Sync =
      pipelineOverrideSync === 'v2' ||
      (allowV2Sync && useChatV2Sync);

    let chatResult = null;
    let pipelineUsed = 'legacy';
    const pipelineErrors = {};

    // ---- Attempt 1: V3 ----
    if (shouldTryV3Sync) {
      try {
        chatResult = await runProductChatV3({
          product,
          message: payloadMessage,
          history: conversationHistory,
          attachments: Array.isArray(attachments) ? attachments : [],
          tenantId: req.user?.tenantId || null,
          userId,
          modelOverride,
        });
        pipelineUsed = 'v3';
      } catch (v3Error) {
        pipelineErrors.v3 = v3Error?.message || String(v3Error);
        console.warn('[chat] V3 failed (sync), falling back to V2:', pipelineErrors.v3);
      }
    }

    // ---- Attempt 2: V2 ----
    if (!chatResult && shouldTryV2Sync) {
      try {
        chatResult = await runProductChatV2(product, payloadMessage, {
          modelOverride,
          attachments,
          scope: normalizedScope,
          history: conversationHistory,
          tenantId: req.user?.tenantId || null,
        });
        pipelineUsed = 'v2';
      } catch (v2Error) {
        pipelineErrors.v2 = v2Error?.message || String(v2Error);
        console.warn('[chat] V2 grounding failed (sync), falling back to legacy:', pipelineErrors.v2);
      }
    }

    // ---- Attempt 3: Legacy ----
    if (!chatResult && pipelineOverrideSync !== 'v3' && pipelineOverrideSync !== 'v2') {
      try {
        chatResult = await runProductChat(product, payloadMessage, {
          modelOverride,
          attachments,
          scope: normalizedScope,
          history: conversationHistory,
        });
        pipelineUsed = 'legacy';
      } catch (legacyError) {
        pipelineErrors.legacy = legacyError?.message || String(legacyError);
        console.error('[chat] Legacy also failed (sync):', pipelineErrors.legacy);
      }
    }

    if (!chatResult) {
      return res.status(500).json({
        ok: false,
        error: {
          code: 'CHAT_ALL_PIPELINES_FAILED',
          message: 'V3, V2, and Legacy all failed',
          details: pipelineErrors,
        },
      });
    }

    // Enrich low-confidence flags (V3-only fields; V2/legacy leave undefined).
    if (chatResult.confidence && chatResult.confidence.readyForPublish === false) {
      chatResult.needsHumanReview = true;
      chatResult.lowConfidenceFields = chatResult.confidence.missingCritical || [];
    }
    chatResult.pipeline = pipelineUsed;

    console.log('[chat] pipeline=%s model=%s product=%s', pipelineUsed, chatResult.model || chatResult.modelUsed, productId);

    // Save messages to session (best-effort, non-blocking)
    appendMessages(sessionId, userId, productId, payloadMessage, chatResult.message || '').catch((e) => {
      console.warn('[chat] Failed to save session:', e.message);
    });
    tagSessionPipeline(sessionId, pipelineUsed);

    res.json({
      ok: true,
      model: chatResult.model || chatResult.modelUsed,
      pipeline: pipelineUsed,
      data: chatResult,
    });

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
      console.error(`[group-images] Structured grouping THREW for ${files.length} images:`, err.message, err.stack?.split('\n').slice(0, 3).join(' | '));

      // Tier 1: local perceptual-hash (aHash) clustering. Avoids dumping every
      // image into its own 30%-confidence group when Gemini is unavailable but
      // images still share strong visual similarity (same product, different
      // angles/lighting).
      try {
        const { clusterImagesByPerceptualHash, clustersToGroups } = require('../lib/image-grouping-fallback');
        const clusters = await clusterImagesByPerceptualHash(imageBuffers, { maxDistance: 10 });
        if (clusters && clusters.length > 0) {
          groups = clustersToGroups(clusters);
          console.warn(`[group-images] Gemini failed; local aHash fallback produced ${groups.length} group(s) from ${files.length} images`);
        }
      } catch (fallbackErr) {
        console.error('[group-images] Local aHash fallback also failed:', fallbackErr.message);
      }

      // Tier 2: last-resort 1-group-per-image with low confidence so the user
      // can merge manually. Triggered when sharp is missing or the aHash
      // fallback otherwise produced no clusters.
      if (!groups.length) {
        groups = Array.from({ length: files.length }, (_, i) => ({
          id: `group_${i}`,
          label: `Produkt ${i + 1}`,
          image_indices: [i],
          confidence: 0.3,
          reason: 'KI-Gruppierung fehlgeschlagen — bitte manuell prüfen',
          detected_barcode: null,
        }));
      }
    }

    // Ensure every image is in at least one group
    const allIndices = new Set();
    groups.forEach((g) => g.image_indices.forEach((i) => allIndices.add(i)));
    const orphaned = [];
    for (let i = 0; i < files.length; i++) {
      if (!allIndices.has(i)) orphaned.push(i);
    }
    if (orphaned.length && groups.length) {
      // Add orphaned images as individual groups instead of dumping into first group
      for (const i of orphaned) {
        groups.push({
          id: `group_${groups.length}`,
          label: `Produkt ${groups.length + 1}`,
          image_indices: [i],
          confidence: 0.3,
          reason: 'Bild war keiner Gruppe zugeordnet',
          detected_barcode: null,
        });
      }
    }

    // Last-resort fallback: if still truly empty (shouldn't happen with above fixes)
    if (!groups.length) {
      console.error(`[group-images] CRITICAL: No groups at all for ${files.length} images — individual fallback`);
      groups = Array.from({ length: files.length }, (_, i) => ({
        id: `group_${i}`,
        label: `Produkt ${i + 1}`,
        image_indices: [i],
        confidence: 0.3,
        reason: 'Fallback — bitte manuell gruppieren',
        detected_barcode: null,
      }));
    }

    res.json({ ok: true, data: { groups, imageCount: files.length } });
  } catch (err) {
    console.error(`[POST /api/v2/group-images] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'GROUPING_FAILED', message: err.message } });
  }
});

module.exports = router;
