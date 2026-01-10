
import {
  Product,
  ProductBundle,
  DatasheetChange,
  ImageSuggestionGroup,
  SerpInsight,
  WarehouseLayout,
  WarehouseBin,
  IdentifyPhase,
  Order,
  ProductImage,
  IdentificationJob,
  ProductEnrichmentRecord,
  InventoryRecord,
  EbayCategoryOption,
  DashboardMetrics,
} from '../types';

// Backend URL configuration - single source of truth
// Use import.meta.env for Vite compatibility
const BACKEND_URL = (() => {
  const envUrl = import.meta.env.VITE_BACKEND_URL;

  // In development, require explicit configuration
  if (import.meta.env.DEV) {
    if (!envUrl) {
      // Allow explicit opt-in to production
      if (import.meta.env.VITE_USE_PRODUCTION_BACKEND === 'true') {
        console.warn('⚠️ WARNING: Explicitly using production backend in development mode.');
        return 'https://product-hub-backend-79205549235.europe-west3.run.app';
      }

      console.error('❌ BACKEND_URL not configured! Set VITE_BACKEND_URL in .env.local');
      console.error('   Example: VITE_BACKEND_URL=http://localhost:8080');
      console.error('   Or set VITE_USE_PRODUCTION_BACKEND=true to use production (dangerous!)');

      // Default to localhost to prevent accidental production writes
      return 'http://localhost:8080';
    }
    return envUrl;
  }

  // In production, use env or default to production URL
  return envUrl || 'https://product-hub-backend-79205549235.europe-west3.run.app';
})();

const JOB_POLL_INTERVAL_MS = 2000;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
interface FetchIdentificationJobsParams {
  statuses?: string[];
  limit?: number;
  cursor?: string | null;
  order?: 'asc' | 'desc';
  signal?: AbortSignal;
}

interface IdentificationJobsResponse {
  jobs: IdentificationJob[];
  nextCursor: string | null;
  hasMore: boolean;
  stats: Record<string, number>;
  filters: {
    statuses: string[];
    limit: number;
    order: 'asc' | 'desc';
  };
}

export const buildImageProxyUrl = (sourceUrl?: string | null) => {
  if (!sourceUrl) return '';
  if (!/^https?:\/\//i.test(sourceUrl)) {
    return sourceUrl;
  }
  try {
    const proxy = new URL(`${BACKEND_URL}/api/image-proxy`);
    proxy.searchParams.set('url', sourceUrl);
    return proxy.toString();
  } catch (error) {
    console.warn('Failed to build image proxy url', error);
    return sourceUrl;
  }
};

interface IdentifyApiOptions {
  model?: string;
  signal?: AbortSignal;
  onStatus?: (phase: IdentifyPhase) => void;
  inventoryId?: string;
}

const createStatusReporter = (listener?: (phase: IdentifyPhase) => void) => {
  let lastPhase: IdentifyPhase | null = null;
  return (phase: IdentifyPhase) => {
    if (!listener || lastPhase === phase) return;
    lastPhase = phase;
    listener(phase);
  };
};

// Helper function to safely parse JSON responses
const parseResponse = async (response: Response): Promise<any> => {
  const contentType = response.headers.get('content-type');
  const contentLength = response.headers.get('content-length');

  // Check for empty response (204, empty body)
  if (response.status === 204) {
    return { ok: true };
  }

  // Try to read the response text first
  const text = await response.text();

  // Check if body is actually empty
  if (!text || text.trim() === '') {
    return { ok: true };
  }

  // Only parse as JSON if content-type indicates JSON
  if (contentType && contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch (e) {
      console.error('Failed to parse JSON:', text.substring(0, 200));
      throw new Error('Invalid JSON response');
    }
  }

  // For non-JSON responses, check if it looks like an error page
  if (contentType && contentType.includes('text/html')) {
    throw new Error(`Server returned HTML instead of JSON. Status: ${response.status}`);
  }

  // Otherwise return the text content wrapped
  return { ok: response.ok, data: text };
};

// Defensive normalizer: backend/Firestore data may omit nested objects.
// Keep UI stable by ensuring required sub-structures exist.
const normalizeProduct = (raw: any): Product => {
  const input = raw && typeof raw === 'object' ? raw : {};
  const id = input.id != null ? String(input.id) : '';

  const identificationIn = input.identification && typeof input.identification === 'object' ? input.identification : {};
  const detailsIn = input.details && typeof input.details === 'object' ? input.details : {};
  const opsIn = input.ops && typeof input.ops === 'object' ? input.ops : {};

  const identifiersIn =
    detailsIn.identifiers && typeof detailsIn.identifiers === 'object' ? detailsIn.identifiers : {};

  const pricingIn = detailsIn.pricing && typeof detailsIn.pricing === 'object' ? detailsIn.pricing : {};
  const lowestPriceIn =
    pricingIn.lowest_price && typeof pricingIn.lowest_price === 'object' ? pricingIn.lowest_price : {};

  const imagesIn = Array.isArray(detailsIn.images) ? detailsIn.images : [];
  const images: ProductImage[] = imagesIn
    .filter(Boolean)
    .map((img: any) => ({
      ...(img && typeof img === 'object' ? img : {}),
      // Some legacy paths store url/href instead of url_or_base64; preserve by mapping.
      url_or_base64: img?.url_or_base64 || img?.url || img?.href || '',
      source: (img?.source as any) || 'web',
    }))
    .filter((img) => Boolean(img.url_or_base64));

  return {
    ...input,
    id,
    identification: {
      ...(identificationIn as any),
      method: (identificationIn.method as any) || 'image',
      barcodes: Array.isArray(identificationIn.barcodes) ? identificationIn.barcodes.filter(Boolean) : [],
      name: identificationIn.name || id || '—',
      brand: identificationIn.brand || '',
      category: identificationIn.category || '',
      confidence: typeof identificationIn.confidence === 'number' ? identificationIn.confidence : 0,
      sku: identificationIn.sku || undefined,
    },
    details: {
      ...(detailsIn as any),
      short_description: detailsIn.short_description || '',
      key_features: Array.isArray(detailsIn.key_features) ? detailsIn.key_features.filter(Boolean) : [],
      attributes:
        detailsIn.attributes && typeof detailsIn.attributes === 'object' && !Array.isArray(detailsIn.attributes)
          ? detailsIn.attributes
          : {},
      identifiers: {
        ...(identifiersIn as any),
      },
      images,
      pricing: {
        ...(pricingIn as any),
        price_confidence: typeof pricingIn.price_confidence === 'number' ? pricingIn.price_confidence : 0,
        lowest_price: {
          ...(lowestPriceIn as any),
          amount: typeof lowestPriceIn.amount === 'number' ? lowestPriceIn.amount : 0,
          currency: (lowestPriceIn.currency || 'EUR') as string,
          sources: Array.isArray(lowestPriceIn.sources) ? lowestPriceIn.sources : [],
          last_checked_iso: lowestPriceIn.last_checked_iso || undefined,
        },
      },
    },
    ops: {
      ...(opsIn as any),
      sync_status: (opsIn.sync_status as any) || 'pending',
      last_saved_iso: opsIn.last_saved_iso ?? null,
      last_synced_iso: opsIn.last_synced_iso ?? null,
      base_product_id: opsIn.base_product_id ?? null,
      baselinker: opsIn.baselinker ?? undefined,
      pending_intake_quantity:
        typeof opsIn.pending_intake_quantity === 'number' ? opsIn.pending_intake_quantity : 0,
      revision: typeof opsIn.revision === 'number' ? opsIn.revision : 0,
    },
  };
};

