
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
  EbayCategoryTaxonomyEntry,
  EbayCategoryAspectCatalog,
  DashboardMetrics,
  FinanceMetrics,
  FinancialReport,
  FinancialCostModelInput,
  EbayListingRow,
  EbayListingDetail,
  EbayGapDoc,
  EbaySyncDryRunResult,
  EbaySyncApplyResult,
  EbayPublishOverrides,
  EbayPublishVerifyResult,
  EbayPublishResult,
  EbayBulkPublishVerifyResult,
  EbayBulkPublishResult,
  CompetitorPricesResponse,
  PriceHistoryEntry,
  ShippingMethod,
} from '../types';

// Backend URL configuration - single source of truth
// Use import.meta.env for Vite compatibility
const normalizeBackendBaseUrl = (rawValue: string | null | undefined, label: string): string | null => {
  const text = String(rawValue || '').trim();
  if (!text) return null;
  try {
    const parsed = new URL(text);
    const hasExtraPath = parsed.pathname && parsed.pathname !== '/';
    const hasQuery = Boolean(parsed.search);
    const hasHash = Boolean(parsed.hash);
    if (hasExtraPath || hasQuery || hasHash) {
      console.warn(
        `[api] ${label} should be origin-only (scheme + host). Ignoring path/query/hash from "${text}" and using "${parsed.origin}".`
      );
    }
    return parsed.origin;
  } catch {
    console.error(`[api] Invalid ${label}: "${text}". Expected absolute URL like "https://example.com".`);
    return null;
  }
};

const BACKEND_URL = (() => {
  const envUrl = normalizeBackendBaseUrl(import.meta.env.VITE_BACKEND_URL, 'VITE_BACKEND_URL');

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

  // In production, use env or default to the canonical regional Cloud Run URL.
  // Prefer the *.run.app hostname over legacy aliases to avoid stale routing behavior.
  return envUrl || 'https://product-hub-backend-79205549235.europe-west3.run.app';
})();

export const getBackendUrl = () => BACKEND_URL;

const FALLBACK_BACKEND_URLS = (() => {
  const envList = String(import.meta.env.VITE_BACKEND_FALLBACK_URLS || '')
    .split(',')
    .map((entry) => normalizeBackendBaseUrl(entry, 'VITE_BACKEND_FALLBACK_URLS'))
    .filter(Boolean) as string[];
  const defaults = [
    'https://product-hub-backend-sa6a4cbk3q-ey.a.run.app',
    'https://product-hub-backend-79205549235.europe-west3.run.app',
  ];
  return Array.from(new Set([...envList, ...defaults]));
})();

let ebayBackendOriginOverride: string | null = null;

type TokenProvider = (forceRefresh?: boolean) => Promise<string | null>;

let tokenProvider: TokenProvider | null = null;
let defaultProviderInstalled = false;
let defaultProviderInstallPromise: Promise<void> | null = null;

/**
 * Register a token provider from the Auth layer so all API calls automatically attach:
 * Authorization: Bearer <idToken>
 */
export function setAuthTokenProvider(provider: TokenProvider | null) {
  tokenProvider = provider;
}

async function ensureDefaultFirebaseTokenProviderInstalled(): Promise<void> {
  if (tokenProvider || defaultProviderInstalled) return;
  if (defaultProviderInstallPromise) return await defaultProviderInstallPromise;

  // Lazy dynamic import (Vite-compatible). This ensures early requests (e.g. inventory load)
  // don't fire before AuthContext effect wires the provider.
  defaultProviderInstallPromise = (async () => {
    try {
      const mod = await import('../utils/firebase');
      const auth = mod.getFirebaseAuth();
      tokenProvider = async (forceRefresh?: boolean) => {
        // Beim Seitenladen stellt Firebase die (Session-)Anmeldung ASYNCHRON
        // wieder her. Feuert eine Anfrage bevor das passiert ist, wäre
        // currentUser noch null → Anfrage ginge ohne Token raus → Backend 401
        // ("Missing Authorization bearer token"). Deshalb: einmal auf den
        // fertigen Auth-Startzustand warten, bevor wir aufgeben.
        if (!auth?.currentUser && typeof auth?.authStateReady === "function") {
          try {
            await auth.authStateReady();
          } catch {
            // Best-effort: ist authStateReady nicht verfügbar/wirft, fahren wir
            // mit dem aktuellen currentUser-Stand fort.
          }
        }
        const current = auth?.currentUser;
        if (!current) return null;
        return await current.getIdToken(Boolean(forceRefresh));
      };
      defaultProviderInstalled = true;
    } catch {
      // ignore – requests will proceed without token and backend will return 401
      defaultProviderInstalled = true;
    } finally {
      defaultProviderInstallPromise = null;
    }
  })();

  return await defaultProviderInstallPromise;
}

const isValidBearer = (value: string | null) => /^Bearer\s+\S+$/i.test(String(value || ''));

const toOrigin = (value: string | null | undefined): string | null => {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    return new URL(text).origin;
  } catch {
    return null;
  }
};

const toUrl = (input: RequestInfo | URL): URL | null => {
  if (input instanceof URL) {
    return new URL(input.toString());
  }
  if (typeof input === 'string') {
    try {
      return new URL(input, window.location.origin);
    } catch {
      return null;
    }
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    try {
      return new URL(input.url);
    } catch {
      return null;
    }
  }
  return null;
};

const isLocalOrigin = (origin: string | null): boolean => {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
  } catch {
    return false;
  }
};

const rewriteUrlOrigin = (source: URL, targetOrigin: string): string => {
  const target = new URL(targetOrigin);
  target.pathname = source.pathname;
  target.search = source.search;
  target.hash = source.hash;
  return target.toString();
};

const normalizeLegacyAppApiPath = (source: URL): URL => {
  const next = new URL(source.toString());
  if (next.pathname.startsWith('/app/api')) {
    next.pathname = next.pathname.replace(/^\/app(?=\/api(?:\/|$))/, '');
  }
  return next;
};

const normalizeRequestInput = (requestInput: RequestInfo | URL): RequestInfo | URL => {
  const parsed = toUrl(requestInput);
  if (!parsed) return requestInput;
  const normalized = normalizeLegacyAppApiPath(parsed);
  return normalized.toString();
};

const isHtml404 = (response: Response): boolean => {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  return response.status === 404 && contentType.includes('text/html');
};

const shouldRetryWithBackendFallback = (response: Response, requestUrl: URL | null): boolean => {
  if (!requestUrl) return false;
  if (!requestUrl.pathname.includes('/api/ebay/')) return false;
  if (isLocalOrigin(requestUrl.origin)) return false;
  return isHtml404(response);
};

const getBackendFallbackOrigins = (currentOrigin: string | null): string[] => {
  const configuredOrigin = toOrigin(BACKEND_URL);
  const candidates = [
    ebayBackendOriginOverride,
    configuredOrigin,
    ...FALLBACK_BACKEND_URLS.map((entry) => toOrigin(entry)),
  ].filter(Boolean) as string[];
  const unique = Array.from(new Set(candidates));
  return unique.filter((origin) => origin !== currentOrigin);
};

const buildHeadersWithAuth = async (base?: HeadersInit, forceRefresh = false): Promise<Headers> => {
  await ensureDefaultFirebaseTokenProviderInstalled();
  const headers = new Headers(base || {});
  const existingAuth = headers.get('Authorization');
  if ((!existingAuth || !isValidBearer(existingAuth)) && tokenProvider) {
    try {
      const token = await tokenProvider(forceRefresh);
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
    } catch (error) {
      // If token acquisition fails, proceed without token so backend returns a clear 401/403.
      console.warn('Failed to attach auth token to request:', (error as any)?.message || error);
    }
  }
  return headers;
};

export const fetchApi = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const configuredOrigin = toOrigin(BACKEND_URL);
  const initialUrl = toUrl(input);
  const isEbayRequest = Boolean(initialUrl?.pathname?.startsWith('/api/ebay/'));

  const effectiveInput: RequestInfo | URL = (() => {
    if (!isEbayRequest || !ebayBackendOriginOverride || !initialUrl || !configuredOrigin) return input;
    if (initialUrl.origin !== configuredOrigin) return input;
    try {
      return rewriteUrlOrigin(initialUrl, ebayBackendOriginOverride);
    } catch {
      return input;
    }
  })();

  const attempt = async (forceRefresh: boolean, requestInput: RequestInfo | URL = effectiveInput) => {
    const headers = await buildHeadersWithAuth(init.headers, forceRefresh);
    const normalizedInput = normalizeRequestInput(requestInput);
    return await fetch(normalizedInput, { ...init, headers });
  };

  let res = await attempt(false, effectiveInput);
  // If we get a 401, try forcing a token refresh once.
  if (res.status === 401 && tokenProvider) {
    try {
      res = await attempt(true, effectiveInput);
    } catch {
      // keep original response
    }
  }

  const requestUrl = toUrl(effectiveInput) || initialUrl;
  if (!shouldRetryWithBackendFallback(res, requestUrl)) {
    return res;
  }

  const fallbacks = getBackendFallbackOrigins(requestUrl?.origin || null);
  for (const fallbackOrigin of fallbacks) {
    if (!requestUrl) break;
    const fallbackInput = rewriteUrlOrigin(requestUrl, fallbackOrigin);
    let fallbackRes = await attempt(false, fallbackInput);
    if (fallbackRes.status === 401 && tokenProvider) {
      try {
        fallbackRes = await attempt(true, fallbackInput);
      } catch {
        // keep original fallback response
      }
    }
    if (!isHtml404(fallbackRes)) {
      ebayBackendOriginOverride = fallbackOrigin;
      console.warn(
        `[api] switched backend origin for eBay endpoints to ${fallbackOrigin} (previous returned 404 HTML)`
      );
      return fallbackRes;
    }
  }

  return res;
};

const openAuthedUrlInNewTab = (url: string, opts?: { timeoutMs?: number }) => {
  // IMPORTANT:
  // We must keep a window handle to later assign popup.location.href to a Blob URL.
  // Per MDN, using `noopener` in windowFeatures may cause window.open() to return null
  // even when a new tab/window is successfully opened.
  // https://developer.mozilla.org/en-US/docs/Web/API/Window/open#noopener
  //
  // Security: we still prevent reverse-tabnabbing by nulling opener immediately.
  const popup = window.open('about:blank', '_blank');
  if (!popup) {
    return { ok: false, error: { code: 0, message: 'Popup wurde blockiert. Bitte Popups erlauben.' } };
  }
  try {
    // Best-effort: prevent the opened context from being able to navigate the opener.
    // (Equivalent intent to rel=noopener.)
    popup.opener = null;
  } catch {
    // ignore
  }

  (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs || 25000);
    try {
      try {
        popup.document.title = 'AvyCloud';
        popup.document.body.innerHTML =
          '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:16px;color:#111;">Lade…</div>';
      } catch {
        // ignore
      }
      const res = await fetchApi(url, { method: 'GET', signal: controller.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Request failed (${res.status}) ${body?.slice(0, 120)}`);
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      popup.location.href = blobUrl;
      try {
        popup.focus?.();
      } catch {
        // ignore
      }
      // Best-effort cleanup: revoke later (cannot revoke immediately; tab would break).
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } finally {
      clearTimeout(timeout);
    }
  })().catch((error) => {
    try {
      popup.document.title = 'AvyCloud';
      popup.document.body.innerHTML = `<pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,Monaco,Consolas,monospace;">${String(
        (error as any)?.message || error
      )}</pre>`;
    } catch {
      // ignore
    }
  });

  return { ok: true } as const;
};

const openUrlFallback = (url: string) => {
  try {
    // Prefer an anchor click (some browsers treat it differently than window.open).
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch {
    return false;
  }
};

const printAuthedHtmlUrl = async (url: string, opts?: { timeoutMs?: number }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs || 25000);
  try {
    const res = await fetchApi(url, { method: 'GET', signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Request failed (${res.status}) ${body?.slice(0, 180)}`);
    }
    const html = await res.text();
    const blob = new Blob([html], { type: 'text/html' });
    const blobUrl = URL.createObjectURL(blob);

    // Render into hidden iframe and print (no popups).
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.style.opacity = '0';
    iframe.src = blobUrl;
    document.body.appendChild(iframe);

    await new Promise<void>((resolve) => {
      const done = () => resolve();
      iframe.onload = () => done();
      // Safety: resolve even if onload is flaky.
      setTimeout(done, 1500);
    });

    try {
      iframe.contentWindow?.focus?.();
      iframe.contentWindow?.print?.();
    } catch (err: any) {
      // Fallback: open blob in a new tab or same tab.
      if (!openUrlFallback(blobUrl)) {
        window.location.assign(blobUrl);
      }
      throw err;
    } finally {
      // Cleanup after the print dialog had a chance to open.
      setTimeout(() => {
        try {
          iframe.remove();
        } catch {}
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {}
      }, 10_000);
    }
    return { ok: true } as const;
  } finally {
    clearTimeout(timeout);
  }
};

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

export async function searchEbayCategories({
  q,
  id,
  limit = 50,
  leafOnly,
}: {
  q?: string;
  id?: string;
  limit?: number;
  leafOnly?: boolean;
}) {
  const url = new URL(`${BACKEND_URL}/api/ebay/categories`);
  if (q) url.searchParams.set('q', q);
  if (id) url.searchParams.set('id', id);
  url.searchParams.set('limit', String(limit));
  if (leafOnly) url.searchParams.set('leafOnly', 'true');
  const res = await fetchApi(url.toString(), { method: 'GET' });
  const data = await parseResponse(res);
  return (data?.items || []) as EbayCategoryOption[];
}

export async function fetchEbayTaxonomyCategories(params?: {
  includeBanned?: boolean;
  leafOnly?: boolean;
}): Promise<EbayCategoryTaxonomyEntry[]> {
  const url = new URL(`${BACKEND_URL}/api/ebay/taxonomy/categories`);
  if (params?.includeBanned) url.searchParams.set('includeBanned', 'true');
  if (params?.leafOnly) url.searchParams.set('leafOnly', 'true');
  // Keep caches honest in admin UIs
  url.searchParams.set('t', String(Date.now()));
  const res = await fetchApi(url.toString(), { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to load eBay taxonomy categories');
  }
  return (data?.data?.items || []) as EbayCategoryTaxonomyEntry[];
}

export async function fetchEbayTaxonomyCategoryAspects(categoryId: string): Promise<EbayCategoryAspectCatalog> {
  const id = String(categoryId || '').trim();
  if (!id) throw new Error('categoryId is required');
  const safe = encodeURIComponent(id);
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/taxonomy/categories/${safe}/aspects?t=${Date.now()}`, {
    method: 'GET',
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to load eBay taxonomy aspects');
  }
  return (data?.data?.catalog || null) as EbayCategoryAspectCatalog;
}

// --- eBay Integration (OAuth + Listing Snapshots) ---
export type EbayConnectionStatus = {
  connected: boolean;
  env?: string | null;
  scopes?: string[];
  tokenType?: string | null;
  connectedBy?: { uid?: string | null; email?: string | null } | null;
  connectedAt?: string | null;
  updatedAt?: string | null;
  lastRefreshedAt?: string | null;
  accessTokenExpiresAt?: string | null;
  refreshTokenExpiresAt?: string | null;
};

export type EbayTradingStatus = {
  connected: boolean;
  mode?: string | null;
  env?: string | null;
  endpoint?: string | null;
  siteId?: string | null;
  compatibilityLevel?: string | null;
  appIdMasked?: string | null;
  devIdMasked?: string | null;
  certIdMasked?: string | null;
  tokenConfigured?: boolean;
};

export async function startEbayOAuth(opts?: { locale?: string; promptLogin?: boolean }): Promise<string> {
  const url = new URL(`${BACKEND_URL}/api/ebay/oauth/start`);
  url.searchParams.set('locale', opts?.locale || 'de-DE');
  if (opts?.promptLogin) url.searchParams.set('prompt', 'login');
  const res = await fetchApi(url.toString(), { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to start eBay OAuth');
  }
  const out = data?.data?.url;
  if (!out) throw new Error('eBay OAuth URL missing');
  return String(out);
}

// ─── Settings API ────────────────────────────────────────────

export interface CompanySettingsData {
  firmenname?: string;
  rechtsform?: string;
  ustIdNr?: string;
  steuernummer?: string;
  strasse?: string;
  plz?: string;
  ort?: string;
  land?: string;
  email?: string;
  telefon?: string;
  website?: string;
  iban?: string;
  bic?: string;
  bank?: string;
  [key: string]: any;
}

export async function fetchCompanySettings(): Promise<CompanySettingsData> {
  const res = await fetchApi(`${BACKEND_URL}/api/settings/company`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to load company settings');
  }
  return data?.data || {};
}

export async function saveCompanySettings(settings: CompanySettingsData): Promise<CompanySettingsData> {
  const res = await fetchApi(`${BACKEND_URL}/api/settings/company`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to save company settings');
  }
  return data?.data || {};
}

export interface ProfileData {
  vorname?: string;
  nachname?: string;
  email?: string;
  displayName?: string;
  notifications?: Record<string, boolean>;
  theme?: string;
  [key: string]: any;
}

export async function fetchProfile(): Promise<ProfileData> {
  const res = await fetchApi(`${BACKEND_URL}/api/settings/profile`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to load profile');
  }
  return data?.data || {};
}

export async function saveProfile(profile: ProfileData): Promise<ProfileData> {
  const res = await fetchApi(`${BACKEND_URL}/api/settings/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to save profile');
  }
  return data?.data || {};
}

