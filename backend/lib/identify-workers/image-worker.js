'use strict';

/**
 * image-worker.js — Identify-V4 Worker for image aggregation + enhancement.
 *
 * Sammelt Bilder aus: Stage-1 Uploads, Grounding-Web-Bilder, Hersteller-Site
 * (via atomic-tool). Analysiert Qualität (image-quality), enhanced top-3 via
 * Gemini-Image-Preview (BG-Removal + Upscaling, best-effort), klassifiziert
 * Angles, und ranked via image-enhance.rankImages.
 *
 * Sequential processing (nicht parallel) wegen Memory-Constraints auf Cloud Run.
 */

const atomicTools = require('../../services/atomic-tools');
const { analyzeImage } = require('../image-quality');
const {
  upscaleImage,
  removeBackground,
  classifyImageAngle,
  rankImages,
} = require('../image-enhance');

const DOMAIN = 'image';
const MAX_IMAGES_PROCESSED = 3;
const MAX_IMAGES_FINAL = 12;

function isTruthy(envValue, defaultTrue = true) {
  if (envValue == null) return defaultTrue;
  const v = String(envValue).toLowerCase();
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return true;
}

function safeString(v) {
  return v == null ? '' : String(v).trim();
}

async function runImageWorker(context = {}) {
  const started = Date.now();
  const meta = {
    durationMs: 0,
    toolsCalled: [],
    geminiCalls: 0,
    enhancedCount: 0,
    upscaledCount: 0,
    error: null,
  };
  const sources = [];

  const doEnhance = isTruthy(process.env.IDENTIFY_V4_IMAGE_ENHANCE, true);
  const doClassify = isTruthy(process.env.IDENTIFY_V4_IMAGE_ANGLE_CLASSIFY, true);

  try {
    if (!context || typeof context !== 'object') {
      meta.durationMs = Date.now() - started;
      meta.error = 'context_missing';
      return {
        ok: false,
        domain: DOMAIN,
        resolved: { images: [], top_image_url: null, meetsRecommendedCount: 0 },
        confidence: { images: 0 },
        sources,
        retriesRequested: [],
        meta,
      };
    }

    const images = [];

    // 1. Upload-Buffers aus context.files
    const files = Array.isArray(context.files) ? context.files : [];
    for (const f of files) {
      const buf = f?.buffer || f;
      if (Buffer.isBuffer(buf)) {
        images.push({ buffer: buf, source: 'upload' });
      }
    }

    // 2. Web-URLs aus Stage 1 grounding (identity.web_image_urls)
    const webUrls = Array.isArray(context.identity?.web_image_urls)
      ? context.identity.web_image_urls
      : [];
    for (const url of webUrls.slice(0, 8)) {
      if (typeof url === 'string' && url.startsWith('http')) {
        images.push({ url, source: 'web' });
      }
    }

    // 3. Hersteller-Site via atomic tool (best-effort, async)
    const brand = safeString(
      context.workerResults?.identity?.resolved?.brand ||
        context.identity?.brand ||
        context.product?.identification?.brand
    );
    const model = safeString(
      context.workerResults?.identity?.resolved?.model || context.identity?.model
    );
    if (brand && atomicTools?.executors?.executeSearchManufacturerSite) {
      try {
        meta.toolsCalled.push('search_manufacturer_site');
        const r = await atomicTools.executors.executeSearchManufacturerSite({
          brand,
          model,
          mpn: context.workerResults?.identity?.resolved?.mpn,
        });
        if (r?.ok && Array.isArray(r.data?.images)) {
          for (const u of r.data.images.slice(0, 3)) {
            if (typeof u === 'string' && u.startsWith('http')) {
              images.push({ url: u, source: 'manufacturer' });
            }
          }
        }
      } catch {
        // non-blocking
      }
    }

    // Analyse + Dedup via aHash
    const seenHashes = new Set();
    const analyzed = [];
    for (const img of images) {
      let analysis = null;
      if (img.buffer) {
        try {
          analysis = await analyzeImage(img.buffer, { computeHash: true });
        } catch {
          analysis = null;
        }
        if (analysis?.hash && seenHashes.has(analysis.hash)) continue;
        if (analysis?.hash) seenHashes.add(analysis.hash);
      }
      analyzed.push({
        buffer: img.buffer || null,
        url: img.url || null,
        source: img.source,
        quality: analysis?.qualityScore || 0,
        width: analysis?.width || 0,
        height: analysis?.height || 0,
        meetsRecommendedResolution: analysis?.meetsRecommendedResolution || false,
        meetsMinResolution: analysis?.meetsMinResolution || false,
        backgroundType: analysis?.backgroundType || 'unknown',
        angle: 'unknown',
        processed: false,
      });
    }

    // Enhancement (sequential, top-3 by quality)
    const sortedForEnhance = [...analyzed]
      .filter((i) => i.buffer)
      .sort((a, b) => b.quality - a.quality)
      .slice(0, MAX_IMAGES_PROCESSED);

    const aiClient = context.aiClient || null;

    for (const img of sortedForEnhance) {
      if (!doEnhance) break;
      try {
        if (aiClient) {
          const bg = await removeBackground(img.buffer, { geminiClient: aiClient });
          if (bg.modified) {
            img.buffer = bg.buffer;
            img.processed = true;
            meta.enhancedCount++;
            meta.geminiCalls++;
          }
        }
        // Upscale if needed
        const up = await upscaleImage(img.buffer, { targetEdge: 1600 });
        if (up.upscaled) {
          img.buffer = up.buffer;
          img.width = up.width;
          img.height = up.height;
          img.meetsRecommendedResolution = true;
          meta.upscaledCount++;
        }
      } catch {
        // best-effort
      }

      // Angle classification
      if (doClassify && aiClient && img.buffer) {
        try {
          const part = {
            inlineData: {
              data: img.buffer.toString('base64'),
              mimeType: 'image/jpeg',
            },
          };
          const cls = await classifyImageAngle(part, { geminiClient: aiClient });
          img.angle = cls.angle;
          meta.geminiCalls++;
        } catch {
          // best-effort
        }
      }
    }

    const ranked = rankImages(analyzed).slice(0, MAX_IMAGES_FINAL);
    const meetsRecommendedCount = ranked.filter(
      (i) => i.meetsRecommendedResolution
    ).length;

    let confidence = 0.2;
    if (meetsRecommendedCount >= 3) confidence = 0.95;
    else if (meetsRecommendedCount >= 1) confidence = 0.75;
    else if (ranked.some((i) => i.meetsMinResolution)) confidence = 0.5;

    const topImageUrl = ranked[0]?.url || null;

    meta.durationMs = Date.now() - started;

    return {
      ok: ranked.length > 0,
      domain: DOMAIN,
      resolved: {
        images: ranked.map((i) => ({
          url: i.url,
          source: i.source,
          angle: i.angle,
          quality: i.quality,
          width: i.width,
          height: i.height,
          processed: i.processed,
        })),
        top_image_url: topImageUrl,
        meetsRecommendedCount,
      },
      confidence: { images: confidence },
      sources,
      retriesRequested: [],
      meta,
    };
  } catch (err) {
    meta.durationMs = Date.now() - started;
    meta.error = err.message || String(err);
    return {
      ok: false,
      domain: DOMAIN,
      resolved: { images: [], top_image_url: null, meetsRecommendedCount: 0 },
      confidence: { images: 0 },
      sources,
      retriesRequested: [],
      meta,
    };
  }
}

module.exports = { runImageWorker, DOMAIN };
