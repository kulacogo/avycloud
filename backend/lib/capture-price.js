'use strict';

function normalized(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const PLACEHOLDER = /^(nicht zutreffend|unbekannt|unknown|n a|keine|markenlos)$/;
function usable(value) {
  const text = String(value || '').trim();
  return text && !PLACEHOLDER.test(normalized(text)) ? text : '';
}

function buildCapturePriceQueries(product) {
  const ids = product.details?.identifiers || {};
  const attrs = product.details?.attributes || {};
  const brand = usable(product.identification?.brand);
  const gtin = [ids.ean, ids.gtin, ids.upc].map(usable).find(value => /^\d{8,14}$/.test(value));
  const mpn = usable(ids.mpn);
  const model = usable(attrs.Modell) || usable(product.identification?.name);
  const label = normalized(model).startsWith(`${normalized(brand)} `) ? model : [brand, model].filter(Boolean).join(' ');
  const type = usable(attrs.Produktart) || usable(product.identification?.category?.split('>').at(-1));
  const descriptive = [label, type && !normalized(label).includes(normalized(type)) ? type : '', usable(attrs.Größe), usable(attrs.Farbe)].filter(Boolean).join(' ');
  // Separate exact-code discovery from the descriptive fallback. Requiring
  // every label token in one query hides otherwise valid retailer pages.
  return [...new Set([gtin || (mpn && [brand, mpn].filter(Boolean).join(' ')), descriptive].filter(Boolean))].slice(0, 2);
}

function capturePageMatchesIdentity({ page, product }) {
  const body = ` ${normalized(`${page.text || ''} ${page.html || ''}`)} `;
  const ids = product.details?.identifiers || {};
  const brand = normalized(usable(product.identification?.brand));
  const brandHit = brand && body.includes(` ${brand} `);
  const codes = [ids.ean, ids.gtin, ids.upc].map(normalized).filter(value => /^\d{8,14}$/.test(value));
  const mpn = normalized(usable(ids.mpn));
  // A known EAN/MPN must actually appear on the page. The model's own
  // matched_by label or a matching brand alone is not an identity proof.
  const codeHit = value => {
    const parts = value.replace(/ /g, '').split('');
    // IKEA's 805.657.16 and 80565716 are the same article number. Keep
    // boundaries so 805657160 can never match the shorter identifier.
    return new RegExp(`(?:^| )${parts.join(' ?')}(?: |$)`).test(body);
  };
  if (codes.some(codeHit)) return true;
  // Manufacturer part numbers are not globally unique. BLK008, for example,
  // identifies both an OMERAI blanket and an unrelated expensive suit.
  if (mpn.length >= 4 && brand && brandHit && codeHit(mpn)) return true;
  // A retailer may omit the manufacturer's identifiers. Allow a distinctive
  // model only inside that Product's own structured data, with matching brand
  // and every known size/color. Never infer this from a page-wide mention in
  // a recommendation card; explicit conflicting identifiers remain a veto.
  if (page.identity && brandHit) {
    const node = page.identity;
    const nodeCodes = [node.gtin, node.gtin8, node.gtin12, node.gtin13, node.gtin14].filter(Boolean).map(normalized);
    const nodeMpn = normalized(node.mpn);
    const conflictingCode = codes.length && nodeCodes.length && !nodeCodes.some(value => codes.includes(value));
    const conflictingMpn = mpn && nodeMpn && mpn.replace(/ /g, '') !== nodeMpn.replace(/ /g, '');
    const attrs = product.details?.attributes || {};
    const common = new Set(['universal', 'premium', 'standard', 'classic', 'starter', 'home', 'modell', 'model', 'set']);
    const modelWords = normalized(attrs.Modell).split(' ').filter(word => word && !brand.split(' ').includes(word) && !common.has(word));
    const distinctive = modelWords.some(word => /[a-z]/.test(word) && /\d/.test(word)) || modelWords.some(word => word.length >= 7) || modelWords.filter(word => word.length >= 4).length >= 2;
    const modelMatches = distinctive && modelWords.every(word => body.includes(` ${word} `));
    const size = normalized(usable(attrs.Größe)).replace(/ /g, '');
    const sizeMatches = !size || normalized(body).replace(/ /g, '').includes(size);
    const color = normalized(usable(attrs.Farbe));
    const colors = { weiss: ['weiss','white'], schwarz:['schwarz','black'], grau:['grau','grey','gray'], blau:['blau','blue'], grun:['grun','green'], rot:['rot','red'] };
    const colorMatches = !color || (colors[color] || [color]).some(value => body.includes(` ${value} `));
    if (!conflictingCode && !conflictingMpn && modelMatches && sizeMatches && colorMatches) return true;
  }
  if (codes.length || mpn.length >= 4) return false;
  const stop = new Set(['mit', 'fuer', 'ohne', 'und', 'neu', 'new', 'unbekannt', 'markenlos']);
  const words = [...new Set(normalized(product.identification?.name).split(' '))]
    .filter(word => word.length >= 4 && !stop.has(word) && word !== brand);
  const minWords = brand ? 2 : 4;
  return (!brand || brandHit) && words.length >= minWords && words.filter(word => body.includes(` ${word} `)).length >= Math.max(minWords, Math.ceil(words.length * 0.6));
}

// Capture has one bounded research pass. The generic refresh waterfall can
// take several minutes and repeat Browse/Web/Gemini through nested fallbacks.
// Keep successful sources even if another source never finishes; return data,
// never mutate a product or schedule a post-response product write.
async function lookupCapturePrice(product, { budgetMs = 45000, diagnostics = {} } = {}) {
  const { findEbayBrowsePriceForProductV1 } = require('./price-enrichment');
  const { lookupPricesViaGemini } = require('./gemini-price-lookup');
  const { classifyPriceSourceUrl } = require('./price-evidence');
  const { search } = require('./evidence-provider');
  const deadline = Date.now() + budgetMs;
  Object.assign(diagnostics, { version: 3, searches: 0, search_results: 0, search_timeouts: 0, pages: 0, grounding_started: false, grounding_offers: 0 });
  const completed = [];
  let closed = false;
  let notifyPrice;
  const firstPrice = new Promise(resolve => { notifyPrice = resolve; });
  const collect = async (work) => {
    try {
      const result = await work();
      if (!closed && result) {
        completed.push(result);
        notifyPrice();
      }
    } catch { /* A failed source must not discard another source's price. */ }
  };
  // One bounded search is shared by deterministic page reading and the
  // grounded fallback; it is never repeated for every marketplace.
  const queries = buildCapturePriceQueries(product);
  const searchPages = async query => {
    let searchTimer;
    try {
      if (!query || closed || Date.now() >= deadline) return [];
      diagnostics.searches++;
      const result = await Promise.race([
        search(`${query} kaufen`, { limit: 6, locale: 'de-DE' }),
        new Promise(resolve => { searchTimer = setTimeout(() => resolve(null), Math.max(1, Math.min(8000, deadline - Date.now()))); }),
      ]);
      if (closed || Date.now() >= deadline) return [];
      if (!result) diagnostics.search_timeouts++;
      diagnostics.search_results += result?.results?.length || 0;
      return (result?.results || []).filter(row => classifyPriceSourceUrl(row.url).kind === 'candidate').slice(0, 6);
    } catch { return []; }
    finally { clearTimeout(searchTimer); }
  };
  const referencePagesTask = searchPages(queries[0]);
  const browseTask = collect(async () => {
    const result = await findEbayBrowsePriceForProductV1(product, { capture: true });
    if (!closed) diagnostics.browse_result = result?.ok ? 'found' : result?.reason || 'empty';
    if (!result?.ok || !(result.amount > 0) || !result.sources?.length) return null;
    return { amount: result.amount, currency: 'EUR', sources: result.sources, confidence: 0.7, via: 'ebay_browse' };
  });
  const webTask = collect(async () => {
    const referencePages = await referencePagesTask;
    if (closed || Date.now() >= deadline) return null;
    const { lookupCaptureWebPrice } = require('./capture-web-price');
    const result = await lookupCaptureWebPrice(product, { referencePages, deadline, matchesIdentity: capturePageMatchesIdentity, diagnostics });
    if (result || completed.length || closed || deadline - Date.now() < 6000 || !queries[1]) return result;
    const fallbackPages = await searchPages(queries[1]);
    return lookupCaptureWebPrice(product, { referencePages: fallbackPages, deadline, matchesIdentity: capturePageMatchesIdentity, diagnostics });
  });
  const groundingTask = collect(async () => {
    let graceTimer;
    try {
      await Promise.race([
        firstPrice,
        Promise.all([browseTask, webTask]),
        new Promise(resolve => { graceTimer = setTimeout(resolve, Math.min(8000, budgetMs)); }),
      ]);
    } finally { clearTimeout(graceTimer); }
    if (completed.length || closed || Date.now() >= deadline) return null;
    const referencePages = await referencePagesTask;
    if (closed || Date.now() >= deadline) return null;
    // Leave time to verify returned offers; consuming the entire deadline in
    // generation made a successful lookup unusable at the verification step.
    diagnostics.grounding_started = true;
    const groundingDeadline = deadline - Math.min(5000, budgetMs * 0.2);
    const offers = await lookupPricesViaGemini(product, { timeoutMs: Math.max(1, groundingDeadline - Date.now()), deadline: groundingDeadline, tenantId: product.tenantId, referencePages });
    if (closed || Date.now() >= deadline) return null;
    diagnostics.grounding_offers = offers?.length || 0;
    const sources = (offers || []).filter(offer =>
      Number.isFinite(offer.amount) && offer.amount > 0 && offer.currency === 'EUR' &&
      classifyPriceSourceUrl(offer.url).kind === 'candidate'
    ).slice(0, 3).map(offer => ({ name: offer.source || 'Web', url: offer.url, price: offer.amount }));
    if (!sources.length) return null;
    const { lookupCaptureWebPrice } = require('./capture-web-price');
    // The model discovers URLs; the same deterministic parser verifies the
    // actual current offer, quantity and German storefront as the web path.
    const verified = await lookupCaptureWebPrice(product, {
      referencePages: sources, deadline, matchesIdentity: capturePageMatchesIdentity, diagnostics,
    });
    return verified ? { ...verified, via: 'gemini_grounding' } : null;
  });
  const jobs = [browseTask, webTask, groundingTask];
  let timer;
  try {
    await Promise.race([
      Promise.all(jobs),
      new Promise(resolve => { timer = setTimeout(resolve, budgetMs); }),
    ]);
  } finally {
    closed = true;
    clearTimeout(timer);
  }
  const result = completed.sort((a, b) => b.confidence - a.confidence)[0] || null;
  diagnostics.duration_ms = budgetMs - Math.max(0, deadline - Date.now());
  diagnostics.deadline_reached = Date.now() >= deadline;
  diagnostics.result = result?.via || 'no_verified_offer';
  return result;
}

module.exports = { lookupCapturePrice, capturePageMatchesIdentity, buildCapturePriceQueries };