/** Ehrlicher Zustand des eBay-Angebots-Abgleichs (aus ops/ebayLightSync). null = unbekannt (nie gelaufen). */
export interface EbayListingSyncHealth {
  healthy: boolean | null;
  lastSuccessAtIso: string | null;
  staleMinutes: number | null;
  lastError: { message: string; atIso: string | null } | null;
  failingSinceIso: string | null;
  blockedReason: string | null;
  pendingConfirmation: boolean;
  staleLimitMinutes: number;
}

export interface IntegrationStatusEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  authType?: string;
  status: 'connected' | 'not_connected';
  connectedAt?: string | null;
  updatedAt?: string | null;
  lastRefreshedAt?: string | null;
  details?: Record<string, any> & { listingSync?: EbayListingSyncHealth | null };
  settings?: Record<string, any> | null;
  connectedBy?: { uid: string; email: string } | null;
  dependsOn?: string | null;
}

export interface IntegrationProvider {
  id: string;
  name: string;
  description: string;
  category: string;
  authType: 'oauth2' | 'api_key' | 'none';
  logo: string;
  helpUrl?: string;
  helpText?: string;
  features?: string[];
  fields?: Array<{ key: string; label: string; type: string; placeholder?: string; required?: boolean; minLength?: number }>;
  dependsOn?: string | null;
}

export interface IntegrationDetail {
  id: string;
  name: string;
  description: string;
  category: string;
  authType: string;
  features?: string[];
  helpUrl?: string;
  helpText?: string;
  fields?: Array<{ key: string; label: string; type: string; placeholder?: string; required?: boolean }>;
  status: string;
  settings?: Record<string, any> | null;
  connectedAt?: string | null;
  updatedAt?: string | null;
  lastSync?: string | null;
  lastError?: string | null;
  connectedBy?: { uid: string; email: string } | null;
}

// ─── Order Settings API ──────────────────────────────────────

export interface OrderSettingsData {
  rules?: Array<{ id: string; label: string; enabled: boolean }>;
  carrierRules?: Array<{
    id: string;
    minWeight: number;
    maxWeight: number;
    shippingMethodId: number;
    carrier: string;
    label: string;
    /** Drag-and-drop priority. Lowest number wins on tie-break. */
    order?: number;
  }>;
  statuses?: Array<{ id: string; name: string; description: string; color: string }>;
  numberRanges?: Record<string, { prefix: string; startNumber: string }>;
  templates?: Array<{ id: string; name: string; lastEdited: string }>;
  [key: string]: any;
}

export async function fetchOrderSettings(): Promise<OrderSettingsData> {
  const res = await fetchApi(`${BACKEND_URL}/api/orders/settings`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to load order settings');
  }
  return data?.data || {};
}

export async function saveOrderSettings(settings: OrderSettingsData): Promise<OrderSettingsData> {
  const res = await fetchApi(`${BACKEND_URL}/api/orders/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to save order settings');
  }
  return data?.data || {};
}

// ─── Warehouse Settings API ──────────────────────────────────

export interface WarehouseSettingsData {
  zones?: Array<{ id: string; name: string; type: string; description?: string }>;
  bins?: Array<{ id: string; zone: string; label: string }>;
  [key: string]: any;
}

export async function fetchWarehouseSettings(): Promise<WarehouseSettingsData> {
  const res = await fetchApi(`${BACKEND_URL}/api/warehouse/settings`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to load warehouse settings');
  }
  return data?.data || {};
}

export async function saveWarehouseSettings(settings: WarehouseSettingsData): Promise<WarehouseSettingsData> {
  const res = await fetchApi(`${BACKEND_URL}/api/warehouse/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to save warehouse settings');
  }
  return data?.data || {};
}

// ─── API Keys API ────────────────────────────────────────────

export interface ApiKeyData {
  id: string;
  name: string;
  key: string;
  createdAt?: string;
  lastAccess?: string | null;
}

export async function fetchApiKeys(): Promise<ApiKeyData[]> {
  const res = await fetchApi(`${BACKEND_URL}/api/settings/api-keys`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Failed to load API keys');
  return Array.isArray(data?.data) ? data.data : [];
}

export async function createApiKey(name: string): Promise<ApiKeyData> {
  const res = await fetchApi(`${BACKEND_URL}/api/settings/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Failed to create API key');
  return data?.data;
}

export async function revokeApiKey(id: string): Promise<void> {
  const res = await fetchApi(`${BACKEND_URL}/api/settings/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Failed to revoke API key');
}

// ─── Webhooks API ────────────────────────────────────────────

export interface WebhookData {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  secret?: string;
  createdAt?: string;
}

export async function fetchWebhooks(): Promise<WebhookData[]> {
  const res = await fetchApi(`${BACKEND_URL}/api/settings/webhooks`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Failed to load webhooks');
  return Array.isArray(data?.data) ? data.data : [];
}

export async function createWebhook(webhook: { url: string; events: string[]; active?: boolean }): Promise<WebhookData> {
  const res = await fetchApi(`${BACKEND_URL}/api/settings/webhooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(webhook),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Failed to create webhook');
  return data?.data;
}

export async function deleteWebhook(id: string): Promise<void> {
  const res = await fetchApi(`${BACKEND_URL}/api/settings/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Failed to delete webhook');
}

// ─── Billing Usage API ──────────────────────────────────────

export interface BillingUsageData {
  products: { current: number; max: number };
  orders: { current: number; max: number };
  integrations: { current: number; max: number };
}

export async function fetchBillingUsage(): Promise<BillingUsageData> {
  const res = await fetchApi(`${BACKEND_URL}/api/settings/billing/usage`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Failed to load billing usage');
  return data?.data || { products: { current: 0, max: 5000 }, orders: { current: 0, max: 2000 }, integrations: { current: 0, max: 10 } };
}

export async function fetchIntegrationStatus(): Promise<IntegrationStatusEntry[]> {
  const res = await fetchApi(`${BACKEND_URL}/api/integrations/status?t=${Date.now()}`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to load integration status');
  }
  return Array.isArray(data?.data) ? data.data : [];
}

export async function fetchIntegrationProviders(): Promise<IntegrationProvider[]> {
  const res = await fetchApi(`${BACKEND_URL}/api/integrations/providers`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to load integration providers');
  }
  return Array.isArray(data?.data) ? data.data : [];
}

export async function fetchIntegrationDetail(type: string): Promise<IntegrationDetail> {
  const res = await fetchApi(`${BACKEND_URL}/api/integrations/${type}`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to load integration detail');
  }
  return data?.data || {};
}

export async function connectIntegration(type: string, credentials: Record<string, string>): Promise<{ ok: boolean; testMessage?: string }> {
  const res = await fetchApi(`${BACKEND_URL}/api/integrations/${type}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credentials }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Verbindung fehlgeschlagen');
  }
  return data?.data || { ok: true };
}

export async function testIntegration(type: string, credentials?: Record<string, string>): Promise<{ ok: boolean; message: string }> {
  const res = await fetchApi(`${BACKEND_URL}/api/integrations/${type}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credentials: credentials || null }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Test fehlgeschlagen');
  }
  return data?.data || { ok: false, message: 'Unbekannt' };
}

export async function updateIntegrationSettings(type: string, settings: Record<string, any>): Promise<void> {
  const res = await fetchApi(`${BACKEND_URL}/api/integrations/${type}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Einstellungen konnten nicht gespeichert werden');
  }
}

export async function disconnectIntegration(type: string): Promise<void> {
  const res = await fetchApi(`${BACKEND_URL}/api/integrations/${type}`, { method: 'DELETE' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Trennung fehlgeschlagen');
  }
}

// ─── Shipments API ───────────────────────────────────────────

export interface ShipmentData {
  id: string;
  orderId: string;
  orderNumber?: string | null;
  customer?: string | null;
  carrier?: string;
  trackingNumber?: string | null;
  sendcloudParcelId?: number | string | null;
  status?: string;
  cost?: number;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  createdAt?: string;
  [key: string]: any;
}

export async function fetchShipments(params?: { status?: string; limit?: number }): Promise<ShipmentData[]> {
  const url = new URL(`${BACKEND_URL}/api/shipments`);
  if (params?.status) url.searchParams.set('status', params.status);
  if (params?.limit) url.searchParams.set('limit', String(params.limit));
  const res = await fetchApi(url.toString(), { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Failed to load shipments');
  return Array.isArray(data?.data) ? data.data : [];
}

// ─── Returns API ─────────────────────────────────────────────

export interface ReturnData {
  id: string;
  orderId: string;
  marketplace?: string;
  marketplaceReturnId?: string;
  customer?: { name?: string; email?: string } | string | null;
  product?: { name?: string; sku?: string; quantity?: number } | string | null;
  reason?: string;
  reasonText?: string;
  status?: string;
  refundAmount?: number;
  refundType?: string;
  itemCondition?: string;
  restock?: boolean;
  createdAt?: string;
  [key: string]: any;
}

export async function fetchReturns(params?: { status?: string; limit?: number }): Promise<ReturnData[]> {
  const url = new URL(`${BACKEND_URL}/api/returns`);
  if (params?.status) url.searchParams.set('status', params.status);
  if (params?.limit) url.searchParams.set('limit', String(params.limit));
  const res = await fetchApi(url.toString(), { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Failed to load returns');
  return Array.isArray(data?.data) ? data.data : [];
}

export async function updateReturn(id: string, update: { status?: string; refundAmount?: number }): Promise<any> {
  const res = await fetchApi(`${BACKEND_URL}/api/returns/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Failed to update return');
  return data?.data;
}

export async function syncReturns(): Promise<any> {
  const res = await fetchApi(`${BACKEND_URL}/api/returns/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Retouren-Sync fehlgeschlagen');
  return data?.data;
}

export async function processReturn(
  id: string,
  opts: { itemCondition: string; refundType: string; refundAmount?: number; note?: string }
): Promise<any> {
  const res = await fetchApi(`${BACKEND_URL}/api/returns/${encodeURIComponent(id)}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Retoure verarbeiten fehlgeschlagen');
  return data?.data;
}

export async function issueReturnRefund(id: string): Promise<any> {
  const res = await fetchApi(`${BACKEND_URL}/api/returns/${encodeURIComponent(id)}/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Erstattung fehlgeschlagen');
  return data?.data;
}

export async function closeReturn(id: string, note?: string): Promise<any> {
  const res = await fetchApi(`${BACKEND_URL}/api/returns/${encodeURIComponent(id)}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Retoure schließen fehlgeschlagen');
  return data?.data;
}

export interface BulkReturnActionResult {
  total: number;
  success: number;
  results: { returnId: string; ok: boolean; error?: string }[];
}

export async function bulkReturnAction(
  returnIds: string[],
  action: "refund" | "close",
  note?: string
): Promise<BulkReturnActionResult> {
  const res = await fetchApi(`${BACKEND_URL}/api/returns/bulk-action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ returnIds, action, note }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || "Bulk action failed");
  return data?.data;
}

export async function fetchReturnEvents(id: string): Promise<any[]> {
  const res = await fetchApi(`${BACKEND_URL}/api/returns/${encodeURIComponent(id)}/events`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Events laden fehlgeschlagen');
  return Array.isArray(data?.data) ? data.data : [];
}

// ─── Invoices API ────────────────────────────────────────────

export interface InvoiceData {
  id: string;
  orderId?: string;
  invoiceNumber?: string;
  date?: string;
  customer?: string | null;
  amountNet?: number;
  amountGross?: number;
  status?: string;
  dueDate?: string | null;
  createdAt?: string;
  [key: string]: any;
}

export async function fetchInvoices(params?: { status?: string; limit?: number }): Promise<InvoiceData[]> {
  const url = new URL(`${BACKEND_URL}/api/invoices`);
  if (params?.status) url.searchParams.set('status', params.status);
  if (params?.limit) url.searchParams.set('limit', String(params.limit));
  const res = await fetchApi(url.toString(), { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Failed to load invoices');
  const invoices: InvoiceData[] = Array.isArray(data?.data) ? data.data : [];
  // Normalize dual field names (backend writes amountNetto/amountBrutto in older invoices)
  for (const inv of invoices) {
    inv.amountNet = inv.amountNet ?? (inv as any).amountNetto ?? 0;
    inv.amountGross = inv.amountGross ?? (inv as any).amountBrutto ?? 0;
  }
  return invoices;
}

export async function updateInvoiceStatus(id: string, status: string): Promise<any> {
  const res = await fetchApi(`${BACKEND_URL}/api/invoices/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Failed to update invoice');
  return data?.data;
}

export async function downloadInvoicePdfBlob(invoiceId: string): Promise<Blob> {
  const res = await fetchApi(
    `${BACKEND_URL}/api/invoices/${encodeURIComponent(invoiceId)}/download`,
    { method: 'GET' }
  );
  if (!res.ok) {
    const errData = await res.json().catch(() => null);
    throw new Error(errData?.error?.message || `Rechnungs-PDF Download fehlgeschlagen (${res.status})`);
  }
  return res.blob();
}

// ── Stock Sync Status ──

export interface SyncChannelStatus {
  lastSync: string | null;
  successCount: number;
  errorCount: number;
  totalCount: number;
}

export interface SyncStatusData {
  channels: Record<string, SyncChannelStatus>;
  reservations: { count: number; totalQuantity: number };
  summary: { totalSyncs: number; totalErrors: number; pendingFailures?: number | null; since: string };
  generatedAt: string;
}

export async function fetchSyncStatus(): Promise<SyncStatusData> {
  const res = await fetchApi(`${BACKEND_URL}/api/sync/status`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Failed to load sync status');
  return data?.data as SyncStatusData;
}

export async function fetchEbayStatus(): Promise<EbayConnectionStatus> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/status?t=${Date.now()}`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to load eBay status');
  }
  return (data?.data || { connected: false }) as EbayConnectionStatus;
}

export type EbayRateLimitStatus = {
  lastSecond: number;
  lastHour: number;
  lastDay: number;
  limits: { perSecond: number; perHour: number; perDay: number };
  queueLength: number;
};

export async function fetchEbayRateLimitStatus(): Promise<EbayRateLimitStatus> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/rate-limit-status?t=${Date.now()}`, { method: "GET" });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || "Failed to load eBay rate limit status");
  }
  return data?.data as EbayRateLimitStatus;
}

export async function fetchEbayTradingStatus(): Promise<EbayTradingStatus> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/trading/status?t=${Date.now()}`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to load eBay Trading status');
  }
  return (data?.data || { connected: false }) as EbayTradingStatus;
}

export async function importEbayMipCsv(file: File): Promise<any> {
  if (!file) throw new Error('CSV file missing');
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/listings/import/mip`, {
    method: 'POST',
    body: form,
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to import eBay CSV');
  }
  return data?.data;
}

export async function fetchEbayOffersBySku(sku: string): Promise<any> {
  const url = new URL(`${BACKEND_URL}/api/ebay/offers`);
  url.searchParams.set('sku', String(sku || '').trim());
  const res = await fetchApi(url.toString(), { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to fetch eBay offers');
  }
  return data?.data;
}

export async function fetchEbayListingBySku(sku: string): Promise<any> {
  const key = encodeURIComponent(String(sku || '').trim());
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/listings/${key}?t=${Date.now()}`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to load eBay listing');
  }
  return data?.data;
}

export async function syncEbayLiveListings(payload?: {
  maxPages?: number;
  entriesPerPage?: number;
  detailConcurrency?: number;
  timeoutMs?: number;
  runId?: string;
}): Promise<any> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/listings/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to sync eBay listings');
  }
  return data?.data;
}

export async function repairEbayListings(): Promise<{ repaired: number; skipped: number }> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/listings/repair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to repair eBay listings');
  }
  return data?.data;
}

export type StockResyncBatchResult = {
  total: number;
  resolved: number;
  failed: number;
  notFound: number;
  results: Array<{ sku?: string; productId?: string; ok: boolean; error?: string }>;
};

/**
 * Force-resync Firestore-Bestand an eBay + Kaufland fuer N SKUs/productIds.
 * Sequenziell im Backend (schont Rate-Limits). Max 200 pro Call.
 * Siehe CLAUDE.md Punkt 10 (Oversell-Verbot).
 */
export async function forceResyncStockBatch(payload: {
  skus?: string[];
  productIds?: string[];
  tenantId?: string;
  reason?: string;
}): Promise<StockResyncBatchResult> {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/stock/force-resync-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || "Failed to batch-resync stock");
  }
  return data?.data;
}

export async function lightSyncEbayLiveListings(payload?: {
  maxPages?: number;
  entriesPerPage?: number;
  timeoutMs?: number;
  runId?: string;
}): Promise<any> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/listings/light-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to light-sync eBay listings');
  }
  return data?.data;
}

export async function fetchEbayLiveListings(params?: {
  limit?: number;
  search?: string;
  matchStatus?: string;
  includeInactive?: boolean;
}): Promise<EbayListingRow[]> {
  const url = new URL(`${BACKEND_URL}/api/ebay/listings`);
  if (params?.limit) url.searchParams.set('limit', String(params.limit));
  if (params?.search) url.searchParams.set('search', params.search);
  if (params?.matchStatus) url.searchParams.set('matchStatus', params.matchStatus);
  if (params?.includeInactive) url.searchParams.set('includeInactive', 'true');
  const res = await fetchApi(url.toString(), { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to load eBay live listings');
  }
  return Array.isArray(data?.data) ? (data.data as EbayListingRow[]) : [];
}

export async function fetchEbayLiveListingDetail(itemId: string): Promise<EbayListingDetail> {
  const key = encodeURIComponent(String(itemId || '').trim());
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/listings/${key}/detail?t=${Date.now()}`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to load eBay listing detail');
  }
  return data?.data as EbayListingDetail;
}

export async function rebuildEbayListingLinks(payload?: { itemIds?: string[]; runId?: string }): Promise<any> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/listing-links/rebuild`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to rebuild eBay listing links');
  }
  return data?.data;
}

export async function fetchEbayListingLinks(limit = 200): Promise<any[]> {
  const url = new URL(`${BACKEND_URL}/api/ebay/listing-links`);
  url.searchParams.set('limit', String(limit));
  const res = await fetchApi(url.toString(), { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to load eBay listing links');
  }
  return Array.isArray(data?.data) ? data.data : [];
}

export async function fetchEbaySkuIndex(): Promise<{ sku: string | null; itemId: string; productId: string | null; viewItemUrl: string | null }[]> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/sku-index`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to load eBay SKU index');
  }
  return Array.isArray(data?.data) ? data.data : [];
}

export async function syncKauflandListings(storefront = 'de'): Promise<{ storefront: string; fetched: number; active: number }> {
  const res = await fetchApi(`${BACKEND_URL}/api/kaufland/listings/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storefront }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to sync Kaufland listings');
  }
  return data?.data || { storefront, fetched: 0, active: 0 };
}

export async function fetchKauflandSkuIndex(storefront = 'de'): Promise<{
  idUnit: string;
  sku: string | null;
  skuNormalized: string | null;
  ean: string | null;
  eans: string[];
  status: string | null;
  idProduct: number | null;
  viewItemUrl: string | null;
}[]> {
  const url = new URL(`${BACKEND_URL}/api/kaufland/sku-index`);
  url.searchParams.set('storefront', storefront);
  const res = await fetchApi(url.toString(), { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to load Kaufland SKU index');
  }
  return Array.isArray(data?.data) ? data.data : [];
}


export interface KauflandListingRow {
  idUnit: string;
  sku: string | null;
  ean: string | null;
  status: string | null;
  active: boolean;
  /**
   * Kaufland `product.is_valid` boolean as cached by the validity-refresh
   * phase of the listings sync. `true` = Portal "Aktiv" (Live), `false` =
   * "Indexierung läuft" (typically <24h after first publish), `null` = legacy
   * doc / validity not yet checked → fall back to the binary `active` flag.
   */
  productValid?: boolean | null;
  quantity: number | null;
  idProduct: number | null;
  viewItemUrl: string | null;
  updatedAt: string | null;
  productId: string | null;
  title: string | null;
  brand: string | null;
  /**
   * Primary display price = Kaufland's current customer-facing sell price
   * (`currentPrice` if available, else `listingPrice`, else matched product's
   * sellPrice). Matches what the Seller Portal shows as the active price.
   */
  price: number | null;
  /** Current customer-facing sell price set by Kaufland's auto-pricer */
  currentPrice?: number | null;
  /** Max price set by seller (upper bound for the auto-pricer) */
  listingPrice?: number | null;
  /** Min price floor (auto-pricer won't undercut below this) */
  minimumPrice?: number | null;
  imageUrl: string | null;
  category: string | null;
  warehouseStock?: number | null;
  binLocation?: string | null;
  stockMismatch?: boolean;
}

export async function fetchKauflandListings(storefront = 'de'): Promise<KauflandListingRow[]> {
  const url = new URL(`${BACKEND_URL}/api/kaufland/listings`);
  url.searchParams.set('storefront', storefront);
  const res = await fetchApi(url.toString(), { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to load Kaufland listings');
  }
  return Array.isArray(data?.data) ? data.data : [];
}

export async function bulkUpdateEbayListings(params: {
  itemIds?: string[];
  applyAll?: boolean;
}): Promise<{
  summary: { total: number; success: number; failed: number; skipped: number };
  results: any[];
  dryRun: any;
}> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/update/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to bulk update eBay listings');
  }
  return data?.data;
}

export async function endEbayListing(params: {
  itemId: string;
  reason?: string;
}): Promise<{ ack: string; itemId: string; endTime: string | null; warnings?: any[] }> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/listings/end`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || "Failed to end eBay listing");
  }
  return data?.data;
}

export async function rebuildEbayGaps(payload?: { itemIds?: string[]; runId?: string }): Promise<any> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/gaps/rebuild`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to rebuild eBay gaps');
  }
  return data?.data;
}

export async function fetchEbayGaps(params?: {
  limit?: number;
  status?: string;
  severity?: string;
  itemId?: string;
}): Promise<EbayGapDoc[]> {
  const url = new URL(`${BACKEND_URL}/api/ebay/gaps`);
  if (params?.limit) url.searchParams.set('limit', String(params.limit));
  if (params?.status) url.searchParams.set('status', params.status);
  if (params?.severity) url.searchParams.set('severity', params.severity);
  if (params?.itemId) url.searchParams.set('itemId', params.itemId);
  const res = await fetchApi(url.toString(), { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to load eBay gaps');
  }
  return Array.isArray(data?.data) ? (data.data as EbayGapDoc[]) : [];
}

export async function applyEbayGapAction(
  itemId: string,
  payload: { gapId: string; action: string; note?: string; alias?: Record<string, any> }
): Promise<any> {
  const key = encodeURIComponent(String(itemId || '').trim());
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/gaps/${key}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to update eBay gap');
  }
  return data?.data;
}

export async function bulkApplyEbayGapActions(
  itemId: string,
  payload: { gapIds: string[]; action: string; note?: string; alias?: Record<string, any> }
): Promise<any> {
  const key = encodeURIComponent(String(itemId || '').trim());
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/gaps/${key}/bulk-actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to update selected eBay gaps');
  }
  return data?.data;
}

export async function bulkPrepareEbayItemSpecifics(
  itemIds?: string[],
  mode: 'missing_ebay' | 'different' | 'all' = 'all'
): Promise<any> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/gaps/bulk-prepare-item-specifics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemIds: Array.isArray(itemIds) ? itemIds : null, mode }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to bulk-prepare item specifics');
  }
  return data?.data;
}

export async function bulkPrepareEbayMissingSpecifics(itemIds?: string[]): Promise<any> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/gaps/bulk-prepare-missing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemIds: Array.isArray(itemIds) ? itemIds : null, mode: 'missing_ebay' }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to bulk-prepare missing specifics');
  }
  return data?.data;
}

export async function runEbaySyncDryRun(itemIds?: string[]): Promise<EbaySyncDryRunResult> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/sync/dry-run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemIds: Array.isArray(itemIds) ? itemIds : null }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to run eBay sync dry-run');
  }
  return data?.data as EbaySyncDryRunResult;
}

export async function runEbaySyncApply(itemIds?: string[]): Promise<EbaySyncApplyResult> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/sync/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemIds: Array.isArray(itemIds) ? itemIds : null }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to apply eBay sync');
  }
  return data?.data as EbaySyncApplyResult;
}

// --- eBay Publish (AddFixedPriceItem) ---

export async function verifyEbayPublish(
  productId: string,
  overrides?: EbayPublishOverrides
): Promise<EbayPublishVerifyResult> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/publish/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId, overrides: overrides || {} }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to verify eBay publish');
  }
  return data?.data as EbayPublishVerifyResult;
}

// --- AI Listing Pipeline ---

export interface ChannelListing {
  title: string;
  description: string;
  categoryId: string;
  categoryName: string;
  attributes: Record<string, string>;
  validation: { ready: boolean; issues: { severity: string; message: string }[] };
}

export interface ListingPipelineResult {
  productId: string;
  listings: {
    ebay?: ChannelListing;
    kaufland?: ChannelListing;
  };
  generated_at: string;
}

export async function runListingPipeline(
  productId: string,
  channels?: string[]
): Promise<ListingPipelineResult> {
  const body: Record<string, unknown> = { productId };
  if (channels) body.channels = channels;

  const res = await fetchApi(`${BACKEND_URL}/api/products/listing-pipeline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || "Listing pipeline failed");
  }
  return data?.data as ListingPipelineResult;
}