const normalizeProductBundle = (raw: any): ProductBundle => {
  const input = raw && typeof raw === 'object' ? raw : {};
  const products = Array.isArray(input.products) ? input.products.map(normalizeProduct) : [];
  return {
    ...input,
    products,
  };
};

// Helper function to extract meaningful error info
const extractErrorInfo = (error: any, response?: Response): { code: number; message: string } => {
  // Always use response status if available, regardless of ok status
  if (response && typeof response.status === 'number') {
    return {
      code: response.status,
      message: error?.message || response.statusText || 'Request failed'
    };
  }

  // If error has code and message, use them
  if (error?.code && typeof error.code === 'number' && error?.message) {
    return { code: error.code, message: error.message };
  }

  // Parse common error types
  const message = error instanceof Error ? error.message : 'Unknown error';

  // Try to extract status from error message
  const statusMatch = message.match(/status (\d{3})/);
  if (statusMatch) {
    return { code: parseInt(statusMatch[1], 10), message };
  }

  // Default to 503 for network errors
  return { code: 503, message };
};

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timeout);
      reject(new DOMException('Aborted', 'AbortError'));
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

// Small helper to add a timeout to fetch calls (defaults to 10s)
const fetchWithTimeout = async (input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 20000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const fetchJobStatus = async (jobId: string, signal?: AbortSignal) => {
  const response = await fetch(`${BACKEND_URL}/api/jobs/${jobId}`, {
    method: 'GET',
    signal,
  });
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || `Failed to load job status (${response.status})`);
  }
  return result?.data;
};

export const waitForJobResult = async (
  jobId: string,
  signal?: AbortSignal,
  reportStatus?: (phase: IdentifyPhase) => void
) => {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  while (true) {
    const job = await fetchJobStatus(jobId, signal);
    if (!job) {
      throw new Error('Job not found');
    }
    if (job.status === 'done') {
      return normalizeProductBundle(job.result);
    }
    if (job.status === 'failed') {
      throw new Error(job.error?.message || 'Produktidentifikation fehlgeschlagen.');
    }
    if (job.status === 'processing') {
      reportStatus?.('processing');
    } else {
      reportStatus?.('queued');
    }

    const stage = job.stage || job.progress?.stage || job.state;
    if (typeof stage === 'string' && stage.toLowerCase().includes('enrich')) {
      reportStatus?.('enriching');
    }

    if (Date.now() > deadline) {
      throw new Error('Produktidentifikation hat das Zeitlimit überschritten.');
    }
    await wait(JOB_POLL_INTERVAL_MS, signal);
  }
};

