'use strict';

function normalized(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function capturePageMatchesIdentity({ page, product }) {
  const body = ` ${normalized(`${page.text || ''} ${page.html || ''}`)} `;
  const ids = product.details?.identifiers || {};
  const placeholder = /^(nicht zutreffend|unbekannt|unknown|n a|keine|markenlos)$/;
  const identifiers = [ids.ean, ids.gtin, ids.upc, ids.mpn].map(normalized)
    .filter(value => value.length >= 4 && !placeholder.test(value));
  // A known EAN/MPN must actually appear on the page. The model's own
  // matched_by label or a matching brand alone is not an identity proof.
  if (identifiers.length) return identifiers.some(value => body.includes(` ${value} `));
  const brand = normalized(product.identification?.brand);
  const stop = new Set(['mit', 'fuer', 'ohne', 'und', 'neu', 'new', 'unbekannt', 'markenlos']);
  const words = [...new Set(normalized(product.identification?.name).split(' '))]
    .filter(word => word.length >= 4 && !stop.has(word) && word !== brand);
  return words.length >= 2 && words.filter(word => body.includes(` ${word} `)).length >= Math.max(2, Math.ceil(words.length * 0.6));
}

// Capture has one bounded research pass. The generic refresh waterfall can
// take several minutes and repeat Browse/Web/Gemini through nested fallbacks.
// Keep successful sources even if another source never finishes; return data,
// never mutate a product or schedule a post-response product write.
async function lookupCapturePrice(product, { budgetMs = 45000 } = {}) {
  const { findEbayBrowsePriceForProductV1 } = require('./price-enrichment');
  const { lookupPricesViaGemini } = require('./gemini-price-lookup');
  const { classifyPriceSourceUrl, verifyPriceSources } = require('./price-evidence');
  const { search } = require('./evidence-provider');
  const deadline = Date.now() + budgetMs;
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
  const referencePagesTask = (async () => {
    let searchTimer;
    try {
      const mpn = product.details?.identifiers?.mpn;
      const query = [product.identification?.brand, product.details?.attributes?.Modell || product.identification?.name, mpn, 'kaufen site:.de'].filter(Boolean).join(' ');
      const result = await Promise.race([
        search(query, { limit: 6, locale: 'de-DE' }),
        new Promise(resolve => { searchTimer = setTimeout(() => resolve(null), Math.min(4000, budgetMs)); }),
      ]);
      return (result?.results || []).filter(row => classifyPriceSourceUrl(row.url).kind === 'candidate').slice(0, 6);
    } catch { return []; }
    finally { clearTimeout(searchTimer); }
  })();
  const browseTask = collect(async () => {
    const result = await findEbayBrowsePriceForProductV1(product);
    if (!result?.ok || !(result.amount > 0) || !result.sources?.length) return null;
    return { amount: result.amount, currency: 'EUR', sources: result.sources, confidence: 0.7, via: 'ebay_browse' };
  });
  const webTask = collect(async () => {
    const referencePages = await referencePagesTask;
    if (closed || Date.now() >= deadline) return null;
    const { lookupCaptureWebPrice } = require('./capture-web-price');
    return lookupCaptureWebPrice(product, { referencePages, deadline, matchesIdentity: capturePageMatchesIdentity });
  });
  const groundingTask = collect(async () => {
    let graceTimer;
    try {
      await Promise.race([
        firstPrice,
        Promise.all([browseTask, webTask]),
        new Promise(resolve => { graceTimer = setTimeout(resolve, Math.min(4000, budgetMs)); }),
      ]);
    } finally { clearTimeout(graceTimer); }
    if (completed.length || closed || Date.now() >= deadline) return null;
    const referencePages = await referencePagesTask;
    if (closed || Date.now() >= deadline) return null;
    const offers = await lookupPricesViaGemini(product, { timeoutMs: Math.max(1, deadline - Date.now()), deadline, tenantId: product.tenantId, referencePages });
    if (closed || Date.now() >= deadline) return null;
    const sources = (offers || []).filter(offer =>
      Number.isFinite(offer.amount) && offer.amount > 0 && offer.currency === 'EUR' &&
      classifyPriceSourceUrl(offer.url).kind === 'candidate'
    ).slice(0, 3).map(offer => ({ name: offer.source || 'Web', url: offer.url, price: offer.amount }));
    if (!sources.length) return null;
    const { verified } = await verifyPriceSources({
      sources, product, maxPages: 3, timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())),
      matchPage: capturePageMatchesIdentity,
    });
    if (!verified.length) return null;
    const amounts = verified.map(source => source.price).sort((a, b) => a - b);
    const mid = Math.floor(amounts.length / 2);
    const amount = amounts.length % 2 ? amounts[mid] : (amounts[mid - 1] + amounts[mid]) / 2;
    return { amount: Math.round(amount * 100) / 100, currency: 'EUR', sources: verified, confidence: 0.8, via: 'gemini_grounding' };
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
  return completed.sort((a, b) => b.confidence - a.confidence)[0] || null;
}

module.exports = { lookupCapturePrice, capturePageMatchesIdentity };