export async function publishToEbay(
  productId: string,
  overrides?: EbayPublishOverrides
): Promise<EbayPublishResult> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId, overrides: overrides || {} }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to publish to eBay');
  }
  const result = data?.data as EbayPublishResult;
  if (result && result.ok === false && Array.isArray(result.blockers) && result.blockers.length > 0) {
    const err: any = new Error(result.blockers.join(' | '));
    err.blockers = result.blockers;
    throw err;
  }
  return result;
}

export async function publishToKaufland(
  productId: string,
  storefront = 'de'
): Promise<{ idUnit: number | null; storefront: string }> {
  const res = await fetchApi(`${BACKEND_URL}/api/kaufland/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId, storefront }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to publish to Kaufland');
  }
  return data?.data;
}

export async function bulkVerifyEbayPublish(
  productIds: string[],
  overrides?: EbayPublishOverrides
): Promise<EbayBulkPublishVerifyResult> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/publish/bulk/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productIds, overrides: overrides || {} }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to bulk verify eBay publish');
  }
  return data?.data as EbayBulkPublishVerifyResult;
}

export async function bulkPublishToEbay(
  productIds: string[],
  overrides?: EbayPublishOverrides
): Promise<EbayBulkPublishResult> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/publish/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productIds, overrides: overrides || {} }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to bulk publish to eBay');
  }
  return data?.data as EbayBulkPublishResult;
}

export interface BulkPublishResult {
  summary: { total: number; success: number; failed: number };
  results: Array<{ productId: string; ok: boolean; error?: string }>;
}

export async function bulkPublishToKaufland(
  productIds: string[],
  storefront = 'de',
  overrides?: Record<string, any>
): Promise<BulkPublishResult> {
  const res = await fetchApi(`${BACKEND_URL}/api/kaufland/publish/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productIds, storefront, overrides: overrides || {} }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to bulk publish to Kaufland');
  }
  return data?.data as BulkPublishResult;
}

export async function bulkUpdateKauflandUnits(
  unitIds: string[]
): Promise<{ total: number; success: number; failed: number; results: Array<{ unitId: string; ok: boolean; error?: string }> }> {
  const res = await fetchApi(`${BACKEND_URL}/api/kaufland/units/bulk-update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unitIds }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || "Failed to bulk update Kaufland units");
  }
  return data?.data;
}

export async function bulkSetKauflandUnitStatus(
  unitIds: string[],
  status: "AVAILABLE" | "ONHOLD"
): Promise<{ total: number; success: number; failed: number; results: Array<{ unitId: string; ok: boolean; error?: string }> }> {
  const res = await fetchApi(`${BACKEND_URL}/api/kaufland/units/bulk-status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unitIds, status }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || "Failed to set Kaufland unit status");
  }
  return data?.data;
}

// ─── Integration Settings ────────────────────────────────────────────────

export interface IntegrationConfig {
  tenantId: string;
  integration: string;
  cachedData: Record<string, any>;
  defaults: Record<string, any>;
  lastSyncedAt: string | null;
  syncError?: string;
}

export async function fetchIntegrationConfig(integration: string): Promise<IntegrationConfig> {
  const res = await fetchApi(`${BACKEND_URL}/api/integrations/${integration}/config`);
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || `Failed to load ${integration} config`);
  }
  return data?.data as IntegrationConfig;
}

export async function syncIntegration(integration: string): Promise<IntegrationConfig> {
  const res = await fetchApi(`${BACKEND_URL}/api/integrations/${integration}/sync`, {
    method: "POST",
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || `Failed to sync ${integration}`);
  }
  return data?.data as IntegrationConfig;
}

export async function saveIntegrationDefaults(
  integration: string,
  defaults: Record<string, any>
): Promise<IntegrationConfig> {
  const res = await fetchApi(`${BACKEND_URL}/api/integrations/${integration}/defaults`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ defaults }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || `Failed to save ${integration} defaults`);
  }
  return data?.data as IntegrationConfig;
}

export async function generateEbayReports(outDir?: string): Promise<any> {
  const res = await fetchApi(`${BACKEND_URL}/api/ebay/reports/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outDir: outDir || null }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to generate eBay reports');
  }
  return data?.data;
}

// --- Public Auth API ---
export const requestPasswordReset = async (email: string) => {
  const res = await fetchApi(`${BACKEND_URL}/api/auth/password-reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Passwort-Reset konnte nicht gesendet werden.');
  }
  return true;
};

export async function fetchCategoryProfile(categoryId: string) {
  const url = new URL(`${BACKEND_URL}/api/categories/profiles`);
  url.searchParams.set('ids', String(categoryId || '').trim());
  const res = await fetchApi(url.toString(), { method: 'GET' });
  const data = await parseResponse(res);
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.find((x: any) => String(x?.id) === String(categoryId)) || null;
}

export async function saveCategoryProfile(categoryId: string, payload: any) {
  const url = new URL(`${BACKEND_URL}/api/categories/profiles/${encodeURIComponent(String(categoryId || '').trim())}`);
  const res = await fetchApi(url.toString(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || 'Failed to save category profile');
  }
  return data;
}

// --- Admin API ---
export type AdminUserRecord = {
  id: string;
  uid?: string;
  email?: string | null;
  roles?: string[];
  disabled?: boolean;
  firstName?: string;
  lastName?: string;
  username?: string;
  displayName?: string;
  createdAt?: any;
  updatedAt?: any;
};

export type AdminRoleRecord = {
  id: string;
  name?: string;
  roleId?: string;
  permissions?: Record<string, Record<string, boolean>>;
};

export type AdminGroupRecord = {
  id: string;
  groupId?: string;
  name?: string;
  roleIds?: string[];
};

export type AdminLlmScopeRecord = {
  id: string;
  scopeId?: string;
  name?: string;
  purpose?: string;
  defaultModelEnvKey?: string;
  activeVersionId?: string | null;
};

export type AdminLlmThinkingLevel = '' | 'none' | 'low' | 'medium' | 'high';
export type AdminLlmMediaResolution = '' | 'LOW' | 'MEDIUM' | 'HIGH';

export type AdminLlmGenerationConfig = {
  temperature?: number | null;
  maxOutputTokens?: number | null;
  thinkingConfig?: { level?: AdminLlmThinkingLevel } | null;
  mediaResolution?: AdminLlmMediaResolution | null;
};

export type AdminLlmScopeVersionInput = {
  promptText: string;
  rulesText: string;
  promptMode?: 'append' | 'replace';
  rulesMode?: 'append' | 'replace';
  note?: string;
  // F.1a additive fields (backend backfills defaults if omitted)
  userTemplate?: string;
  outputSchemaHint?: string;
  modelOverride?: string;
  generationConfig?: AdminLlmGenerationConfig;
};

export type AdminLlmScopeDetail = {
  scope: AdminLlmScopeRecord;
  versions: Array<{
    id: string;
    promptText?: string;
    rulesText?: string;
    promptMode?: 'append' | 'replace';
    rulesMode?: 'append' | 'replace';
    note?: string | null;
    userTemplate?: string | null;
    outputSchemaHint?: string | null;
    modelOverride?: string | null;
    generationConfig?: AdminLlmGenerationConfig | null;
    createdByUid?: string | null;
    createdAt?: any;
  }>;
};

export type AdminJobRunResult = {
  name?: string;
  done?: boolean;
  metadata?: any;
  response?: any;
  error?: any;
};

export const adminRunGpsrWebEnrichJob = async (params?: {
  apply?: boolean;
  limit?: number;
  concurrency?: number;
  minQty?: number;
  requireBin?: boolean;
  debug?: boolean;
}): Promise<AdminJobRunResult> => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/jobs/gpsr-web-enrich/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to run GPSR Cloud Run Job');
  }
  return (result?.data || {}) as AdminJobRunResult;
};

export const adminGetJobsStatus = async (): Promise<any> => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/jobs/status`, { method: 'GET' });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to load admin jobs status');
  }
  return result?.data;
};

export type AdminBulkActionName = 'title' | 'price' | 'category' | 'ktype' | 'export_marketplace';

export const adminRunBulkAction = async (params: {
  action: AdminBulkActionName;
  apply?: boolean;
  limit?: number;
  offset?: number;
  debug?: boolean;
  maxAgeDays?: number; // price
  includeUi?: boolean; // title
}): Promise<{ jobId: string }> => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/bulk/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to enqueue bulk job');
  }
  const jobId = result?.data?.jobId;
  if (!jobId) {
    throw new Error('Bulk job enqueued but jobId missing');
  }
  return { jobId };
};

export const adminGetBulkJob = async (jobId: string): Promise<any> => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/bulk/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to load bulk job');
  }
  return result?.data;
};

export type ProductBulkActionName =
  | 'title'
  | 'title_cleanup'
  | 'highlights_html'
  | 'description_html'
  | 'listing_readiness'
  | 'price'
  | 'category'
  | 'ktype'
  | 'validate'
  | 'kaufland_create'
  | 'kaufland_update'
  | 'export_marketplace';

export const runProductBulkAction = async (params: {
  action: ProductBulkActionName;
  productIds: string[];
  apply?: boolean; // default true
  debug?: boolean;
  maxAgeDays?: number; // price
  force?: boolean; // price
  includeUi?: boolean; // title
  inventoryId?: string; // optional override for text-only sync jobs
  storefront?: string; // optional storefront selector for Kaufland actions (default: de)
}): Promise<{ jobId: string }> => {
  const res = await fetchApi(`${BACKEND_URL}/api/products/bulk/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to enqueue product bulk job');
  }
  const jobId = result?.data?.jobId;
  if (!jobId) throw new Error('Bulk job enqueued but jobId missing');
  return { jobId };
};