export const createImproveJobs = async (
  productIds: string[]
): Promise<{ ok: boolean; data?: { jobs: Array<{ jobId: string; productId: string }>; missing?: string[] }; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  try {
    response = await fetch(`${BACKEND_URL}/api/improve/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productIds }),
    });
    const result = await parseResponse(response);
    if (!response.ok) {
      return {
        ok: false,
        error: {
          code: response.status,
          message: result?.error?.message || response.statusText || 'Improve-Jobs konnten nicht erstellt werden.',
        },
      };
    }
    return { ok: true, data: result?.data };
  } catch (error) {
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

const fetchImproveJobStatus = async (jobId: string, signal?: AbortSignal) => {
  const response = await fetch(`${BACKEND_URL}/api/improve/jobs/${jobId}?t=${Date.now()}`, {
    method: 'GET',
    signal,
  });
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || `Failed to load improve job (${response.status})`);
  }
  return result?.data;
};

export const pollImproveJob = async (
  jobId: string,
  options?: { signal?: AbortSignal; onStatus?: (phase: IdentifyPhase) => void; timeoutMs?: number; pollIntervalMs?: number }
): Promise<Product> => {
  const timeoutMs = typeof options?.timeoutMs === 'number' ? options.timeoutMs : JOB_TIMEOUT_MS;
  const pollIntervalMs = typeof options?.pollIntervalMs === 'number' ? options.pollIntervalMs : JOB_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const job = await fetchImproveJobStatus(jobId, options?.signal);
    if (!job) {
      throw new Error('Improve-Job wurde nicht gefunden.');
    }
    if (job.status === 'done') {
      if (job.result?.product) {
        return normalizeProduct(job.result.product);
      }
      throw new Error('Improve-Job abgeschlossen, aber kein Produkt geliefert.');
    }
    if (job.status === 'failed') {
      throw new Error(job.error?.message || 'Improve-Job ist fehlgeschlagen.');
    }
    if (job.status === 'processing') {
      const stage = job.stage || job.state; // Capture specific stage if available
      options?.onStatus?.((stage as IdentifyPhase) || 'processing');
    } else {
      // Pass through other statuses if they seem active, otherwise queued
      options?.onStatus?.((job.status as IdentifyPhase) || 'queued');
    }

    if (Date.now() > deadline) {
      throw new Error('Improve-Job hat das Zeitlimit überschritten.');
    }
    await wait(pollIntervalMs, options?.signal);
  }
};

export const createQualityJobs = async (
  productIds: string[],
  options?: { force?: boolean; reason?: string; requestedBy?: string }
): Promise<{ ok: boolean; data?: { jobs: Array<{ jobId: string; productId: string }>; missing?: string[] }; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  try {
    response = await fetch(`${BACKEND_URL}/api/quality/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productIds,
        force: Boolean(options?.force),
        reason: options?.reason || 'manual',
        requestedBy: options?.requestedBy || 'ui',
      }),
    });
    const result = await parseResponse(response);
    if (!response.ok) {
      return {
        ok: false,
        error: {
          code: response.status,
          message: result?.error?.message || response.statusText || 'Quality-Jobs konnten nicht erstellt werden.',
        },
      };
    }
    return { ok: true, data: result?.data };
  } catch (error) {
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

const fetchQualityJobStatus = async (jobId: string, signal?: AbortSignal) => {
  const response = await fetch(`${BACKEND_URL}/api/quality/jobs/${jobId}?t=${Date.now()}`, {
    method: 'GET',
    signal,
  });
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || `Failed to load quality job (${response.status})`);
  }
  return result?.data;
};

export const pollQualityJob = async (
  jobId: string,
  options?: { signal?: AbortSignal; timeoutMs?: number; pollIntervalMs?: number }
): Promise<any> => {
  const timeoutMs = typeof options?.timeoutMs === 'number' ? options.timeoutMs : JOB_TIMEOUT_MS;
  const pollIntervalMs = typeof options?.pollIntervalMs === 'number' ? options.pollIntervalMs : JOB_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const job = await fetchQualityJobStatus(jobId, options?.signal);
    if (!job) {
      throw new Error('Quality-Job wurde nicht gefunden.');
    }
    if (job.status === 'done') {
      return job.result || job;
    }
    if (job.status === 'failed') {
      throw new Error(job.error?.message || 'Quality-Job ist fehlgeschlagen.');
    }
    if (Date.now() > deadline) {
      throw new Error('Quality-Job hat das Zeitlimit überschritten.');
    }
    await wait(pollIntervalMs, options?.signal);
  }
};

export const fetchProducts = async (): Promise<Product[]> => {
  const response = await fetch(`${BACKEND_URL}/api/products`);
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Produkte konnten nicht geladen werden.');
  }
  // Backend may return { products } or { data: [...] }
  if (Array.isArray(result?.products)) {
    return result.products.map(normalizeProduct);
  }
  if (Array.isArray(result?.data?.products)) {
    return result.data.products.map(normalizeProduct);
  }
  if (Array.isArray(result?.data)) {
    return result.data.map(normalizeProduct);
  }
  return [];
};

export const fetchProductById = async (productId: string): Promise<Product> => {
  const response = await fetch(`${BACKEND_URL}/api/products/${encodeURIComponent(productId)}?t=${Date.now()}`);
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Produkt konnte nicht geladen werden.');
  }
  const raw = result?.product || result?.data?.product || result?.data || null;
  if (!raw) {
    throw new Error('Produkt konnte nicht geladen werden (empty payload).');
  }
  return normalizeProduct(raw);
};

export const fetchEbayCategories = async (params: {
  query?: string;
  id?: string;
  limit?: number;
} = {}): Promise<EbayCategoryOption[]> => {
  const query = new URLSearchParams();
  if (params.query) query.set('q', params.query);
  if (params.id) query.set('id', params.id);
  if (params.limit) query.set('limit', String(params.limit));
  const url = query.toString()
    ? `${BACKEND_URL}/api/ebay/categories?${query.toString()}`
    : `${BACKEND_URL}/api/ebay/categories`;
  const response = await fetch(url);
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Kategorien konnten nicht geladen werden.');
  }
  return Array.isArray(result?.items) ? result.items : [];
};