export const getProductBulkJob = async (jobId: string): Promise<any> => {
  const res = await fetchApi(`${BACKEND_URL}/api/products/bulk/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to load product bulk job');
  }
  return result?.data;
};

export const adminListUsers = async (limit = 500): Promise<AdminUserRecord[]> => {
  const url = new URL(`${BACKEND_URL}/api/admin/users`);
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 1000)));
  const res = await fetchApi(url.toString(), { method: 'GET' });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to list users');
  }
  return Array.isArray(result?.data) ? (result.data as AdminUserRecord[]) : [];
};

export const adminInviteUser = async (email: string, roles: string[] = []) => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, roles }),
  });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to invite user');
  }
  return result?.data;
};

export const adminSetUserRoles = async (uid: string, roles: string[]) => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/users/${encodeURIComponent(uid)}/roles`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roles }),
  });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to update user roles');
  }
  return true;
};

export const adminSetUserProfile = async (
  uid: string,
  profile: { firstName?: string; lastName?: string; username?: string }
) => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/users/${encodeURIComponent(uid)}/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || "Fehler beim Speichern des Namens");
  }
  return result?.data as AdminUserRecord;
};

export const adminDeleteUser = async (uid: string) => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/users/${encodeURIComponent(uid)}`, {
    method: "DELETE",
  });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || "Fehler beim Löschen des Kontos");
  }
  return true;
};

export type PerformanceRow = {
  uid: string;
  name: string;
  email?: string | null;
  erfasst: number;
  angereichert: number;
  eingelagert: number;
  kommissioniert: number;
  verpackt: number;
};

export const adminGetPerformance = async (
  range: "today" | "week" | "month" = "week",
  custom?: { from: string; to: string }
): Promise<{ range: string; rows: PerformanceRow[] }> => {
  const params = new URLSearchParams({ range });
  if (custom?.from && custom?.to) {
    params.set("from", custom.from);
    params.set("to", custom.to);
  }
  const res = await fetchApi(`${BACKEND_URL}/api/admin/performance?${params.toString()}`);
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || "Leistung konnte nicht geladen werden");
  }
  return (result?.data as { range: string; rows: PerformanceRow[] }) || { range, rows: [] };
};

// ── Interne Produkt-Notizen (Mitarbeiter-Kommentare, nie in Marktplatz-Angeboten) ──
export type ProductNote = {
  id: string;
  productId: string;
  userId?: string | null;
  userEmail?: string | null;
  userName?: string | null;
  text: string;
  createdAt: string;
};

export const listProductNotes = async (productId: string): Promise<ProductNote[]> => {
  const res = await fetchApi(`${BACKEND_URL}/api/products/${encodeURIComponent(productId)}/notes`);
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || "Notizen konnten nicht geladen werden");
  }
  return Array.isArray(result?.data) ? (result.data as ProductNote[]) : [];
};

export const addProductNote = async (productId: string, text: string): Promise<ProductNote> => {
  const res = await fetchApi(`${BACKEND_URL}/api/products/${encodeURIComponent(productId)}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || "Notiz konnte nicht gespeichert werden");
  }
  return result?.data as ProductNote;
};

// Admin-only: wer hat welches Produkt erfasst (uid + Anzeigename).
export const getProductsIdentifiedByMap = async (): Promise<Record<string, { uid: string; name: string }>> => {
  const res = await fetchApi(`${BACKEND_URL}/api/products/identified-by`);
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) return {};
  return (result?.data as Record<string, { uid: string; name: string }>) || {};
};

export const getProductNotesCounts = async (): Promise<Record<string, number>> => {
  const res = await fetchApi(`${BACKEND_URL}/api/products/notes-counts`);
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) return {};
  return (result?.data as Record<string, number>) || {};
};

export const adminSetUserGroups = async (uid: string, groupIds: string[]) => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/users/${encodeURIComponent(uid)}/groups`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupIds }),
  });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to update user groups');
  }
  return true;
};

export const adminSetUserOverrides = async (
  uid: string,
  overrides: { allow?: Record<string, Record<string, boolean>>; deny?: Record<string, Record<string, boolean>> }
) => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/users/${encodeURIComponent(uid)}/overrides`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overrides }),
  });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to update user overrides');
  }
  return true;
};

export const adminListGroups = async (limit = 200): Promise<AdminGroupRecord[]> => {
  const url = new URL(`${BACKEND_URL}/api/admin/groups`);
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 1000)));
  const res = await fetchApi(url.toString(), { method: 'GET' });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to list groups');
  }
  return Array.isArray(result?.data) ? (result.data as AdminGroupRecord[]) : [];
};

export const adminCreateGroup = async (payload: { name: string; groupId?: string; roleIds?: string[] }) => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to create group');
  }
  return result?.data;
};

export const adminUpdateGroup = async (groupId: string, patch: Partial<AdminGroupRecord>) => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/groups/${encodeURIComponent(groupId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch || {}),
  });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to update group');
  }
  return true;
};

export const adminDeleteGroup = async (groupId: string) => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/groups/${encodeURIComponent(groupId)}`, {
    method: 'DELETE',
  });
  if (res.status === 204) return true;
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to delete group');
  }
  return true;
};

export const adminListLlmScopes = async (): Promise<AdminLlmScopeRecord[]> => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/llm/scopes`, { method: 'GET' });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to list LLM scopes');
  }
  return Array.isArray(result?.data) ? (result.data as AdminLlmScopeRecord[]) : [];
};

export const adminGetLlmScope = async (scopeId: string): Promise<AdminLlmScopeDetail> => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/llm/scopes/${encodeURIComponent(scopeId)}`, { method: 'GET' });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to load LLM scope');
  }
  return result?.data as AdminLlmScopeDetail;
};

export const adminCreateLlmVersion = async (
  scopeId: string,
  version: AdminLlmScopeVersionInput
) => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/llm/scopes/${encodeURIComponent(scopeId)}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(version),
  });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to create LLM version');
  }
  return result?.data;
};

export const adminActivateLlmVersion = async (scopeId: string, versionId: string) => {
  const res = await fetchApi(
    `${BACKEND_URL}/api/admin/llm/scopes/${encodeURIComponent(scopeId)}/activate/${encodeURIComponent(versionId)}`,
    { method: 'POST' }
  );
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to activate version');
  }
  return true;
};

export const adminListRoles = async (): Promise<AdminRoleRecord[]> => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/roles`, { method: 'GET' });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to list roles');
  }
  return Array.isArray(result?.data) ? (result.data as AdminRoleRecord[]) : [];
};

export const adminUpdateRole = async (roleId: string, patch: Partial<AdminRoleRecord>) => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/roles/${encodeURIComponent(roleId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch || {}),
  });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to update role');
  }
  return true;
};

export type AdminRulebookConfig = {
  version?: number;
  title?: {
    minLen?: number;
    softMaxLen?: number;
    maxLen?: number;
    mobileMaxLen?: number;
    marketingWords?: string[];
    rulesBySchema?: Record<string, { minLen: number; softMaxLen: number; maxLen: number; mobileMaxLen: number }>;
  };
  highlights?: {
    rulesBySchema?: Record<string, { min: number; max: number; minLen: number; maxLen: number }>;
    requireDashTemplate?: boolean;
  };
  attributes?: { canonicalKeyMap?: Record<string, string> };
};

export const adminGetRulebook = async () => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/rulebook`, { method: 'GET' });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to load rulebook');
  }
  return result?.data as {
    id: string;
    versionId: string | null;
    config: AdminRulebookConfig;
    updatedAt: string | null;
    updatedBy: string | null;
    note: string | null;
  };
};

export const adminUpdateRulebook = async (payload: { config: AdminRulebookConfig; note?: string }) => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/rulebook`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to update rulebook');
  }
  return result?.data;
};

export const adminApplyRulebook = async (
  payload: { inventoryId?: string; limit?: number; chunkSize?: number; minQty?: number; requireBin?: boolean } = {}
) => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/rulebook/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to run rulebook apply job');
  }
  return result?.data as { jobId: string };
};

export const adminGetRulebookApplyJob = async (jobId: string) => {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/rulebook/apply/${encodeURIComponent(jobId)}`, { method: 'GET' });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Failed to load rulebook job');
  }
  return result?.data as any;
};

export type AdminProductCoverageMetrics = {
  totalProducts: number;
  title: {
    policyOkCount: number;
    policyNotOkCount: number;
    idealLenOkCount: number;
    idealMinLen: number;
    idealMaxLen: number;
    hardMaxLen: number;
    mobileMaxLen: number;
  };
  ktyp: { withValue: number; fitmentTotal: number };
  gpsr: {
    requiredFields: string[];
    requiredFilledHistogram: Record<string, number>;
    requiredFilledHistogramIncludingPlaceholders?: Record<string, number>;
    anyFieldPresent: number;
    fullRequiredFieldsPresent: number;
    fullRequiredFieldsNoPlaceholders: number;
    candidatesNeedingEnrich: number;
  };
  price?: {
    minPrice: number | null;
    maxPrice: number | null;
    missingCount: number;
    okCount: number;
    outOfRangeCount: number;
  };
  categories?: {
    mainCategoryCounts: Record<string, number>;
  };
  buckets?: {
    titleOkIds?: string[];
    titleNotOkIds?: string[];
    titleNotIdealLenIds?: string[];
    ktypWithValueIds?: string[];
    ktypMissingInFitmentIds?: string[];
    gpsrFilledCountIds?: Record<string, string[]>;
    gpsrFilledCountInclPlaceholdersIds?: Record<string, string[]>;
    gpsrFullRequiredIds?: string[];
    gpsrFullRequiredNoPlaceholdersIds?: string[];
    gpsrCandidatesNeedingEnrichIds?: string[];
    priceMissingIds?: string[];
    priceOkIds?: string[];
    priceOutOfRangeIds?: string[];
    mainCategoryIds?: Record<string, string[]>;
  };
};

export const adminGetProductCoverageMetrics = async (params?: {
  minPrice?: number | string | null;
  maxPrice?: number | string | null;
}): Promise<AdminProductCoverageMetrics> => {
  const url = new URL(`${BACKEND_URL}/api/admin/metrics/product-coverage`);
  const min = params?.minPrice;
  const max = params?.maxPrice;
  if (min != null && String(min).trim() !== '') url.searchParams.set('minPrice', String(min).trim());
  if (max != null && String(max).trim() !== '') url.searchParams.set('maxPrice', String(max).trim());
  const res = await fetchApi(url.toString(), { method: 'GET' });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    const message = result?.error?.message || 'Failed to load product coverage metrics';
    const details = result?.error?.details;
    throw new Error(details ? `${message} (${String(details)})` : message);
  }
  return result?.data as AdminProductCoverageMetrics;
};

// =====================================================================
// Identify-Runs Audit + LLM-Parity (Plan D.1 + F.4b — additive read-only)
// =====================================================================

export type AdminIdentifyRunWorker = {
  confidence: number | null;
  ok: boolean | null;
  retriesRequested: number | null;
  sources: string[];
};

export type AdminIdentifyRunCassiniSubscores = {
  overall: number | null;
  title: number | null;
  description: number | null;
  image: number | null;
  specifics: number | null;
  compliance: number | null;
} | null;

export type AdminIdentifyRunIssue = {
  rule?: string;
  severity?: string;
  message?: string;
  leitfaden_section?: string;
  [key: string]: unknown;
};

export type AdminIdentifyRun = {
  pipeline: "v3" | "v4" | null;
  productId: string | null;
  sku: string | null;
  checkedAtIso: string | null;
  confidence: {
    aggregate: number | null;
    readyForPublish: boolean | null;
    missingCritical: string[];
  };
  workerSummary: Record<string, AdminIdentifyRunWorker>;
  criticScore: number | null;
  cassiniSubscores: AdminIdentifyRunCassiniSubscores;
  issues: AdminIdentifyRunIssue[];
  conflicts: unknown[];
  autosaved?: boolean | null;
  raw?: Record<string, unknown>;
};

export type AdminIdentifyRunsResponse = {
  runs: AdminIdentifyRun[];
  total: number;
  page: number;
  pageSize: number;
};

export type AdminIdentifyRunsFilters = {
  confidence_min?: number | null;
  confidence_max?: number | null;
  cassini_min?: number | null;
  cassini_max?: number | null;
  domain?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  pipeline?: "v3" | "v4" | "all" | null;
  page?: number | null;
  pageSize?: number | null;
};

export const adminListIdentifyRuns = async (
  filters?: AdminIdentifyRunsFilters
): Promise<AdminIdentifyRunsResponse> => {
  const url = new URL(`${BACKEND_URL}/api/admin/identify-runs`);
  const f = filters || {};
  if (f.confidence_min != null) url.searchParams.set("confidence_min", String(f.confidence_min));
  if (f.confidence_max != null) url.searchParams.set("confidence_max", String(f.confidence_max));
  // cassini_min/max are accepted by client but server-side filtering happens in-memory.
  if (f.cassini_min != null) url.searchParams.set("cassini_min", String(f.cassini_min));
  if (f.cassini_max != null) url.searchParams.set("cassini_max", String(f.cassini_max));
  if (f.domain) url.searchParams.set("domain", String(f.domain));
  if (f.dateFrom) url.searchParams.set("dateFrom", String(f.dateFrom));
  if (f.dateTo) url.searchParams.set("dateTo", String(f.dateTo));
  if (f.pipeline) url.searchParams.set("pipeline", String(f.pipeline));
  if (f.page != null) url.searchParams.set("page", String(f.page));
  if (f.pageSize != null) url.searchParams.set("pageSize", String(f.pageSize));
  const res = await fetchApi(url.toString(), { method: "GET" });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    const message = result?.error?.message || "Failed to load identify runs";
    throw new Error(message);
  }
  return result?.data as AdminIdentifyRunsResponse;
};

export type AdminLlmParityRow = {
  pipeline: string;
  domain: string;
  mean_quality: number | null;
  mean_latency_ms: number | null;
  mean_cost_usd: number | null;
  count: number;
  models: string[];
};

export type AdminLlmParityDriftAlert = {
  domain: string;
  gap: number;
  best_pipeline: string;
  best_mean_quality: number;
  worst_pipeline: string;
  worst_mean_quality: number;
  threshold: number;
};

export type AdminLlmParityResponse = {
  pipelines: AdminLlmParityRow[];
  drift_alerts: AdminLlmParityDriftAlert[];
  total: number;
  hard_cap: number;
};

export type AdminLlmParityFilters = {
  domain?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  pipeline?: string | null;
};

export const adminListLlmParity = async (
  filters?: AdminLlmParityFilters
): Promise<AdminLlmParityResponse> => {
  const url = new URL(`${BACKEND_URL}/api/admin/llm-parity`);
  const f = filters || {};
  if (f.domain) url.searchParams.set("domain", String(f.domain));
  if (f.dateFrom) url.searchParams.set("dateFrom", String(f.dateFrom));
  if (f.dateTo) url.searchParams.set("dateTo", String(f.dateTo));
  if (f.pipeline) url.searchParams.set("pipeline", String(f.pipeline));
  const res = await fetchApi(url.toString(), { method: "GET" });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    const message = result?.error?.message || "Failed to load LLM parity";
    throw new Error(message);
  }
  return result?.data as AdminLlmParityResponse;
};

/* ─── HARDEN-Wave-9 (2026-05-22): Operator-Visibility-Layer ─── */

export interface AdminStockFailureAlert {
  id: string;
  tenantId?: string;
  failureDocId?: string;
  terminalStatus?: "abandoned" | "needs_manual";
  reason?: string;
  failures?: Array<{ step?: string; sku?: string; productKey?: string; error?: string; message?: string }>;
  text?: string;
  createdAt?: string;
}

export interface AdminRecentAlertsResponse {
  alerts: AdminStockFailureAlert[];
  total: number;
  windowDays: number;
  windowSince: string;
}

export interface AdminSystemHealthDrain {
  abandoned_24h: number;
  abandoned_7d: number;
  needs_manual_24h: number;
  needs_manual_7d: number;
  total_alerts_24h: number;
  total_alerts_7d: number;
  latest: { failureDocId?: string; terminalStatus?: string; reason?: string; createdAt?: string } | null;
}

export interface AdminSystemHealthLlmPipelineRow {
  pipeline: string;
  calls: number;
  costUsd: number;
  avgLatencyMs: number | null;
}

export interface AdminSystemHealthLlm {
  calls_24h: number;
  totalCostUsd_24h: number;
  avgLatencyMs: number | null;
  schemaValidRate: number | null;
  byPipeline: AdminSystemHealthLlmPipelineRow[];
  driftAlerts: number;
}

export interface AdminSystemHealthExternalApiService {
  total: number;
  success: number;
  failure: number;
  successRate: number | null;
  avgLatencyMs: number;
  topErrors: Array<{ code: string; count: number }>;
}

export interface AdminSystemHealthExternalApis {
  totalRecords: number;
  windowMs: number;
  byService: Record<string, AdminSystemHealthExternalApiService>;
}

export interface AdminSystemHealthMeta {
  nodeEnv: string;
  slackAlertsConfigured: boolean;
  llmTelemetrySampleRate: string;
  backgroundJobTenants: string;
  aggregateLatencyMs: number;
}

export interface AdminSystemHealthSync {
  status: "ok" | "warn" | "critical";
  pendingCount: number;
  oldestAgeMinutes: number | null;
  oldestCreatedAt: string | null;
  reasons: string[];
  capped?: boolean;
}

export interface AdminSystemHealthResponse {
  tenantId: string;
  generatedAt: string;
  drain: AdminSystemHealthDrain | { error: string };
  sync?: AdminSystemHealthSync | { error: string } | null;
  listingSync?: { ebay?: EbayListingSyncHealth } | { error: string } | null;
  llm: AdminSystemHealthLlm | { error: string };
  externalApis: AdminSystemHealthExternalApis | { error: string };
  health: AdminSystemHealthMeta;
}

export const adminGetSystemHealth = async (): Promise<AdminSystemHealthResponse> => {
  const url = new URL(`${BACKEND_URL}/api/admin/system-health`);
  const res = await fetchApi(url.toString(), { method: "GET" });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    const message = result?.error?.message || "Failed to load system health";
    throw new Error(message);
  }
  return result?.data as AdminSystemHealthResponse;
};

export const adminListRecentAlerts = async (
  days: number = 7
): Promise<AdminRecentAlertsResponse> => {
  const url = new URL(`${BACKEND_URL}/api/admin/alerts/recent`);
  url.searchParams.set("days", String(Math.max(1, Math.min(90, days))));
  const res = await fetchApi(url.toString(), { method: "GET" });
  const result = await parseResponse(res);
  if (!res.ok || result?.ok === false) {
    const message = result?.error?.message || "Failed to load alerts";
    throw new Error(message);
  }
  return result?.data as AdminRecentAlertsResponse;
};

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
    const compactPreview = text.replace(/\s+/g, ' ').trim().slice(0, 180);
    const previewSuffix = compactPreview ? ` Body: ${compactPreview}` : '';
    throw new Error(`Server returned HTML instead of JSON. Status: ${response.status}. URL: ${response.url}.${previewSuffix}`);
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
    .filter((img: any) => Boolean(img.url_or_base64));

  return {
    ...input,
    id,
    identification: {
      ...(identificationIn as any),
      method: (identificationIn.method as any) || 'image',
      barcodes: Array.isArray(identificationIn.barcodes) ? identificationIn.barcodes.filter(Boolean).map(String) : [],
      // Kein id-Fallback: die Doc-ID als "Name" hat Geister-Produkte (leerer
      // Name) wie echte Produkte mit UUID-Titel aussehen lassen — und beim
      // nächsten UI-Save wäre die UUID als Name persistiert worden.
      name: identificationIn.name ? String(identificationIn.name) : "",
      brand: identificationIn.brand ? String(identificationIn.brand) : '',
      category: identificationIn.category ? String(identificationIn.category) : '',
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
        // Defensive: coerce all identifier fields to string (Gemini may return numbers)
        ean: identifiersIn.ean != null ? String(identifiersIn.ean).trim() : '',
        gtin: identifiersIn.gtin != null ? String(identifiersIn.gtin).trim() : '',
        upc: identifiersIn.upc != null ? String(identifiersIn.upc).trim() : '',
        isbn: identifiersIn.isbn != null ? String(identifiersIn.isbn).trim() : '',
        mpn: identifiersIn.mpn != null ? String(identifiersIn.mpn).trim() : '',
        sku: identifiersIn.sku != null ? String(identifiersIn.sku).trim() : '',
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
    return await fetchApi(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

export const fetchJobStatus = async (jobId: string, signal?: AbortSignal) => {
  const response = await fetchApi(`${BACKEND_URL}/api/jobs/${jobId}`, {
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
    response = await fetchApi(`${BACKEND_URL}/api/improve/jobs`, {
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
  const response = await fetchApi(`${BACKEND_URL}/api/improve/jobs/${jobId}?t=${Date.now()}`, {
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
    response = await fetchApi(`${BACKEND_URL}/api/quality/jobs`, {
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
  const response = await fetchApi(`${BACKEND_URL}/api/quality/jobs/${jobId}?t=${Date.now()}`, {
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

export const fetchProducts = async (options?: { timeoutMs?: number }): Promise<Product[]> => {
  const timeout = options?.timeoutMs || 45000;
  let response: Response | undefined;
  let lastError: any;
  // Retry once on timeout (mobile networks can be flaky)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetchWithTimeout(
        `${BACKEND_URL}/api/products`,
        undefined,
        timeout
      );
      lastError = null;
      break;
    } catch (error: any) {
      lastError = error;
      if (error?.name === 'AbortError' && attempt === 0) {
        // First timeout — retry once
        continue;
      }
      if (error?.name === 'AbortError') {
        throw new Error(
          'Zeitüberschreitung beim Laden der Produkte. Bitte Backend/Verbindung prüfen und erneut versuchen.'
        );
      }
      throw error;
    }
  }
  if (lastError || !response) {
    if (lastError?.name === 'AbortError') {
      throw new Error(
        'Zeitüberschreitung beim Laden der Produkte. Bitte Backend/Verbindung prüfen und erneut versuchen.'
      );
    }
    throw lastError || new Error('Produkte konnten nicht geladen werden.');
  }

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
  const response = await fetchApi(`${BACKEND_URL}/api/products/${encodeURIComponent(productId)}?t=${Date.now()}`);
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

export const fetchCompetitorPrices = async (ean: string, productId?: string): Promise<CompetitorPricesResponse> => {
  const params = new URLSearchParams({ ean });
  if (productId) params.set('productId', productId);
  const response = await fetchApi(
    `${BACKEND_URL}/api/competitor-prices?${params.toString()}`
  );
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Konkurrenzpreise konnten nicht geladen werden.');
  }
  return result?.data || { ebay: [], kaufland: [], cached: false, fetched_at: new Date().toISOString() };
};

export const fetchCompetitorHistory = async (productId: string, days = 30): Promise<PriceHistoryEntry[]> => {
  const response = await fetchApi(
    `${BACKEND_URL}/api/v1/competitors/${encodeURIComponent(productId)}/history?days=${days}`
  );
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Preisverlauf konnte nicht geladen werden.');
  }
  return result?.data || [];
};

export const fetchCompetitorOverview = async (): Promise<PriceHistoryEntry[]> => {
  const response = await fetchApi(`${BACKEND_URL}/api/v1/competitors/overview`);
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Konkurrenz-Übersicht konnte nicht geladen werden.');
  }
  return result?.data || [];
};

export const fetchEbayCategories = async (params: {
  query?: string;
  id?: string;
  limit?: number;
  leafOnly?: boolean;
} = {}): Promise<EbayCategoryOption[]> => {
  const query = new URLSearchParams();
  if (params.query) query.set('q', params.query);
  if (params.id) query.set('id', params.id);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.leafOnly) query.set('leafOnly', 'true');
  const url = query.toString()
    ? `${BACKEND_URL}/api/ebay/categories?${query.toString()}`
    : `${BACKEND_URL}/api/ebay/categories`;
  const response = await fetchApi(url);
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
    response = await fetchApi(`${BACKEND_URL}/api/jobs`, {
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
  const response = await fetchApi(url, {
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

export interface IdentifyHealthSnapshot {
  windowMs: number;
  sinceIso: string;
  total: number;
  success: number;
  successRate: number | null;
  byStatus: Record<string, number>;
  byPipeline: Record<string, number>;
  byError: Record<string, number>;
  durations: { count: number; avgMs: number; p50Ms: number; p95Ms: number };
  lastFailure: {
    timestampIso: string;
    pipeline: string;
    errorCode: string | null;
    errorMessage: string | null;
  } | null;
}

export const fetchIdentifyHealth = async (
  params: { hours?: number; tenantId?: string; signal?: AbortSignal } = {}
): Promise<IdentifyHealthSnapshot> => {
  const q = new URLSearchParams();
  if (params.hours) q.set('hours', String(params.hours));
  if (params.tenantId) q.set('tenantId', params.tenantId);
  const url = `${BACKEND_URL}/api/health/identify${q.toString() ? `?${q}` : ''}`;
  const response = await fetchApi(url, { method: 'GET', signal: params.signal });
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Identify-Health konnte nicht geladen werden.');
  }
  return result?.data as IdentifyHealthSnapshot;
};

export const retryIdentificationJob = async (
  jobId: string
): Promise<{ ok: boolean; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  try {
    response = await fetchApi(`${BACKEND_URL}/api/jobs/${jobId}/retry`, {
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

// --- The functions below call the real backend via fetchApi. ---

export const saveProduct = async (product: Product): Promise<{ ok: boolean; data?: { id: string; revision: number; sku?: string | null }; error?: { code: number; message: string } }> => {
  let response: Response | undefined;

  try {
    if (import.meta.env.DEV) {
      console.log('API CALL: /api/save', { id: product.id, name: product.identification.name });
    }

    response = await fetchApi(`${BACKEND_URL}/api/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(product),
    });

    const result = await parseResponse(response);

    if (!response.ok) {
      const message = result?.error?.message || response.statusText || `Request failed with status ${response.status}`;
      const details = result?.error?.details;
      return {
        ok: false,
        error: {
          code: response.status,
          message: details ? `${message} (${String(details)})` : message,
        },
      };
    }

    return result || { ok: true, data: { id: product.id, revision: 1 } };

  } catch (error) {
    console.error('Failed to save product:', error);
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
    response = await fetchApi(url, {
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
    response = await fetchApi(`${BACKEND_URL}/api/products/${encodeURIComponent(productId)}/improve`, {
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
    response = await fetchApi(`${BACKEND_URL}/api/products/bulk-improve`, {
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
    studio?: { front?: string; angle?: string; detail?: string; back?: string };
    lifestyle?: { front?: string; closeup?: string; inuse?: string };
  };
  error?: { code: number; message: string };
}> => {
  let response: Response | undefined;
  try {
    response = await fetchApi(`${BACKEND_URL}/api/generate-images`, {
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
  const cappedLimit = Math.min(Math.max(Number(limit) || 0, 1), 500);
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
  input: number | { days?: number; preset?: string | null; from_date?: string | null; to_date?: string | null } = 7,
  options?: { timeoutMs?: number }
): Promise<DashboardMetrics> => {
  const rawDays = typeof input === 'number' ? input : input?.days ?? 7;
  const rawPreset = typeof input === 'number' ? null : input?.preset ?? null;
  const fromDate = typeof input === 'object' ? input?.from_date ?? null : null;
  const toDate = typeof input === 'object' ? input?.to_date ?? null : null;

  const d = Math.min(Math.max(parseInt(String(rawDays), 10) || 7, 1), 60);
  const url = new URL(`${BACKEND_URL}/api/dashboard/metrics`);
  url.searchParams.set('days', String(d));
  if (rawPreset != null && String(rawPreset).trim()) {
    url.searchParams.set('preset', String(rawPreset).trim());
  }
  if (fromDate) url.searchParams.set('from_date', fromDate);
  if (toDate) url.searchParams.set('to_date', toDate);

  const response = await fetchWithTimeout(url.toString(), undefined, options?.timeoutMs || 25000);
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Dashboard-Metriken konnten nicht geladen werden.');
  }
  return result?.data;
};

// ─── Operational dashboard (counts, not euros) ──────────────────────────────
export interface OpsMarketplaceBucket {
  orders: number;
  units: number;
  cancellations: number;
  returns: number;
}

export interface OperationalMetrics {
  range: { preset: string; label: string; from_iso: string; to_iso: string };
  live: { waiting_picking: number; in_progress: number; shipped_today: number };
  window: {
    marketplaces: {
      ebay: OpsMarketplaceBucket;
      kaufland: OpsMarketplaceBucket;
      other: OpsMarketplaceBucket;
      total: OpsMarketplaceBucket;
    };
  };
  statusCounts: Record<string, number>;
  carriers: { dhl: number; dpd: number; dp: number; other: number; total: number } | null;
}

export const fetchOperationalMetrics = async (
  input: { preset?: string | null; from_date?: string | null; to_date?: string | null } = {},
  options?: { timeoutMs?: number }
): Promise<OperationalMetrics> => {
  const url = new URL(`${BACKEND_URL}/api/dashboard/ops`);
  if (input.preset != null && String(input.preset).trim()) url.searchParams.set('preset', String(input.preset).trim());
  if (input.from_date) url.searchParams.set('from_date', input.from_date);
  if (input.to_date) url.searchParams.set('to_date', input.to_date);

  const response = await fetchWithTimeout(url.toString(), undefined, options?.timeoutMs || 40000);
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Operative Kennzahlen konnten nicht geladen werden.');
  }
  return result?.data;
};

export interface OrderStatusCounts {
  statusCounts: Record<string, number>;
  live: { waiting_picking: number; in_progress: number; shipped_today: number };
}

export const fetchOrderStatusCounts = async (
  options?: { timeoutMs?: number }
): Promise<OrderStatusCounts> => {
  const response = await fetchWithTimeout(
    `${BACKEND_URL}/api/orders/status-counts`,
    undefined,
    options?.timeoutMs || 30000
  );
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Status-Zähler konnten nicht geladen werden.');
  }
  return result?.data;
};

export const fetchFinanceMetrics = async (
  preset: string = 'last7',
  options?: { timeoutMs?: number; from_date?: string; to_date?: string }
): Promise<FinanceMetrics> => {
  const url = new URL(`${BACKEND_URL}/api/dashboard/finance`);
  url.searchParams.set('preset', String(preset).trim() || 'last7');
  if (options?.from_date) url.searchParams.set('from_date', options.from_date);
  if (options?.to_date) url.searchParams.set('to_date', options.to_date);

  const response = await fetchWithTimeout(url.toString(), undefined, options?.timeoutMs || 35000);
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Finanzdaten konnten nicht geladen werden.');
  }
  return result?.data;
};

// Admin financial report (Umsatz/Kosten/Gewinn + Bestand + Kontostand) for a date range.
export const fetchFinancialReport = async (
  preset: string = 'month_to_date',
  options?: { timeoutMs?: number; from_date?: string; to_date?: string }
): Promise<FinancialReport> => {
  const url = new URL(`${BACKEND_URL}/api/admin/financials`);
  url.searchParams.set('preset', String(preset).trim() || 'month_to_date');
  if (options?.from_date) url.searchParams.set('from_date', options.from_date);
  if (options?.to_date) url.searchParams.set('to_date', options.to_date);

  const response = await fetchWithTimeout(url.toString(), { method: 'GET' }, options?.timeoutMs || 60000);
  const result = await parseResponse(response);
  if (!response.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Finanzbericht konnte nicht geladen werden.');
  }
  return result?.data;
};

// Save the COGS cost model (pallet economics + marketplace fee rates) for the tenant.
export const saveFinancialCostModel = async (input: FinancialCostModelInput): Promise<void> => {
  const response = await fetchApi(`${BACKEND_URL}/api/admin/financials/cost-model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const result = await parseResponse(response);
  if (!response.ok || result?.ok === false) {
    throw new Error(result?.error?.message || 'Kostenmodell konnte nicht gespeichert werden.');
  }
};

export interface ActivityEvent {
  type: "order" | "shipment" | "return" | "sync";
  id: string;
  title: string;
  detail: string;
  status: string;
  timestamp: string;
}

export async function fetchActivityFeed(limit = 20): Promise<ActivityEvent[]> {
  const res = await fetchApi(
    `${BACKEND_URL}/api/dashboard/activity?limit=${limit}`,
    { method: "GET" }
  );
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || "Activity feed failed");
  }
  return data?.data || [];
}

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
  const response = await fetchApi(`${BACKEND_URL}/api/orders/${encodeURIComponent(orderId)}/complete`, {
    method: 'POST',
  });
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Auftragsstatus konnte nicht aktualisiert werden.');
  }
};

export const packOrder = async (orderId: string): Promise<void> => {
  const response = await fetchApi(`${BACKEND_URL}/api/orders/${encodeURIComponent(orderId)}/pack`, {
    method: 'POST',
  });
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Auftragsstatus konnte nicht aktualisiert werden.');
  }
};

/**
 * Pack + Ship + Print in one step.
 * 1) Mark order as packed
 * 2) Create shipping label via SendCloud
 *    - if `opts.shippingMethodId` is given (user-picked from CarrierPickModal),
 *      it is forwarded verbatim and the auto-rule is skipped server-side.
 *    - otherwise the backend matches `opts.weight` against the tenant's
 *      carrier rules.
 * 3) Download label PDF via authenticated proxy and open for printing
 */
export async function packAndShip(
  orderId: string,
  opts?: { weight?: number; labelFormat?: string; shippingMethodId?: number }
): Promise<{ labelBlobUrl: string | null; labelBlob: Blob | null; trackingNumber: string | null; carrier: string | null; labelError?: string | null }> {
  await packOrder(orderId);
  const result = await shipOrder(orderId, opts);

  let labelBlobUrl: string | null = null;
  let labelBlob: Blob | null = null;
  let labelError: string | null = null;
  if (result?.labelUrl) {
    // Fetch PDF via our authenticated backend proxy.
    // The backend retries internally if SendCloud hasn't generated the PDF yet (up to ~18s).
    // No client-side timeout — backend handles retry + error and always responds.
    try {
      const format = opts?.labelFormat || "a6";
      const pdfRes = await fetchApi(
        `${BACKEND_URL}/api/orders/${encodeURIComponent(orderId)}/label?format=${encodeURIComponent(format)}`,
        { method: "GET" }
      );
      if (pdfRes.ok) {
        const blob = await pdfRes.blob();
        labelBlob = blob;
        labelBlobUrl = URL.createObjectURL(blob);
      } else {
        const errData = await pdfRes.json().catch(() => null);
        labelError = errData?.error?.message || `Label-Download fehlgeschlagen (${pdfRes.status})`;
        console.warn('[packAndShip] Label download failed:', labelError);
      }
    } catch (err: any) {
      labelError = err?.message || 'Label-Download fehlgeschlagen';
      console.warn('[packAndShip] Label download error:', labelError);
    }
  }

  return {
    labelBlobUrl,
    labelBlob,
    trackingNumber: result?.trackingNumber || null,
    carrier: result?.carrier || null,
    labelError,
  };
}

/**
 * Send a PDF blob directly to a LAN print proxy (e.g. Raspberry Pi).
 * The proxy forwards it to a CUPS-configured label printer.
 */
export async function printToLabelPrinter(proxyUrl: string, pdfBlob: Blob): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${proxyUrl.replace(/\/+$/, '')}/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: pdfBlob,
    });
    return await res.json();
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Drucker nicht erreichbar' };
  }
}

// ─── OMS Native Endpoints ────────────────────────────────────

export async function fetchOrderStatuses(): Promise<{ statuses: Record<string, any>; counts: Record<string, number> }> {
  const res = await fetchApi(`${BACKEND_URL}/api/orders/statuses`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Failed to load order statuses');
  return data?.data || { statuses: {}, counts: {} };
}

export async function fetchOrderDetail(orderId: string): Promise<{ order: any; timeline: any[]; nextStatuses: string[]; allStatuses?: Record<string, any> }> {
  const res = await fetchApi(`${BACKEND_URL}/api/orders/${encodeURIComponent(orderId)}/detail`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Failed to load order detail');
  return data?.data || { order: null, timeline: [], nextStatuses: [] };
}

export async function updateOrderCustomer(
  orderId: string,
  customer: { name?: string; street?: string; city?: string; zip?: string; country?: string; phone?: string; email?: string; postNumber?: string }
): Promise<void> {
  const res = await fetchApi(`${BACKEND_URL}/api/orders/${encodeURIComponent(orderId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customer }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || "Kundendaten-Update fehlgeschlagen");
}

export async function updateOrderWeight(orderId: string, weight: number): Promise<void> {
  const res = await fetchApi(`${BACKEND_URL}/api/orders/${encodeURIComponent(orderId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ weight }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || "Gewicht-Update fehlgeschlagen");
}

export async function transitionOrderStatus(
  orderId: string,
  toStatus: string,
  opts?: { note?: string; force?: boolean }
): Promise<{ fromStatus: string; toStatus: string }> {
  const res = await fetchApi(`${BACKEND_URL}/api/orders/${encodeURIComponent(orderId)}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toStatus, note: opts?.note, force: opts?.force }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Statusübergang fehlgeschlagen');
  return data?.data || {};
}

export async function fetchLabelPdfBlob(orderId: string, opts?: { labelFormat?: string }): Promise<Blob> {
  const format = opts?.labelFormat || 'a6';
  const res = await fetchApi(
    `${BACKEND_URL}/api/orders/${encodeURIComponent(orderId)}/label?format=${encodeURIComponent(format)}`,
    { method: 'GET' }
  );
  if (!res.ok) {
    const errData = await res.json().catch(() => null);
    throw new Error(errData?.error?.message || `Label-Download fehlgeschlagen (${res.status})`);
  }
  return res.blob();
}

export async function cancelShippingLabel(orderId: string): Promise<void> {
  const res = await fetchApi(`${BACKEND_URL}/api/orders/${encodeURIComponent(orderId)}/cancel-label`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Label-Stornierung fehlgeschlagen');
}

export async function assignTracking(
  orderId: string,
  opts: { trackingNumber: string; carrier?: string; trackingUrl?: string }
): Promise<{ message: string; trackingNumber: string }> {
  const res = await fetchApi(`${BACKEND_URL}/api/orders/${encodeURIComponent(orderId)}/tracking`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Tracking-Zuweisung fehlgeschlagen');
  return data?.data || {};
}

export async function syncSendCloudParcels(
  opts?: { fromDate?: string; toDate?: string }
): Promise<{ matched: number; unmatched: number; skipped: number; details: any }> {
  const res = await fetchApi(`${BACKEND_URL}/api/orders/sync-sendcloud`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts || {}),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'SendCloud-Sync fehlgeschlagen');
  return data?.data || {};
}

export async function fetchOrderTimeline(orderId: string): Promise<any[]> {
  const res = await fetchApi(`${BACKEND_URL}/api/orders/${encodeURIComponent(orderId)}/timeline`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Failed to load timeline');
  return Array.isArray(data?.data) ? data.data : [];
}

export async function syncMarketplaceOrders(opts?: { marketplace?: string; lookbackDays?: number }): Promise<{ results: Record<string, any>; totalSynced: number }> {
  const res = await fetchApi(`${BACKEND_URL}/api/orders/sync/marketplace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts || {}),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Marketplace sync fehlgeschlagen');
  return data?.data || { results: {}, totalSynced: 0 };
}

// ── Pricing Engine ──────────────────────────────────────────

export async function suggestPrice(productId: string): Promise<any> {
  const res = await fetchApi(`${BACKEND_URL}/api/v1/pricing/suggest/${encodeURIComponent(productId)}`, { method: 'POST' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Preisvorschlag fehlgeschlagen');
  return data?.data;
}

export async function fetchPricingRules(): Promise<any[]> {
  const res = await fetchApi(`${BACKEND_URL}/api/v1/pricing/rules`, { method: 'GET' });
  const data = await parseResponse(res);
  return Array.isArray(data?.data) ? data.data : [];
}

export async function runRepricingBatch(): Promise<any> {
  const res = await fetchApi(`${BACKEND_URL}/api/v1/pricing/reprice-batch`, { method: 'POST' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Repricing fehlgeschlagen');
  return data?.data;
}

export async function fetchAllPricingRules(): Promise<any[]> {
  const res = await fetchApi(`${BACKEND_URL}/api/v1/pricing/rules?all=true`, { method: 'GET' });
  const data = await parseResponse(res);
  return Array.isArray(data?.data) ? data.data : [];
}

export async function createPricingRule(rule: {
  productId: string;
  ruleType: string;
  params?: Record<string, any>;
}): Promise<any> {
  const res = await fetchApi(`${BACKEND_URL}/api/v1/pricing/rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rule),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Regel konnte nicht erstellt werden');
  return data?.data;
}

export async function deletePricingRule(ruleId: string): Promise<void> {
  const res = await fetchApi(`${BACKEND_URL}/api/v1/pricing/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Regel konnte nicht gelöscht werden');
}

export async function togglePricingRule(ruleId: string): Promise<{ id: string; active: boolean }> {
  const res = await fetchApi(`${BACKEND_URL}/api/v1/pricing/rules/${encodeURIComponent(ruleId)}/toggle`, { method: 'PATCH' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Regel konnte nicht umgeschaltet werden');
  return data?.data;
}

export async function fetchPricingSuggestion(productId: string): Promise<any> {
  return suggestPrice(productId);
}

// ── Inventory Forecast ──────────────────────────────────────

export async function fetchProductForecast(productId: string, days = 30): Promise<any> {
  const res = await fetchApi(`${BACKEND_URL}/api/v1/forecast/${encodeURIComponent(productId)}?days=${days}`, { method: 'GET' });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Prognose fehlgeschlagen');
  return data?.data;
}

export async function fetchReorderAlerts(): Promise<any[]> {
  const res = await fetchApi(`${BACKEND_URL}/api/v1/forecast/alerts`, { method: 'GET' });
  const data = await parseResponse(res);
  return Array.isArray(data?.data) ? data.data : [];
}

// ── OMS-B: Shipping & Invoices ──────────────────────────────

/** A single carrier rule that matches the order weight. Returned by the preview endpoint. */
export interface ShippingPreviewMatch {
  id: string | null;
  shippingMethodId: number;
  carrier: string;
  label: string;
  minWeight: number;
  maxWeight: number | null;
  order: number | null;
}

export interface ShippingPreview {
  orderId: string;
  /** kg — null if neither order.weight nor item-sum produced a value > 0 */
  weight: number | null;
  weightSource: "order" | "items" | null;
  hasWeight: boolean;
  hasAddress: boolean;
  matches: ShippingPreviewMatch[];
  rulesConfigured: number;
}

/**
 * Diagnose ship-readiness before creating a label.
 *
 * Pack-flow (mobile + desktop) drives off this:
 *   - hasWeight === false        → prompt user for weight, persist via updateOrderWeight, retry
 *   - matches.length === 0       → no rule fits (over-/underweight) → surface error
 *   - matches.length === 1       → auto-pick that method
 *   - matches.length > 1         → ask user to pick (CarrierPickModal)
 */
export async function fetchShippingPreview(orderId: string): Promise<ShippingPreview> {
  const res = await fetchApi(
    `${BACKEND_URL}/api/orders/${encodeURIComponent(orderId)}/shipping-preview`,
    { method: "GET" }
  );
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || "Versand-Vorschau fehlgeschlagen");
  }
  return data?.data;
}

export async function shipOrder(orderId: string, opts?: { shippingMethodId?: number; weight?: number; labelFormat?: string }): Promise<any> {
  const res = await fetchApi(`${BACKEND_URL}/api/orders/${encodeURIComponent(orderId)}/ship`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts || {}),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Versand fehlgeschlagen');
  return data?.data;
}

export interface RefreshShipmentResult {
  shipmentId: string;
  sendcloudParcelId: number | null;
  /** When the refresh re-bound the shipment to a different SendCloud parcel,
   *  this is the OLD parcel id. null when no re-bind happened. */
  previousSendcloudParcelId: number | null;
  reboundParcel: boolean;
  /** True when the fallback search by order_number was triggered. */
  searchedAlternates: boolean;
  /** How many parcels SendCloud returned for the order_number search. 0 when
   *  no search was needed. */
  alternatesFound: number;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrier: string | null;
  labelUrl: string | null;
  status: string;
  /** Human-readable status text from SendCloud (e.g. "Bereit zum Versand"). */
  parcelStatusMessage: string | null;
  /** Field paths that were actually changed (e.g. "order.trackingNumber"). */
  updated: string[];
  marketplacePush?: { ok: boolean; error?: string; skipped?: boolean } | null;
}

/**
 * Reconcile the order's shipment with SendCloud — pulls the latest parcel
 * state and writes back any non-empty field (tracking number, label URL,
 * carrier, status) to both the shipment and the order.
 *
 * Self-heal for the "label exists in SendCloud but order shows no tracking +
 * no print button" symptom (incident 2026-04-29). Idempotent + additive:
 * never overwrites an existing field with null.
 */
export async function refreshShipment(
  orderId: string,
  opts?: { labelFormat?: string }
): Promise<RefreshShipmentResult> {
  const res = await fetchApi(`${BACKEND_URL}/api/orders/${encodeURIComponent(orderId)}/refresh-shipment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts || {}),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || "Versand-Aktualisierung fehlgeschlagen");
  }
  return data?.data;
}

export async function generateInvoice(orderId: string, opts?: { vatRate?: number }): Promise<{ invoiceId: string; invoiceNumber: string; pdfUrl: string | null }> {
  const res = await fetchApi(`${BACKEND_URL}/api/orders/${encodeURIComponent(orderId)}/invoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts || {}),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Rechnungserstellung fehlgeschlagen');
  return data?.data;
}

export async function generateDeliveryNote(orderId: string): Promise<{ deliveryNoteNumber: string; pdfUrl: string | null }> {
  const res = await fetchApi(`${BACKEND_URL}/api/orders/${encodeURIComponent(orderId)}/delivery-note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Lieferschein-Erstellung fehlgeschlagen');
  return data?.data;
}

export async function fetchShippingMethods(params?: { weight?: number; country?: string }): Promise<ShippingMethod[]> {
  const url = new URL(`${BACKEND_URL}/api/shipping-methods`);
  if (params?.weight != null) url.searchParams.set("weight", String(params.weight));
  if (params?.country) url.searchParams.set("country", params.country);
  const res = await fetchApi(url.toString(), { method: "GET" });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || "Versandmethoden laden fehlgeschlagen");
  return data?.data || [];
}

export async function syncShippingMethods(): Promise<ShippingMethod[]> {
  const res = await fetchApi(`${BACKEND_URL}/api/shipping-methods/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || "Versandmethoden-Sync fehlgeschlagen");
  return data?.data || [];
}

export async function exportInvoiceToSevDesk(invoiceId: string): Promise<{ ok: boolean; sevdeskId?: string }> {
  const res = await fetchApi(`${BACKEND_URL}/api/invoices/${encodeURIComponent(invoiceId)}/export-sevdesk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'SevDesk-Export fehlgeschlagen');
  return data?.data;
}

export async function importSevDeskInvoices(): Promise<{ imported: number; matched: number; skipped: number }> {
  const res = await fetchApi(`${BACKEND_URL}/api/invoices/import-sevdesk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'SevDesk-Import fehlgeschlagen');
  return data?.data;
}

export async function bulkGenerateInvoices(): Promise<{ generated: number; skipped: number; errors: Array<{ orderId: string; error: string }> }> {
  const res = await fetchApi(`${BACKEND_URL}/api/invoices/bulk-generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Bulk-Generierung fehlgeschlagen');
  return data?.data;
}

export interface BulkShipResult {
  total: number;
  success: number;
  results: Array<{ orderId: string; ok: boolean; trackingNumber?: string; labelUrl?: string; error?: string }>;
}

export async function bulkShipOrders(orderIds: string[], opts?: { shippingMethodId?: number; labelFormat?: string }): Promise<BulkShipResult> {
  const res = await fetchApi(`${BACKEND_URL}/api/orders/bulk-ship`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderIds, shippingMethodId: opts?.shippingMethodId, labelFormat: opts?.labelFormat }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Bulk-Versand fehlgeschlagen');
  return data?.data;
}

export interface BulkTransitionResult {
  total: number;
  success: number;
  results: { orderId: string; ok: boolean; fromStatus?: string; toStatus?: string; error?: string }[];
}

export async function bulkTransitionOrders(
  orderIds: string[],
  toStatus: string,
  opts?: { note?: string; force?: boolean }
): Promise<BulkTransitionResult> {
  const res = await fetchApi(`${BACKEND_URL}/api/orders/bulk-transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderIds, toStatus, note: opts?.note, force: opts?.force }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || 'Bulk-Statuswechsel fehlgeschlagen');
  return data?.data;
}

export async function printAddressLabels(orderIds: string[]): Promise<void> {
  if (!orderIds.length) throw new Error('Keine Bestellungen ausgewählt.');
  const res = await fetchApi(`${BACKEND_URL}/api/orders/address-labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderIds }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error?.message || 'Adresslabel-Erstellung fehlgeschlagen');
  }
  const html = await res.text();
  const blob = new Blob([html], { type: 'text/html' });
  const blobUrl = URL.createObjectURL(blob);
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;';
  iframe.src = blobUrl;
  document.body.appendChild(iframe);
  await new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
    setTimeout(resolve, 1500);
  });
  try {
    iframe.contentWindow?.focus?.();
    iframe.contentWindow?.print?.();
  } catch (_) { /* cross-origin fallback: user can print manually */ }
  setTimeout(() => {
    iframe.remove();
    URL.revokeObjectURL(blobUrl);
  }, 60000);
}

export const openSkuLabelWindow = (productId: string): { ok: boolean; error?: { code: number; message: string } } => {
  try {
    const url = `${BACKEND_URL}/api/products/${encodeURIComponent(productId)}/label`;
    return openAuthedUrlInNewTab(url, { timeoutMs: 25000 });
  } catch (error: any) {
    console.error('Failed to open label window:', error);
    return { ok: false, error: { code: 0, message: error?.message || 'Unbekannter Fehler' } };
  }
};

export const printSkuLabel = async (
  productId: string
): Promise<{ ok: boolean; error?: { code: number; message: string } }> => {
  try {
    const url = `${BACKEND_URL}/api/products/${encodeURIComponent(productId)}/label`;
    await printAuthedHtmlUrl(url, { timeoutMs: 25000 });
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: { code: 0, message: error?.message || 'Labeldruck fehlgeschlagen' } };
  }
};

export const openProductLabelBatchWindow = (productIds: string[]): { ok: boolean; error?: { code: number; message: string } } => {
  if (!productIds.length) {
    return { ok: false, error: { code: 0, message: 'Keine Produkte ausgewählt.' } };
  }
  try {
    const url = `${BACKEND_URL}/api/products/labels?ids=${encodeURIComponent(productIds.join(','))}`;
    return openAuthedUrlInNewTab(url, { timeoutMs: 25000 });
  } catch (error: any) {
    return { ok: false, error: { code: 0, message: error?.message || 'Unbekannter Fehler' } };
  }
};

export const fetchWarehouseZones = async (): Promise<WarehouseLayout[]> => {
  const response = await fetchApi(`${BACKEND_URL}/api/warehouse/zones`);
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
    response = await fetchApi(`${BACKEND_URL}/api/warehouse/layouts`, {
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
  const response = await fetchApi(`${BACKEND_URL}/api/warehouse/zones/${encodeURIComponent(zone)}/${encodeURIComponent(etage)}`);
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Failed to load bins');
  }
  return result?.data || [];
};

export const fetchWarehouseBinDetail = async (code: string): Promise<WarehouseBin> => {
  const response = await fetchApi(`${BACKEND_URL}/api/warehouse/bins/${encodeURIComponent(code)}`);
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Failed to load bin detail');
  }
  return result?.data;
};

export const fetchProductBins = async (productId: string): Promise<WarehouseBin[]> => {
  const response = await fetchApi(`${BACKEND_URL}/api/products/${encodeURIComponent(productId)}/bins`);
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
    response = await fetchApi(`${BACKEND_URL}/api/warehouse/bins/${encodeURIComponent(code)}/assign`, {
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
    response = await fetchApi(
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
    response = await fetchApi(`${BACKEND_URL}/api/warehouse/stock-in`, {
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
    response = await fetchApi(`${BACKEND_URL}/api/warehouse/stock-out`, {
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
    return openAuthedUrlInNewTab(url, { timeoutMs: 25000 });
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
  return openAuthedUrlInNewTab(url, { timeoutMs: 30000 });
};

// ── Warehouse Child-BIN (Container) ──────────────────────────────

export const createChildBinApi = async (parentBinCode: string): Promise<WarehouseBin> => {
  const response = await fetchApi(`${BACKEND_URL}/api/warehouse/bins/${encodeURIComponent(parentBinCode)}/containers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || "Behälter konnte nicht erstellt werden");
  }
  return result.data;
};

export const listChildBinsApi = async (parentBinCode: string): Promise<WarehouseBin[]> => {
  const response = await fetchApi(`${BACKEND_URL}/api/warehouse/bins/${encodeURIComponent(parentBinCode)}/containers`);
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || "Behälter konnten nicht geladen werden");
  }
  return result.data;
};

export const deleteChildBinApi = async (parentBinCode: string, childCode: string): Promise<void> => {
  const response = await fetchApi(
    `${BACKEND_URL}/api/warehouse/bins/${encodeURIComponent(parentBinCode)}/containers/${encodeURIComponent(childCode)}`,
    { method: "DELETE" }
  );
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || "Behälter konnte nicht gelöscht werden");
  }
};

// ── Warehouse Movements ──────────────────────────────────────────

export interface WarehouseMovement {
  id: string;
  type: string;
  binCode: string;
  productId: string;
  sku: string;
  delta: number;
  quantityAfter: number;
  binQuantityAfter: number;
  meta?: { source?: string; action?: string; orderId?: string };
  createdAt: string;
}

export async function fetchWarehouseMovements(params: {
  type?: string;
  binCode?: string;
  productId?: string;
  limit?: number;
  offset?: number;
  from?: string;
  to?: string;
}): Promise<{ movements: WarehouseMovement[]; total: number; hasMore: boolean }> {
  const qs = new URLSearchParams();
  if (params.type) qs.set("type", params.type);
  if (params.binCode) qs.set("binCode", params.binCode);
  if (params.productId) qs.set("productId", params.productId);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);

  const res = await fetchApi(`${BACKEND_URL}/api/warehouse/movements?${qs.toString()}`);
  const data = await parseResponse(res);
  if (!res.ok) throw new Error(data?.error?.message || "Movements konnten nicht geladen werden");
  return data;
}

// ── Warehouse Inventories (Inventur) ─────────────────────────────

export interface InventoryCount {
  binCode: string;
  productId: string;
  sku: string;
  productName: string;
  systemQty: number;
  countedQty: number | null;
  variance: number | null;
  countedAt: string | null;
}

export interface WarehouseInventory {
  id: string;
  tenantId: string;
  name: string;
  status: "planned" | "active" | "completed";
  scope: "full" | "zone";
  zoneFilter?: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  counts?: InventoryCount[];
  summary: {
    totalItems: number;
    countedItems: number;
    totalVariance: number;
    completionPct: number;
  };
}

export async function fetchWarehouseInventories(): Promise<WarehouseInventory[]> {
  const res = await fetchApi(`${BACKEND_URL}/api/warehouse/inventories`);
  const data = await parseResponse(res);
  if (!res.ok) throw new Error(data?.error?.message || "Inventuren konnten nicht geladen werden");
  return data.inventories;
}

export async function fetchWarehouseInventory(id: string): Promise<WarehouseInventory> {
  const res = await fetchApi(`${BACKEND_URL}/api/warehouse/inventories/${id}`);
  const data = await parseResponse(res);
  if (!res.ok) throw new Error(data?.error?.message || "Inventur nicht gefunden");
  return data.inventory;
}

export async function createWarehouseInventory(params: {
  name: string;
  scope: "full" | "zone";
  zoneFilter?: string;
}): Promise<WarehouseInventory> {
  const res = await fetchApi(`${BACKEND_URL}/api/warehouse/inventories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await parseResponse(res);
  if (!res.ok) throw new Error(data?.error?.message || "Inventur konnte nicht erstellt werden");
  return data.inventory;
}

export async function recordInventoryCounts(
  inventoryId: string,
  counts: Array<{ binCode: string; productId: string; countedQty: number }>
): Promise<{ countedItems: number; totalVariance: number }> {
  const res = await fetchApi(`${BACKEND_URL}/api/warehouse/inventories/${inventoryId}/counts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ counts }),
  });
  const data = await parseResponse(res);
  if (!res.ok) throw new Error(data?.error?.message || "Zählungen konnten nicht gespeichert werden");
  return data;
}

export async function completeWarehouseInventory(
  inventoryId: string
): Promise<{ variances: InventoryCount[]; totalVariance: number }> {
  const res = await fetchApi(`${BACKEND_URL}/api/warehouse/inventories/${inventoryId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const data = await parseResponse(res);
  if (!res.ok) throw new Error(data?.error?.message || "Inventur konnte nicht abgeschlossen werden");
  return data;
}

export const refreshPrice = async (productId: string): Promise<{ ok: boolean; data?: any; error?: { code: number; message: string } }> => {
  let response: Response | undefined;

  try {
    if (import.meta.env.DEV) {
      console.log('API CALL: /api/price-refresh', { productId });
    }

    response = await fetchApi(`${BACKEND_URL}/api/price-refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ productId }),
    });

    const result = await parseResponse(response);

    if (!response.ok) {
      const message = result?.error?.message || `Request failed with status ${response.status}`;
      const details = result?.error?.details;
      throw new Error(details ? `${message} (${String(details)})` : message);
    }

    return result;

  } catch (error) {
    console.error('Failed to refresh price:', error);
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export interface ChatAssistantConfidence {
  overall?: number;
  readyForPublish?: boolean;
  fieldScores?: Record<string, { score: number; threshold: number; passes: boolean }>;
  conflicts?: Array<{ field: string; alternatives: Array<{ value: string; sources: string[] }> }>;
  missingCritical?: string[];
}

export interface ChatAssistantEvidence {
  url: string;
  title?: string;
  snippet?: string;
  source?: string;
}

export interface ChatAssistantTrace {
  iterations?: number;
  toolCalls?: Array<{ name: string; ok: boolean; latencyMs?: number }>;
  groundingChunks?: Array<{ uri: string; title?: string }>;
  urls?: string[];
  thoughts?: string[];
}

export interface ChatAssistantPayload {
  message: string;
  datasheetChanges: DatasheetChange[];
  imageSuggestions: ImageSuggestionGroup[];
  serpTrace: SerpInsight[];
  intent?: 'change' | 'info' | 'analysis';
  pipeline?: 'v3' | 'v2' | 'legacy';
  evidence?: ChatAssistantEvidence[];
  confidence?: ChatAssistantConfidence;
  needsHumanReview?: boolean;
  lowConfidenceFields?: string[];
  trace?: ChatAssistantTrace;
}

export interface ChatSessionMessage {
  role: 'user' | 'model';
  text: string;
  ts: string;
}

export interface ChatSession {
  id: string;
  productId: string;
  userId: string;
  messages: ChatSessionMessage[];
}

export const getChatSession = async (
  productId: string
): Promise<{ ok: boolean; session?: ChatSession | null; error?: { code: number; message: string } }> => {
  try {
    const response = await fetchApi(`${BACKEND_URL}/api/chat/session/${encodeURIComponent(productId)}`, {
      method: 'GET',
    });
    const result = await parseResponse(response);
    if (!response.ok) {
      return { ok: false, error: { code: response.status, message: result?.error?.message || 'Failed to load session' } };
    }
    return { ok: true, session: result?.session ?? null };
  } catch (error) {
    return { ok: false, error: { code: 500, message: 'Failed to load chat session' } };
  }
};

export const clearChatSession = async (
  productId: string
): Promise<{ ok: boolean; error?: { code: number; message: string } }> => {
  try {
    const response = await fetchApi(`${BACKEND_URL}/api/chat/session/${encodeURIComponent(productId)}`, {
      method: 'DELETE',
    });
    if (!response.ok) return { ok: false, error: { code: response.status, message: 'Failed to clear session' } };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: { code: 500, message: 'Failed to clear chat session' } };
  }
};

export const chatWithAssistant = async (
  productId: string | undefined,
  message: string,
  attachments: File[] = [],
  scope?: string | null
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
      if (scope) {
        formData.append('scope', scope);
      }
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
        body: JSON.stringify({ productId, message, scope }),
      };
    }

    response = await fetchApi(`${BACKEND_URL}/api/chat`, requestInit);

    const result = await parseResponse(response);

    if (!response.ok) {
      const message = result?.error?.message || `Request failed with status ${response.status}`;
      const details = result?.error?.details;
      throw new Error(details ? `${message} (${String(details)})` : message);
    }

    return result;

  } catch (error) {
    console.error('Failed to chat with Gemini:', error);
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

/**
 * Opens a streaming chat connection. Returns the raw Response object so the caller
 * can read response.body as a ReadableStream for SSE events.
 * Used by useChatStream.ts hook.
 */
export const startChatStream = async (
  productId: string,
  message: string,
  attachments: File[] = [],
  scope?: string | null,
  signal?: AbortSignal
): Promise<Response> => {
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  let requestInit: RequestInit;

  if (hasAttachments) {
    const formData = new FormData();
    formData.append('productId', productId);
    formData.append('message', message);
    if (scope) formData.append('scope', scope);
    attachments.forEach((file) => formData.append('attachments', file));
    requestInit = { method: 'POST', body: formData, signal };
  } else {
    requestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, message, scope }),
      signal,
    };
  }

  return fetchApi(`${BACKEND_URL}/api/chat?stream=true`, requestInit);
};

export const runSerpapiFreeEnrichment = async (
  files: File[],
  barcodes: string,
  locale = 'de-DE',
  inventoryId?: string
): Promise<{ ok: boolean; data?: ProductEnrichmentRecord; meta?: any; error?: { code: number; message: string } }> => {
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
    response = await fetchApi(`${BACKEND_URL}/api/v2/enrich`, {
      method: 'POST',
      body: formData,
    });
    const result = await parseResponse(response);
    if (!response.ok) {
      const details = result?.error?.details;
      return {
        ok: false,
        error: {
          code: response.status,
          message: details
            ? `${result?.error?.message || 'SerpAPI-freies Enrichment fehlgeschlagen.'} (${String(details)})`
            : result?.error?.message || 'SerpAPI-freies Enrichment fehlgeschlagen.',
        },
      };
    }
    return { ok: true, data: result?.data as ProductEnrichmentRecord, meta: result?.meta };
  } catch (error) {
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const identifyProductV2 = async (
  files: File[],
  barcodes: string,
  locale = 'de-DE',
  inventoryId?: string,
  paletteCode?: string,
  hint?: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; data?: Product; meta?: any; error?: { code: number; message: string } }> => {
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
  if (paletteCode) {
    formData.append('paletteCode', paletteCode);
  }
  if (hint) {
    formData.append('hint', hint);
  }

  // Abort after backend wall-clock + upload slack. Backend starts
  // IDENTIFY_TOTAL_TIMEOUT_MS (default 360s) after palette validation so V4 /
  // OCR / GCS uploads count against the same budget; keep this slightly higher
  // so the server can return 504 (IDENTIFY_TOTAL_TIMEOUT) before we abort.
  const IDENTIFY_FETCH_MS = parseInt(String(import.meta.env?.VITE_IDENTIFY_TIMEOUT_MS || ''), 10);
  const fetchBudgetMs = Number.isFinite(IDENTIFY_FETCH_MS) && IDENTIFY_FETCH_MS > 0 ? IDENTIFY_FETCH_MS : 390_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchBudgetMs);
  // Allow an external caller (e.g. a per-group "Abbrechen" button) to abort this
  // request by forwarding its signal to the internal controller. Backward-compatible:
  // when no signal is passed, behaviour is unchanged.
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  let response: Response | undefined;
  try {
    response = await fetchApi(`${BACKEND_URL}/api/v2/identify`, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
    const result = await parseResponse(response);
    if (!response.ok) {
      const details = result?.error?.details;
      return {
        ok: false,
        error: {
          code: response.status,
          message: details
            ? `${result?.error?.message || 'Identify (v2) fehlgeschlagen.'} (${String(details)})`
            : result?.error?.message || 'Identify (v2) fehlgeschlagen.',
        },
      };
    }
    const product = result?.data ? normalizeProduct(result.data) : undefined;
    return { ok: true, data: product, meta: result?.meta };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return {
        ok: false,
        error: {
          code: 408,
          message:
            'Produkterkennung abgebrochen (Timeout beim Warten auf den Server). Netzwerk prüfen und erneut versuchen. Bei sehr vielen Bildern helfen weniger Aufnahmen oder geringere Auflösung.',
        },
      };
    }
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  } finally {
    clearTimeout(timeout);
    if (signal) {
      signal.removeEventListener('abort', onExternalAbort);
    }
  }
};

export interface ProductGroupProposal {
  id: string;
  label: string;
  image_indices: number[];
  confidence: number;
  reason: string;
  detected_barcode: string | null;
  hint?: string | null;
}

export const groupImages = async (
  files: File[],
  barcodes?: string
): Promise<{ ok: boolean; data?: { groups: ProductGroupProposal[]; imageCount: number }; error?: { code: string; message: string } }> => {
  const formData = new FormData();
  files.forEach((file) => formData.append('images', file));
  if (barcodes) formData.append('barcodes', barcodes);

  try {
    const response = await fetchApi(`${BACKEND_URL}/api/v2/group-images`, {
      method: 'POST',
      body: formData,
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      return { ok: false, error: result.error || { code: 'GROUPING_FAILED', message: 'Gruppierung fehlgeschlagen' } };
    }
    return { ok: true, data: result.data };
  } catch (error: any) {
    return { ok: false, error: { code: 'NETWORK_ERROR', message: error?.message || 'Netzwerkfehler' } };
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
    response = await fetchApi(`${BACKEND_URL}/api/intake/resolve`, {
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
    response = await fetchApi(`${BACKEND_URL}/api/scanner/capture`, {
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
    response = await fetchApi(`${BACKEND_URL}/api/products/${encodeURIComponent(productId)}`, {
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

export const deleteProductsBulk = async (
  ids: string[],
  opts?: { purgeDuplicates?: boolean }
): Promise<{
  ok: boolean;
  deleted?: string[];
  notFound?: string[];
  failed?: Array<{ id: string; error: string }>;
  error?: { code: number; message: string };
}> => {
  let response: Response | undefined;
  try {
    const cleanIds = Array.from(new Set((ids || []).map((x) => String(x || '').trim()).filter(Boolean)));
    response = await fetchApi(`${BACKEND_URL}/api/products/bulk-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: cleanIds,
        purgeDuplicates: Boolean(opts?.purgeDuplicates),
      }),
    });
    const result = await parseResponse(response);
    if (!response.ok || result?.ok === false) {
      const message = result?.error?.message || response.statusText || 'Bulk delete failed';
      return { ok: false, error: { code: response.status || 500, message } };
    }
    return {
      ok: true,
      deleted: Array.isArray(result?.deleted) ? result.deleted : [],
      notFound: Array.isArray(result?.notFound) ? result.notFound : [],
      failed: Array.isArray(result?.failed) ? result.failed : [],
    };
  } catch (error) {
    console.error('Failed to bulk delete products:', error);
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
  const response = await fetchApi(url);
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Inventories konnten nicht geladen werden.');
  }
  return Array.isArray(result?.data) ? (result.data as InventoryRecord[]) : [];
};

export const fetchInventoryById = async (inventoryId: string): Promise<InventoryRecord | null> => {
  const response = await fetchApi(`${BACKEND_URL}/api/inventories/${encodeURIComponent(inventoryId)}`);
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
  const response = await fetchApi(`${BACKEND_URL}/api/inventories/sync`, {
    method: 'POST',
  });
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Inventory-Sync fehlgeschlagen.');
  }
  return result?.data;
};

export type RbacSnapshot = {
  roles: string[];
  permissions: Record<string, Record<string, boolean>>;
  profile: { uid: string | null; email: string | null; roles: string[]; groupIds: string[] } | null;
};

export const fetchMyPermissions = async (): Promise<RbacSnapshot> => {
  const response = await fetchApi(`${BACKEND_URL}/api/me/permissions?t=${Date.now()}`);
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'RBAC konnte nicht geladen werden.');
  }
  return (result?.data as RbacSnapshot) || { roles: [], permissions: {}, profile: null };
};

export const assignInventoryToProducts = async (productIds: string[], inventoryId: string) => {
  const response = await fetchApi(`${BACKEND_URL}/api/inventories/assign`, {
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
  const response = await fetchApi(`${BACKEND_URL}/api/products/${encodeURIComponent(productId)}/inventory`, {
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
  return openAuthedUrlInNewTab(url, { timeoutMs: 25000 });
};

// ─── CSV Export / Import ──────────────────────────────────────

export const exportProductsCsv = async (): Promise<void> => {
  try {
    const response = await fetchApi(`${BACKEND_URL}/api/products/export/csv`);
    if (!response.ok) {
      throw new Error(`CSV-Export fehlgeschlagen (HTTP ${response.status}).`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `avycloud-produkte-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("CSV export failed:", err);
    throw err;
  }
};

export interface ImportPreviewResult {
  ok: boolean;
  data?: {
    headers: string[];
    totalRows: number;
    validCount: number;
    errorCount: number;
    errors: { row: number; message: string }[];
    preview: { name: string; brand: string; sku: string; ean: string; sellPrice: number }[];
  };
  error?: { code: number; message: string };
}

export interface ColumnMapping {
  csvColumn: string;
  field: string;
}

export const previewProductsImport = async (
  csvText: string,
  mapping: ColumnMapping[],
  delimiter?: string
): Promise<ImportPreviewResult> => {
  let response: Response | undefined;
  try {
    response = await fetchApi(`${BACKEND_URL}/api/products/import/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csvText, mapping, delimiter }),
    });
    return await response.json();
  } catch (err) {
    const errorInfo = extractErrorInfo(err, response);
    return { ok: false, error: errorInfo };
  }
};

export interface ImportExecuteResult {
  ok: boolean;
  data?: {
    imported: number;
    failed: number;
    totalRows: number;
    validationErrors: { row: number; message: string }[];
    importErrors: { row: number; message: string }[];
  };
  error?: { code: number; message: string };
}

// --- Deduplication ---

export interface DuplicateGroup {
  type: "ean" | "mpn" | "brand_name";
  key: string;
  productIds: string[];
}

export interface DuplicatesResult {
  ok: boolean;
  data?: {
    duplicates: DuplicateGroup[];
    totalProducts: number;
    totalDuplicateGroups: number;
  };
  error?: { code: string; message: string };
}

export interface MergeSuggestion {
  id: string;
  name: string;
  brand: string;
  sku: string;
  barcodes: string[];
  stock: number;
  images: number;
  createdAt: string;
}

export interface MergeSuggestResult {
  ok: boolean;
  data?: {
    productA: MergeSuggestion;
    productB: MergeSuggestion;
  };
  error?: { code: string; message: string };
}

export interface MergeExecuteResult {
  ok: boolean;
  data?: {
    keepId: string;
    removeId: string;
    merged: { barcodes: number; images: number };
  };
  error?: { code: string; message: string };
}

export async function fetchDuplicates(): Promise<DuplicatesResult> {
  const res = await fetchApi(`${BACKEND_URL}/api/v1/products/duplicates`);
  return res.json();
}

export async function fetchMergeSuggestion(idA: string, idB: string): Promise<MergeSuggestResult> {
  const res = await fetchApi(`${BACKEND_URL}/api/v1/products/merge/suggest?a=${encodeURIComponent(idA)}&b=${encodeURIComponent(idB)}`);
  return res.json();
}

export async function executeMerge(keepId: string, removeId: string): Promise<MergeExecuteResult> {
  const res = await fetchApi(`${BACKEND_URL}/api/v1/products/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keepId, removeId }),
  });
  return res.json();
}

// --- Bulk Field Update (BULK-001) ---

export interface BulkFieldUpdate {
  field: string;
  value: any;
}

export interface BulkUpdateDiffEntry {
  productId: string;
  productName: string;
  changes: { field: string; oldValue: any; newValue: any }[];
  status: "ready" | "skipped";
  reason?: string;
}

export interface BulkUpdateResult {
  ok: boolean;
  data?: {
    updated: number;
    skipped: number;
    errors: { id: string; reason: string }[];
    diff?: BulkUpdateDiffEntry[];
    duration_ms: number;
  };
  error?: { code: number; message: string };
}

export async function bulkUpdateProducts(params: {
  productIds: string[];
  updates: BulkFieldUpdate[];
  dryRun?: boolean;
}): Promise<BulkUpdateResult> {
  let response: Response | undefined;
  try {
    response = await fetchApi(`${BACKEND_URL}/api/v1/products/bulk-update`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    return await response.json();
  } catch (err) {
    const errorInfo = extractErrorInfo(err, response);
    return { ok: false, error: errorInfo };
  }
}

// --- Audit Log ---

export interface AuditLogEntry {
  id: string;
  action: string;
  userId: string | null;
  userEmail: string | null;
  tenantId: string;
  resourceType: string | null;
  resourceId: string | null;
  details: Record<string, any> | null;
  ip: string | null;
  timestamp: string;
}

export async function fetchAuditLog(params?: {
  action?: string;
  resourceType?: string;
  limit?: number;
  startAfter?: string;
}): Promise<{ ok: boolean; data?: AuditLogEntry[]; error?: { code: string; message: string } }> {
  const qs = new URLSearchParams();
  if (params?.action) qs.set("action", params.action);
  if (params?.resourceType) qs.set("resourceType", params.resourceType);
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.startAfter) qs.set("startAfter", params.startAfter);
  const res = await fetchApi(`${BACKEND_URL}/api/admin/audit-log?${qs.toString()}`);
  return res.json();
}

// ── Pre-Listing Validation (VAL-001) ──

export async function validateProduct(
  product: any,
  marketplaces?: string[]
): Promise<{ ok: boolean; results?: Record<string, any>; error?: any }> {
  let response: Response | undefined;
  try {
    response = await fetchApi(`${BACKEND_URL}/api/v1/products/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product, marketplaces }),
    });
    return await parseResponse(response);
  } catch (err) {
    const errorInfo = extractErrorInfo(err, response);
    return { ok: false, error: errorInfo };
  }
}

export async function validateProductBatch(
  productIds: string[],
  marketplaces?: string[]
): Promise<{ ok: boolean; results?: any[]; summary?: any; error?: any }> {
  let response: Response | undefined;
  try {
    response = await fetchApi(`${BACKEND_URL}/api/v1/products/validate-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productIds, marketplaces }),
    });
    return await parseResponse(response);
  } catch (err) {
    const errorInfo = extractErrorInfo(err, response);
    return { ok: false, error: errorInfo };
  }
}

export const executeProductsImport = async (
  csvText: string,
  mapping: ColumnMapping[],
  delimiter?: string
): Promise<ImportExecuteResult> => {
  let response: Response | undefined;
  try {
    response = await fetchApi(`${BACKEND_URL}/api/products/import/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csvText, mapping, delimiter }),
    });
    return await response.json();
  } catch (err) {
    const errorInfo = extractErrorInfo(err, response);
    return { ok: false, error: errorInfo };
  }
};