// This function now makes a REAL API call to the live backend server.
export const createIdentificationJob = async (
  images: File[],
  barcodes: string,
  options?: IdentifyApiOptions
): Promise<{ ok: boolean; jobId?: string; error?: { code: number; message: string } }> => {
  const formData = new FormData();
  formData.append('barcodes', barcodes);
  images.forEach((image) => {
    formData.append('images', image, image.name);
  });
  if (options?.model) {
    formData.append('model', options.model);
  }
  if (options?.inventoryId) {
    formData.append('inventoryId', options.inventoryId);
  }

  let response: Response | undefined;

  try {
    response = await fetch(`${BACKEND_URL}/api/jobs`, {
      method: 'POST',
      body: formData,
      signal: options?.signal,
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      return { ok: false, error: { code: 499, message: 'Request cancelled by user' } };
    }
    console.error('Network error:', error);
    const errorInfo = extractErrorInfo(error);
    return { ok: false, error: errorInfo };
  }

  try {
    const result = await parseResponse(response);
    if (!response.ok) {
      throw new Error(result?.error?.message || `Request failed with status ${response.status}`);
    }
    const jobId = result?.jobId;
    if (!jobId) {
      return {
        ok: false,
        error: {
          code: 502,
          message: 'Backend returned invalid job response.',
        },
      };
    }
    return { ok: true, jobId };
  } catch (error) {
    console.error('Failed to create identification job:', error);
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const pollIdentificationJob = async (
  jobId: string,
  options?: { signal?: AbortSignal; onStatus?: (phase: IdentifyPhase) => void }
): Promise<ProductBundle> => {
  const reportStatus = createStatusReporter(options?.onStatus);
  reportStatus('queued');
  return waitForJobResult(jobId, options?.signal, reportStatus);
};

const buildJobQueryString = (params: FetchIdentificationJobsParams) => {
  const search = new URLSearchParams();
  if (Array.isArray(params.statuses) && params.statuses.length) {
    params.statuses.forEach((status) => {
      if (status) {
        search.append('status', status);
      }
    });
  }
  if (typeof params.limit === 'number') {
    search.set('limit', String(params.limit));
  }
  if (params.cursor) {
    search.set('cursor', params.cursor);
  }
  if (params.order) {
    search.set('order', params.order);
  }
  return search.toString();
};

export const fetchIdentificationJobs = async (
  params: FetchIdentificationJobsParams = {}
): Promise<IdentificationJobsResponse> => {
  const query = buildJobQueryString(params);
  const url = query ? `${BACKEND_URL}/api/jobs?${query}` : `${BACKEND_URL}/api/jobs`;
  const response = await fetch(url, {
    method: 'GET',
    signal: params.signal,
  });
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Jobs konnten nicht geladen werden.');
  }
  const data = result?.data || {};
  return {
    jobs: Array.isArray(data.jobs) ? (data.jobs as IdentificationJob[]) : [],
    nextCursor: data.nextCursor || null,
    hasMore: Boolean(data.hasMore),
    stats: data.stats || {},
    filters: {
      statuses: Array.isArray(data.filters?.statuses) ? data.filters.statuses : [],
      limit: data.filters?.limit || params.limit || 50,
      order: data.filters?.order === 'asc' ? 'asc' : 'desc',
    },
  };
};

export const retryIdentificationJob = async (
  jobId: string
): Promise<{ ok: boolean; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  try {
    response = await fetch(`${BACKEND_URL}/api/jobs/${jobId}/retry`, {
      method: 'POST',
    });
    const result = await parseResponse(response);
    if (!response.ok) {
      return {
        ok: false,
        error: {
          code: response.status,
          message: result?.error?.message || 'Job konnte nicht neu gestartet werden.',
        },
      };
    }
    return { ok: true };
  } catch (error) {
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

// --- The rest of the functions remain as mocks for now ---
// In a real application, these would also be implemented on the backend.

export const saveProduct = async (product: Product): Promise<{ ok: boolean; data?: { id: string; revision: number; sku?: string | null }; error?: { code: number; message: string } }> => {
  let response: Response | undefined;

  try {
    if (import.meta.env.DEV) {
      console.log('API CALL: /api/save', { id: product.id, name: product.identification.name });
    }

    response = await fetch(`${BACKEND_URL}/api/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(product),
    });

    const result = await parseResponse(response);

    if (!response.ok) {
      const errorInfo = {
        code: response.status,
        message: result?.error?.message || response.statusText || `Request failed with status ${response.status}`
      };
      return { ok: false, error: errorInfo };
    }

    return result || { ok: true, data: { id: product.id, revision: 1 } };

  } catch (error) {
    console.error('Failed to save product:', error);
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};


// Sync product(s) to BaseLinker – single inventory (default 78659)
export const syncToBaseLinker = async (
  productOrProducts: Product | Product[],
  inventoryId?: string
): Promise<{ ok: boolean; results?: Array<{ id: string; status: 'synced' | 'failed'; message?: string }>; error?: { code: number; message: string } }> => {
  let response: Response | undefined;

  try {
    const inv = (inventoryId || '78659').trim();

    const isSingle = !Array.isArray(productOrProducts);
    const products = Array.isArray(productOrProducts) ? productOrProducts : [productOrProducts];

    if (import.meta.env.DEV) {
      console.log('API CALL: /api/sync-baselinker', { count: products.length, inventoryId: inv });
    }

    // Backend also chunks internally to avoid request timeouts.
    // Keep client chunks SMALL to prevent Cloud Run / proxy timeouts and to avoid sending huge payloads.
    const CHUNK_SIZE = 5;
    const allResults: Array<{ id: string; status: 'synced' | 'failed'; message?: string }> = [];

    for (let i = 0; i < products.length; i += CHUNK_SIZE) {
      const chunk = products.slice(i, i + CHUNK_SIZE);
      // Send ONLY product IDs to keep payload tiny and stable.
      // Backend will load canonical Firestore docs (contains latest saved description, linkage, etc.).
      const ids = chunk.map((p) => p?.id).filter(Boolean) as string[];
      const payload =
        ids.length === 1 && chunk.length === 1
          ? { productId: ids[0], inventoryId: inv }
          : { productIds: ids, inventoryId: inv };

    response = await fetch(`${BACKEND_URL}/api/sync-baselinker`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const result = await parseResponse(response);

    if (!response.ok) {
      throw new Error(result?.error?.message || `Request failed with status ${response.status}`);
    }

      if (Array.isArray(result?.results)) {
        allResults.push(...result.results);
      }
    }

    const failed = allResults.filter((r) => r.status === 'failed');
    return {
      ok: failed.length === 0,
      results: allResults,
      error: failed.length
        ? { code: 502, message: failed.map((f) => `${f.id}: ${f.message || 'Sync failed'}`).join(' | ') }
        : undefined,
    };

  } catch (error) {
    console.error('Failed to sync to BaseLinker:', error);
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

// Lookup SKU/EAN in BaseLinker inventory → returns map { normalizedSkuOrEan: { product_id, sku, ean, inventoryId } }
export const lookupBaseLinkerBySkus = async (
  skus: string[]
): Promise<{ ok: boolean; results?: Record<string, { product_id: number; sku?: string | null; ean?: string | null; inventoryId?: string }>; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  try {
    response = await fetch(`${BACKEND_URL}/api/baselinker/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skus }),
    });
    const result = await parseResponse(response);
    if (!response.ok) {
      return { ok: false, error: { code: response.status, message: result?.error?.message || 'Lookup failed' } };
    }
    return { ok: true, results: result?.results || {} };
  } catch (error) {
    console.error('Failed to lookup BaseLinker SKUs:', error);
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const uploadKTypeCsv = async (
  file: File,
  options?: { dryRun?: boolean }
): Promise<{ ok: boolean; report?: any; error?: { code: number; message: string } }> => {
  const formData = new FormData();
  formData.append('file', file, file.name || 'ktype.csv');

  const url = `${BACKEND_URL}/api/ktype/upload${options?.dryRun ? '?dryRun=1' : ''}`;
  let response: Response | undefined;
  try {
    response = await fetch(url, {
      method: 'POST',
      body: formData,
    });
    const result = await parseResponse(response);
    if (!response.ok) {
      return {
        ok: false,
        error: {
          code: response.status,
          message: result?.error?.message || 'K-Type upload failed',
        },
      };
    }
    return { ok: true, report: result?.report };
  } catch (error) {
    console.error('Failed to upload K-Type CSV:', error);
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const improveProduct = async (
  productId: string
): Promise<{ ok: boolean; data?: Product; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  try {
    response = await fetch(`${BACKEND_URL}/api/products/${encodeURIComponent(productId)}/improve`, {
      method: 'POST',
    });
    const result = await parseResponse(response);
    if (!response.ok) {
      return { ok: false, error: { code: response.status, message: result?.error?.message || 'Improve failed' } };
    }
    return { ok: true, data: result?.data };
  } catch (error) {
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const startBulkImprovement = async (): Promise<{ ok: boolean; data?: { enqueuedParams: number; jobs: Array<{ jobId: string; productId: string }> }; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  try {
    response = await fetch(`${BACKEND_URL}/api/products/bulk-improve`, {
      method: 'POST',
    });
    const result = await parseResponse(response);
    if (!response.ok) {
      return { ok: false, error: { code: response.status, message: result?.error?.message || 'Bulk improvement failed' } };
    }
    return { ok: true, data: result?.data };
  } catch (error) {
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const generateProductImages = async (
  productId: string,
  referenceImage: ProductImage,
  options?: { sampleCount?: number; product?: Product; mode?: string }
): Promise<{
  ok: boolean;
  data?: ProductImage[];
  prompts?: {
    studio?: { front?: string; detail?: string; topdown?: string };
    lifestyle?: { front?: string; closeup?: string; inuse?: string };
  };
  error?: { code: number; message: string };
}> => {
  let response: Response | undefined;
  try {
    response = await fetch(`${BACKEND_URL}/api/generate-images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId,
        product: options?.product,
        referenceImage,
        sampleCount: options?.sampleCount ?? 1,
        mode: options?.mode,
      }),
    });
    const result = await parseResponse(response);
    if (!response.ok) {
      return {
        ok: false,
        error: {
          code: response.status,
          message: result?.error?.message || 'Image generation failed'
        }
      };
    }
    return {
      ok: true,
      data: result?.data?.images ?? result?.data,
      prompts: result?.data?.prompts,
    };
  } catch (error) {
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const fetchOrders = async (limit = 200, options?: { timeoutMs?: number }): Promise<Order[]> => {
  const cappedLimit = Math.min(Math.max(Number(limit) || 0, 1), 200);
  const response = await fetchWithTimeout(
    `${BACKEND_URL}/api/orders?limit=${cappedLimit}`,
    undefined,
    options?.timeoutMs || 25000
  );
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Aufträge konnten nicht geladen werden.');
  }
  return result?.data || [];
};

export const fetchDashboardMetrics = async (
  days = 7,
  options?: { timeoutMs?: number }
): Promise<DashboardMetrics> => {
  const d = Math.min(Math.max(parseInt(String(days), 10) || 7, 1), 60);
  const response = await fetchWithTimeout(
    `${BACKEND_URL}/api/dashboard/metrics?days=${encodeURIComponent(String(d))}`,
    undefined,
    options?.timeoutMs || 25000
  );
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Dashboard-Metriken konnten nicht geladen werden.');
  }
  return result?.data;
};

export const syncOrders = async (options?: { timeoutMs?: number }): Promise<Order[]> => {
  const response = await fetchWithTimeout(
    `${BACKEND_URL}/api/orders/sync`,
    {
      method: 'POST',
    },
    options?.timeoutMs || 25000
  );
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Auftragssync fehlgeschlagen.');
  }
  return result?.data || [];
};

export const completeOrder = async (orderId: string): Promise<void> => {
  const response = await fetch(`${BACKEND_URL}/api/orders/${encodeURIComponent(orderId)}/complete`, {
    method: 'POST',
  });
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Auftragsstatus konnte nicht aktualisiert werden.');
  }
};

export const openSkuLabelWindow = (productId: string): { ok: boolean; error?: { code: number; message: string } } => {
  try {
    const url = `${BACKEND_URL}/api/products/${encodeURIComponent(productId)}/label`;
    const win = window.open(url, '_blank', 'noopener');
    if (!win) {
      return {
        ok: false,
        error: { code: 0, message: 'Popup wurde blockiert. Bitte Popups erlauben.' },
      };
    }
    return { ok: true };
  } catch (error: any) {
    console.error('Failed to open label window:', error);
    return { ok: false, error: { code: 0, message: error?.message || 'Unbekannter Fehler' } };
  }
};

export const openProductLabelBatchWindow = (productIds: string[]): { ok: boolean; error?: { code: number; message: string } } => {
  if (!productIds.length) {
    return { ok: false, error: { code: 0, message: 'Keine Produkte ausgewählt.' } };
  }
  try {
    const url = `${BACKEND_URL}/api/products/labels?ids=${encodeURIComponent(productIds.join(','))}`;
    const win = window.open(url, '_blank', 'noopener');
    if (!win) {
      return { ok: false, error: { code: 0, message: 'Popup wurde blockiert.' } };
    }
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: { code: 0, message: error?.message || 'Unbekannter Fehler' } };
  }
};

export const fetchWarehouseZones = async (): Promise<WarehouseLayout[]> => {
  const response = await fetch(`${BACKEND_URL}/api/warehouse/zones`);
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Failed to load zones');
  }
  return result?.data || [];
};

export const createWarehouseLayoutApi = async (payload: {
  zone: string;
  etage: string;
  gangs: string;
  regale: string;
  ebenen: string;
}): Promise<{ ok: boolean; data?: any; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  try {
    response = await fetch(`${BACKEND_URL}/api/warehouse/layouts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await parseResponse(response);
    if (!response.ok) {
      return { ok: false, error: { code: response.status, message: result?.error?.message || 'Failed to create layout' } };
    }
    return { ok: true, data: result?.data };
  } catch (error) {
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const deleteWarehouseGangApi = async (
  zone: string,
  etage: string,
  gang: number,
  options?: { confirm?: boolean; dryRun?: boolean; timeoutMs?: number }
): Promise<{ ok: boolean; data?: any; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  try {
    const params = new URLSearchParams();
    if (options?.dryRun) params.set('dryRun', '1');
    if (options?.confirm) params.set('confirm', '1');
    const url = `${BACKEND_URL}/api/warehouse/layouts/${encodeURIComponent(zone)}/${encodeURIComponent(etage)}/gangs/${encodeURIComponent(
      String(gang)
    )}?${params.toString()}`;
    response = await fetchWithTimeout(
      url,
      {
        method: 'DELETE',
      },
      options?.timeoutMs || 25000
    );
    const result = await parseResponse(response);
    if (!response.ok) {
      return { ok: false, error: { code: response.status, message: result?.error?.message || 'Gang löschen fehlgeschlagen' } };
    }
    return { ok: true, data: result?.data };
  } catch (error) {
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const deleteWarehouseRegalApi = async (
  zone: string,
  etage: string,
  gang: number,
  regal: number,
  options?: { confirm?: boolean; dryRun?: boolean; timeoutMs?: number }
): Promise<{ ok: boolean; data?: any; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  try {
    const params = new URLSearchParams();
    if (options?.dryRun) params.set('dryRun', '1');
    if (options?.confirm) params.set('confirm', '1');
    const url = `${BACKEND_URL}/api/warehouse/layouts/${encodeURIComponent(zone)}/${encodeURIComponent(
      etage
    )}/gangs/${encodeURIComponent(String(gang))}/regale/${encodeURIComponent(String(regal))}?${params.toString()}`;
    response = await fetchWithTimeout(
      url,
      {
        method: 'DELETE',
      },
      options?.timeoutMs || 25000
    );
    const result = await parseResponse(response);
    if (!response.ok) {
      return { ok: false, error: { code: response.status, message: result?.error?.message || 'Regal löschen fehlgeschlagen' } };
    }
    return { ok: true, data: result?.data };
  } catch (error) {
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const deleteWarehouseEbeneApi = async (
  zone: string,
  etage: string,
  gang: number,
  regal: number,
  ebene: string,
  options?: { confirm?: boolean; dryRun?: boolean; timeoutMs?: number }
): Promise<{ ok: boolean; data?: any; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  try {
    const params = new URLSearchParams();
    if (options?.dryRun) params.set('dryRun', '1');
    if (options?.confirm) params.set('confirm', '1');
    const url = `${BACKEND_URL}/api/warehouse/layouts/${encodeURIComponent(zone)}/${encodeURIComponent(
      etage
    )}/gangs/${encodeURIComponent(String(gang))}/regale/${encodeURIComponent(String(regal))}/ebenen/${encodeURIComponent(
      String(ebene)
    )}?${params.toString()}`;
    response = await fetchWithTimeout(
      url,
      {
        method: 'DELETE',
      },
      options?.timeoutMs || 25000
    );
    const result = await parseResponse(response);
    if (!response.ok) {
      return { ok: false, error: { code: response.status, message: result?.error?.message || 'Ebene löschen fehlgeschlagen' } };
    }
    return { ok: true, data: result?.data };
  } catch (error) {
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const fetchWarehouseBins = async (zone: string, etage: string): Promise<WarehouseBin[]> => {
  const response = await fetch(`${BACKEND_URL}/api/warehouse/zones/${encodeURIComponent(zone)}/${encodeURIComponent(etage)}`);
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Failed to load bins');
  }
  return result?.data || [];
};

export const fetchWarehouseBinDetail = async (code: string): Promise<WarehouseBin> => {
  const response = await fetch(`${BACKEND_URL}/api/warehouse/bins/${encodeURIComponent(code)}`);
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Failed to load bin detail');
  }
  return result?.data;
};

export const fetchProductBins = async (productId: string): Promise<WarehouseBin[]> => {
  const response = await fetch(`${BACKEND_URL}/api/products/${encodeURIComponent(productId)}/bins`);
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Failed to load product bins');
  }
  return result?.data || [];
};

export const assignProductToBinApi = async (
  code: string,
  productId: string,
  quantity: number
): Promise<{ ok: boolean; data?: { bin: WarehouseBin; product: Product }; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  try {
    response = await fetch(`${BACKEND_URL}/api/warehouse/bins/${encodeURIComponent(code)}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, quantity }),
    });
    const result = await parseResponse(response);
    if (!response.ok) {
      return { ok: false, error: { code: response.status, message: result?.error?.message || 'Failed to assign product' } };
    }
    return { ok: true, data: result?.data };
  } catch (error) {
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const removeProductFromBinApi = async (
  code: string,
  productId: string
): Promise<{ ok: boolean; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  try {
    response = await fetch(
      `${BACKEND_URL}/api/warehouse/bins/${encodeURIComponent(code)}/products/${encodeURIComponent(productId)}`,
      {
        method: 'DELETE',
      }
    );
    if (!response.ok) {
      const result = await parseResponse(response);
      return { ok: false, error: { code: response.status, message: result?.error?.message || 'Failed to remove from bin' } };
    }
    return { ok: true };
  } catch (error) {
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const stockInProduct = async (payload: {
  sku?: string;
  productId?: string;
  barcode?: string;
  binCode: string;
  quantity: number;
  meta?: Record<string, any>;
}): Promise<{ ok: boolean; data?: { bin: WarehouseBin; product: Product }; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  try {
    response = await fetch(`${BACKEND_URL}/api/warehouse/stock-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await parseResponse(response);
    if (!response.ok) {
      return { ok: false, error: { code: response.status, message: result?.error?.message || 'Stow fehlgeschlagen' } };
    }
    return { ok: true, data: result?.data };
  } catch (error) {
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const stockOutProduct = async (payload: {
  sku?: string;
  productId?: string;
  barcode?: string;
  binCode: string;
  quantity: number;
  orderId?: string;
  orderItemId?: string;
  meta?: Record<string, any>;
}): Promise<{ ok: boolean; data?: { bin: WarehouseBin; product: Product }; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  try {
    response = await fetch(`${BACKEND_URL}/api/warehouse/stock-out`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await parseResponse(response);
    if (!response.ok) {
      return { ok: false, error: { code: response.status, message: result?.error?.message || 'Kommissionierung fehlgeschlagen' } };
    }
    return { ok: true, data: result?.data };
  } catch (error) {
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const openBinLabelWindow = (code: string): { ok: boolean; error?: { code: number; message: string } } => {
  try {
    const url = `${BACKEND_URL}/api/warehouse/bins/${encodeURIComponent(code)}/label`;
    const win = window.open(url, '_blank', 'noopener');
    if (!win) {
      return { ok: false, error: { code: 0, message: 'Popup wurde blockiert.' } };
    }
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: { code: 0, message: error?.message || 'Unbekannter Fehler' } };
  }
};

export const openBinLabelsBatchWindow = (options: {
  codes?: string[];
  zone?: string;
  etage?: string;
  gang?: number;
  regal?: number;
}): { ok: boolean; error?: { code: number; message: string } } => {
  const normalizedCodes = options.codes
    ?.map((code) => code?.trim().toUpperCase())
    .filter((code): code is string => Boolean(code));

  if ((!normalizedCodes || !normalizedCodes.length) && (!options.zone || !options.etage)) {
    return { ok: false, error: { code: 400, message: 'Bitte Bins auswählen oder Zone & Etage angeben.' } };
  }

  const params = new URLSearchParams();
  if (normalizedCodes?.length) {
    normalizedCodes.forEach((code) => params.append('codes', code));
  } else {
    if (options.zone) params.set('zone', options.zone);
    if (options.etage) params.set('etage', options.etage);
    if (options.gang != null) params.set('gang', String(options.gang));
    if (options.regal != null) params.set('regal', String(options.regal));
  }
  const url = `${BACKEND_URL}/api/warehouse/bins/labels.pdf?${params.toString()}`;
  const popup = window.open(url, '_blank', 'noopener');
  if (!popup) {
    return { ok: false, error: { code: 0, message: 'Popup wurde blockiert.' } };
  }
  return { ok: true };
};

export const refreshPrice = async (productId: string): Promise<{ ok: boolean; data?: any; error?: { code: number; message: string } }> => {
  let response: Response | undefined;

  try {
    if (import.meta.env.DEV) {
      console.log('API CALL: /api/price-refresh', { productId });
    }

    response = await fetch(`${BACKEND_URL}/api/price-refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ productId }),
    });

    const result = await parseResponse(response);

    if (!response.ok) {
      throw new Error(result?.error?.message || `Request failed with status ${response.status}`);
    }

    return result;

  } catch (error) {
    console.error('Failed to refresh price:', error);
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export interface ChatAssistantPayload {
  message: string;
  datasheetChanges: DatasheetChange[];
  imageSuggestions: ImageSuggestionGroup[];
  serpTrace: SerpInsight[];
}

export const chatWithAssistant = async (
  productId: string | undefined,
  message: string,
  attachments: File[] = []
): Promise<{ ok: boolean; data?: ChatAssistantPayload; error?: { code: number; message: string } }> => {
  let response: Response | undefined;

  try {
    if (import.meta.env.DEV) {
      console.log('API CALL: /api/chat', {
        productId,
        messageLength: message.length,
        attachments: attachments.length,
      });
    }

    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    let requestInit: RequestInit;

    if (hasAttachments) {
      const formData = new FormData();
      if (productId) {
        formData.append('productId', productId);
      }
      formData.append('message', message);
      attachments.forEach((file) => formData.append('attachments', file));
      requestInit = {
        method: 'POST',
        body: formData,
      };
    } else {
      requestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ productId, message }),
      };
    }

    response = await fetch(`${BACKEND_URL}/api/chat`, requestInit);

    const result = await parseResponse(response);

    if (!response.ok) {
      throw new Error(result?.error?.message || `Request failed with status ${response.status}`);
    }

    return result;

  } catch (error) {
    console.error('Failed to chat with Gemini:', error);
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const runSerpapiFreeEnrichment = async (
  files: File[],
  barcodes: string,
  locale = 'de-DE',
  inventoryId?: string
): Promise<{ ok: boolean; data?: ProductEnrichmentRecord; error?: { code: number; message: string } }> => {
  if (!files.length && (!barcodes || !barcodes.trim())) {
    return {
      ok: false,
      error: { code: 400, message: 'Bitte mindestens ein Bild oder einen Barcode bereitstellen.' },
    };
  }

  const formData = new FormData();
  files.forEach((file) => formData.append('images', file));
  formData.append('barcodes', barcodes);
  formData.append('locale', locale);
  if (inventoryId) {
    formData.append('inventoryId', inventoryId);
  }

  let response: Response | undefined;
  try {
    response = await fetch(`${BACKEND_URL}/api/v2/enrich`, {
      method: 'POST',
      body: formData,
    });
    const result = await parseResponse(response);
    if (!response.ok) {
      return {
        ok: false,
        error: {
          code: response.status,
          message: result?.error?.message || 'SerpAPI-freies Enrichment fehlgeschlagen.',
        },
      };
    }
    return { ok: true, data: result?.data as ProductEnrichmentRecord };
  } catch (error) {
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const resolveIntakeExisting = async (params: {
  barcodes: string;
  sku?: string | null;
  inventoryId?: string | null;
}): Promise<{
  ok: boolean;
  data?: { matched: boolean; product?: Product; pendingIntakeQuantity?: number };
  error?: { code: number; message: string };
}> => {
  let response: Response | undefined;
  try {
    response = await fetch(`${BACKEND_URL}/api/intake/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        barcodes: params.barcodes || '',
        sku: params.sku || null,
        inventoryId: params.inventoryId || null,
      }),
    });
    const result = await parseResponse(response);
    if (!response.ok || result?.ok === false) {
      return {
        ok: false,
        error: {
          code: response.status || 500,
          message: result?.error?.message || 'Intake resolve fehlgeschlagen.',
        },
      };
    }
    const data = result?.data || {};
    return {
      ok: true,
      data: {
        matched: Boolean(data.matched),
        product: data.product ? normalizeProduct(data.product) : undefined,
        pendingIntakeQuantity: typeof data.pendingIntakeQuantity === 'number' ? data.pendingIntakeQuantity : undefined,
      },
    };
  } catch (error) {
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const scanDocument = async (): Promise<{ ok: boolean; data?: { mimeType: string; base64: string; capturedAt: string }; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  try {
    response = await fetch(`${BACKEND_URL}/api/scanner/capture`, {
      method: 'POST',
    });
    const result = await parseResponse(response);
    if (!response.ok) {
      return { ok: false, error: { code: response.status, message: result?.error?.message || 'Scanner-Aufnahme fehlgeschlagen.' } };
    }
    return { ok: true, data: result?.data };
  } catch (error) {
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

// Delete a product
export const deleteProduct = async (productId: string): Promise<{ ok: boolean; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  try {
    response = await fetch(`${BACKEND_URL}/api/products/${encodeURIComponent(productId)}`, {
      method: 'DELETE'
    });
    if (response.status === 204) {
      return { ok: true };
    }
    const result = await parseResponse(response);
    if (!response.ok || result?.ok === false) {
      const message = result?.error?.message || response.statusText || 'Delete failed';
      return { ok: false, error: { code: response.status || 500, message } };
    }
    return { ok: true };
  } catch (error) {
    console.error('Failed to delete product:', error);
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const fetchInventories = async (params: { search?: string; vendor?: string; limit?: number } = {}): Promise<InventoryRecord[]> => {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  if (params.vendor) query.set('vendor', params.vendor);
  if (params.limit) query.set('limit', String(params.limit));
  const url = query.toString() ? `${BACKEND_URL}/api/inventories?${query.toString()}` : `${BACKEND_URL}/api/inventories`;
  const response = await fetch(url);
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Inventories konnten nicht geladen werden.');
  }
  return Array.isArray(result?.data) ? (result.data as InventoryRecord[]) : [];
};

export const fetchInventoryById = async (inventoryId: string): Promise<InventoryRecord | null> => {
  const response = await fetch(`${BACKEND_URL}/api/inventories/${encodeURIComponent(inventoryId)}`);
  if (response.status === 404) {
    return null;
  }
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Inventory konnte nicht geladen werden.');
  }
  return (result?.data as InventoryRecord) || null;
};

export const syncInventories = async () => {
  const response = await fetch(`${BACKEND_URL}/api/inventories/sync`, {
    method: 'POST',
  });
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Inventory-Sync fehlgeschlagen.');
  }
  return result?.data;
};

export const assignInventoryToProducts = async (productIds: string[], inventoryId: string) => {
  const response = await fetch(`${BACKEND_URL}/api/inventories/assign`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ productIds, inventoryId }),
  });
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Inventory konnte nicht zugewiesen werden.');
  }
  return result?.data;
};

export const setProductInventoryId = async (productId: string, inventoryId: string) => {
  const response = await fetch(`${BACKEND_URL}/api/products/${encodeURIComponent(productId)}/inventory`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inventoryId }),
  });
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Inventory konnte nicht gesetzt werden.');
  }
  return result?.data;
};

export const openInventoryLabelWindow = (inventoryId: string): { ok: boolean; error?: { code: number; message: string } } => {
  if (!inventoryId) {
    return { ok: false, error: { code: 400, message: 'Inventory ID fehlt.' } };
  }
  const url = `${BACKEND_URL}/api/inventories/${encodeURIComponent(inventoryId)}/label.pdf`;
  const tab = window.open(url, '_blank', 'noopener');
  if (!tab) {
    return { ok: false, error: { code: 0, message: 'Popup wurde blockiert.' } };
  }
  return { ok: true };
};