/* ─── Rule Engine API (RULE-001) ─── */

export interface RuleData {
  id: string;
  name: string;
  description?: string;
  active: boolean;
  conditions: { field: string; operator: string; value?: any }[];
  actions: { type: string; field: string; value?: any; params?: Record<string, any> }[];
  channel?: string | null;
  stats: { lastRunAt: string | null; lastRunProducts: number; lastRunApplied: number; totalRuns: number };
  createdAt: string;
  updatedAt?: string;
  createdBy?: string;
}

export interface RuleJobData {
  id: string;
  ruleId: string;
  status: "pending" | "processing" | "done" | "failed";
  mode: "execute" | "dry_run";
  progress: { total: number; processed: number; applied: number; skipped: number; errors: number };
  result?: { summary: string; changes: { productId: string; productName: string; field: string; oldValue: any; newValue: any }[] } | null;
  error?: string | null;
}

export async function listRules(active?: boolean): Promise<RuleData[]> {
  const url = new URL(`${BACKEND_URL}/api/v1/rules`);
  if (active !== undefined) url.searchParams.set("active", String(active));
  const res = await fetchApi(url.toString(), { method: "GET" });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || "Failed to load rules");
  return data?.data || [];
}

export async function getRule(ruleId: string): Promise<RuleData> {
  const res = await fetchApi(`${BACKEND_URL}/api/v1/rules/${encodeURIComponent(ruleId)}`, { method: "GET" });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || "Rule not found");
  return data?.data;
}

export async function createRule(body: Partial<RuleData>): Promise<RuleData> {
  const res = await fetchApi(`${BACKEND_URL}/api/v1/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || "Failed to create rule");
  return data?.data;
}

export async function updateRule(ruleId: string, body: Partial<RuleData>): Promise<RuleData> {
  const res = await fetchApi(`${BACKEND_URL}/api/v1/rules/${encodeURIComponent(ruleId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || "Failed to update rule");
  return data?.data;
}

export async function deleteRule(ruleId: string): Promise<void> {
  const res = await fetchApi(`${BACKEND_URL}/api/v1/rules/${encodeURIComponent(ruleId)}`, { method: "DELETE" });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || "Failed to delete rule");
}

export async function toggleRule(ruleId: string): Promise<{ id: string; active: boolean }> {
  const res = await fetchApi(`${BACKEND_URL}/api/v1/rules/${encodeURIComponent(ruleId)}/toggle`, { method: "PATCH" });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || "Failed to toggle rule");
  return data?.data;
}

export async function executeRuleApi(ruleId: string, mode: "execute" | "dry_run", limit?: number): Promise<{ jobId: string; status: string }> {
  const res = await fetchApi(`${BACKEND_URL}/api/v1/rules/${encodeURIComponent(ruleId)}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, limit }),
  });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || "Failed to execute rule");
  return data?.data;
}

export async function getJobStatus(jobId: string): Promise<RuleJobData> {
  const res = await fetchApi(`${BACKEND_URL}/api/v1/rules/jobs/${encodeURIComponent(jobId)}`, { method: "GET" });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || "Failed to get job status");
  return data?.data;
}

export async function previewRule(ruleId: string, limit = 20): Promise<{ matchCount: number; sample: any[] }> {
  const url = new URL(`${BACKEND_URL}/api/v1/rules/${encodeURIComponent(ruleId)}/preview`);
  url.searchParams.set("limit", String(limit));
  const res = await fetchApi(url.toString(), { method: "GET" });
  const data = await parseResponse(res);
  if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || "Failed to preview rule");
  return data?.data;
}

// --- User Sessions ---

export interface UserSessionGeo {
  country: string;
  city: string;
  region: string;
  lat: number | null;
  lon: number | null;
  timezone: string;
}

export interface UserSessionClient {
  screenResolution: string;
  viewportSize: string;
  devicePixelRatio: number | null;
  language: string;
  languages: string[];
  timezone: string;
  referrer: string;
  connectionType: string | null;
  connectionDownlink: number | null;
  connectionRtt: number | null;
  saveData: boolean;
  isPwa: boolean;
  touchPoints: number;
  cookieEnabled: boolean;
  doNotTrack: string | null;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  platform: string;
  colorScheme: "dark" | "light";
  reducedMotion: boolean;
  pdfViewerEnabled: boolean;
  // Extended fingerprint fields (optional; mirror SessionClientInfo). Captured by
  // newer clients and surfaced read-only in UserSessionsTab.
  screenColorDepth?: number | null;
  screenOrientation?: string | null;
  gpuRenderer?: string | null;
  gpuVendor?: string | null;
  onLine?: boolean;
  storageQuotaMb?: number | null;
  storageUsageMb?: number | null;
  batteryLevel?: number | null;
  batteryCharging?: boolean | null;
  mediaDeviceCounts?: { audioinput: number; videoinput: number; audiooutput: number } | null;
  pointerType?: "fine" | "coarse" | "none";
  hoverCapable?: boolean;
  forcedColors?: boolean;
  prefersContrast?: "more" | "less" | "no-preference";
  connectionPhysicalType?: string | null;
}

export interface UserSession {
  id: string;
  userId: string;
  userEmail: string;
  tenantId: string;
  loginAt: string;
  logoutAt: string | null;
  lastActiveAt: string;
  durationSeconds: number | null;
  status: "active" | "idle" | "offline";
  authProvider: string;
  ip: string;
  geo: UserSessionGeo | null;
  userAgent: string;
  browser: { name: string; version: string };
  os: { name: string; version: string };
  device: { type: string; vendor: string; model: string };
  client: UserSessionClient;
}

export interface SessionClientInfo {
  screenResolution: string;
  viewportSize: string;
  devicePixelRatio: number;
  language: string;
  languages: string[];
  timezone: string;
  referrer: string;
  connectionType: string | null;
  connectionDownlink: number | null;
  connectionRtt: number | null;
  saveData: boolean;
  isPwa: boolean;
  touchPoints: number;
  cookieEnabled: boolean;
  doNotTrack: string | null;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  platform: string;
  colorScheme: "dark" | "light";
  reducedMotion: boolean;
  pdfViewerEnabled: boolean;
  screenColorDepth?: number | null;
  screenOrientation?: string | null;
  gpuRenderer?: string | null;
  gpuVendor?: string | null;
  onLine?: boolean;
  storageQuotaMb?: number | null;
  storageUsageMb?: number | null;
  batteryLevel?: number | null;
  batteryCharging?: boolean | null;
  mediaDeviceCounts?: { audioinput: number; videoinput: number; audiooutput: number } | null;
  pointerType?: "fine" | "coarse" | "none";
  hoverCapable?: boolean;
  forcedColors?: boolean;
  prefersContrast?: "more" | "less" | "no-preference";
  connectionPhysicalType?: string | null;
}

export async function createSessionApi(clientInfo: SessionClientInfo): Promise<{ ok: boolean; sessionId?: string }> {
  const res = await fetchApi(`${BACKEND_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientInfo }),
  });
  const data = await parseResponse(res);
  return { ok: Boolean(data?.ok), sessionId: data?.sessionId };
}

export async function heartbeatSession(sessionId: string): Promise<void> {
  await fetchApi(`${BACKEND_URL}/api/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {
    method: "POST",
  });
}

// ── Operational error dashboard ───────────────────────────────────────────
// Mirrors the `operationalErrors` Firestore documents written by the backend
// error-collector (backend/lib/error-collector.js). Consumed by hooks/useErrors
// and components/error-dashboard/*.
export type OperationalErrorType =
  | "sync_failure"
  | "api_error"
  | "job_failure"
  | "validation_error"
  | "webhook_error";
export type OperationalErrorSeverity = "critical" | "warning" | "info";
export type OperationalErrorChannel = "ebay" | "kaufland" | "sendcloud" | "internal";
export type OperationalErrorStatus = "open" | "resolved";

export interface OperationalError {
  id: string;
  tenantId?: string;
  type: OperationalErrorType | string;
  severity: OperationalErrorSeverity | string;
  channel: OperationalErrorChannel | string;
  message: string;
  details?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  entityName?: string | null;
  source: string;
  status: OperationalErrorStatus | string;
  fixSuggestion?: string | null;
  createdAt: string | null;
}

export interface ErrorSummary {
  total: number;
  bySeverity: { critical: number; warning: number; info: number };
  byStatus: { open: number; resolved: number };
  byType: Record<string, number>;
  byChannel: Record<string, number>;
}

export interface FetchErrorsParams {
  type?: string;
  channel?: string;
  severity?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export interface FetchErrorsResult {
  errors: OperationalError[];
  total: number;
  page: number;
  pageSize: number;
}

export async function fetchErrors(params: FetchErrorsParams = {}): Promise<FetchErrorsResult> {
  const q = new URLSearchParams();
  if (params.type) q.set("type", params.type);
  if (params.channel) q.set("channel", params.channel);
  if (params.severity) q.set("severity", params.severity);
  if (params.status) q.set("status", params.status);
  if (params.page) q.set("page", String(params.page));
  if (params.pageSize) q.set("pageSize", String(params.pageSize));
  const url = `${BACKEND_URL}/api/errors${q.toString() ? `?${q}` : ""}`;
  const response = await fetchApi(url, { method: "GET" });
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || "Fehler konnten nicht geladen werden.");
  }
  return {
    errors: Array.isArray(result?.errors) ? result.errors : [],
    total: Number(result?.total) || 0,
    page: Number(result?.page) || params.page || 1,
    pageSize: Number(result?.pageSize) || params.pageSize || 50,
  };
}

export async function fetchErrorSummary(): Promise<ErrorSummary> {
  const response = await fetchApi(`${BACKEND_URL}/api/errors/summary`, { method: "GET" });
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || "Fehler-Zusammenfassung konnte nicht geladen werden.");
  }
  return {
    total: Number(result?.total) || 0,
    bySeverity: {
      critical: Number(result?.bySeverity?.critical) || 0,
      warning: Number(result?.bySeverity?.warning) || 0,
      info: Number(result?.bySeverity?.info) || 0,
    },
    byStatus: {
      open: Number(result?.byStatus?.open) || 0,
      resolved: Number(result?.byStatus?.resolved) || 0,
    },
    byType: result?.byType || {},
    byChannel: result?.byChannel || {},
  };
}

export async function resolveError(errorId: string): Promise<void> {
  const response = await fetchApi(
    `${BACKEND_URL}/api/errors/${encodeURIComponent(errorId)}/resolve`,
    { method: "POST" }
  );
  if (!response.ok) {
    const result = await parseResponse(response);
    throw new Error(result?.error?.message || "Fehler konnte nicht als erledigt markiert werden.");
  }
}

export async function endSessionApi(sessionId: string): Promise<void> {
  await fetchApi(`${BACKEND_URL}/api/sessions/${encodeURIComponent(sessionId)}/end`, {
    method: "POST",
  });
}

export async function fetchSessions(params?: {
  userId?: string;
  limit?: number;
  startAfter?: string;
}): Promise<{ ok: boolean; data?: UserSession[] }> {
  const qs = new URLSearchParams();
  if (params?.userId) qs.set("userId", params.userId);
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.startAfter) qs.set("startAfter", params.startAfter);
  const res = await fetchApi(`${BACKEND_URL}/api/admin/sessions?${qs.toString()}`);
  const data = await parseResponse(res);
  return { ok: Boolean(data?.ok), data: data?.data };
}

export async function fetchActiveSessions(): Promise<{ ok: boolean; data?: UserSession[] }> {
  const res = await fetchApi(`${BACKEND_URL}/api/admin/sessions/active`);
  const data = await parseResponse(res);
  return { ok: Boolean(data?.ok), data: data?.data };
}
