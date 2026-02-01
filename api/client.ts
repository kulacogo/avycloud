
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

  // In production, use env or default to stable Cloud Run service URL (NOT revision-specific).
  // This avoids stale/cached builds calling an old URL.
  return envUrl || 'https://product-hub-backend-sa6a4cbk3q-ey.a.run.app';
})();

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

const fetchApi = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const attempt = async (forceRefresh: boolean) => {
    const headers = await buildHeadersWithAuth(init.headers, forceRefresh);
    return await fetch(input, { ...init, headers });
  };

  const res = await attempt(false);
  // If we get a 401, try forcing a token refresh once.
  if (res.status === 401 && tokenProvider) {
    try {
      const retry = await attempt(true);
      return retry;
    } catch {
      return res;
    }
  }
  return res;
};

const openAuthedUrlInNewTab = (url: string, opts?: { timeoutMs?: number }) => {
  // IMPORTANT: include noreferrer for Safari/Chromium edge cases where 'noopener' alone may behave inconsistently.
  const popup = window.open('about:blank', '_blank', 'noopener,noreferrer');
  if (!popup) {
    return { ok: false, error: { code: 0, message: 'Popup wurde blockiert. Bitte Popups erlauben.' } };
  }

  (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs || 25000);
    try {
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

export async function searchEbayCategories({ q, id, limit = 50 }: { q?: string; id?: string; limit?: number }) {
  const url = new URL(`${BACKEND_URL}/api/ebay/categories`);
  if (q) url.searchParams.set('q', q);
  if (id) url.searchParams.set('id', id);
  url.searchParams.set('limit', String(limit));
  const res = await fetchApi(url.toString(), { method: 'GET' });
  const data = await parseResponse(res);
  return (data?.items || []) as EbayCategoryOption[];
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

export type AdminLlmScopeDetail = {
  scope: AdminLlmScopeRecord;
  versions: Array<{
    id: string;
    promptText?: string;
    rulesText?: string;
    promptMode?: 'append' | 'replace';
    rulesMode?: 'append' | 'replace';
    note?: string | null;
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

export type ProductBulkActionName = 'title' | 'price' | 'category' | 'ktype' | 'export_marketplace';

export const runProductBulkAction = async (params: {
  action: ProductBulkActionName;
  productIds: string[];
  apply?: boolean; // default true
  debug?: boolean;
  maxAgeDays?: number; // price
  includeUi?: boolean; // title
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
  version: { promptText: string; rulesText: string; promptMode?: 'append' | 'replace'; rulesMode?: 'append' | 'replace'; note?: string }
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
    return await fetchApi(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const fetchJobStatus = async (jobId: string, signal?: AbortSignal) => {
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

export const fetchProducts = async (): Promise<Product[]> => {
  const response = await fetchApi(`${BACKEND_URL}/api/products`);
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

// --- The rest of the functions remain as mocks for now ---
// In a real application, these would also be implemented on the backend.

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
      console.log('API CALL: /api/baselinker/sync/jobs', { count: products.length, inventoryId: inv });
    }

    // Always use async jobs to avoid long-running HTTP requests (prevents browser/proxy "failed to fetch").
    const ids = products.map((p) => p?.id).filter(Boolean) as string[];
    response = await fetchApi(`${BACKEND_URL}/api/baselinker/sync/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ productIds: ids, inventoryId: inv }),
    });

    const created = await parseResponse(response);

    if (!response.ok) {
      throw new Error(created?.error?.message || `Request failed with status ${response.status}`);
    }

    const jobId = created?.jobId;
    if (!jobId) {
      throw new Error('Backend returned invalid sync job response (jobId missing).');
    }

    // Poll job until done/failed
    const startedAt = Date.now();
    const TIMEOUT_MS = 12 * 60 * 1000; // 12 minutes
    while (Date.now() - startedAt < TIMEOUT_MS) {
      const jobRes = await fetchApi(`${BACKEND_URL}/api/baselinker/sync/jobs/${encodeURIComponent(jobId)}`, {
        method: 'GET',
      });
      const jobPayload = await parseResponse(jobRes);
      if (!jobRes.ok) {
        throw new Error(jobPayload?.error?.message || 'Failed to load sync job status.');
      }
      const job = jobPayload?.data;
      const status = job?.status;
      if (status === 'done' || status === 'failed') {
        const results = Array.isArray(job?.result?.results) ? job.result.results : [];
        const failed = results.filter((r: any) => r.status === 'failed');
        return {
          ok: failed.length === 0 && status === 'done',
          results,
          error:
            failed.length > 0 || status === 'failed'
              ? { code: 502, message: failed.map((f: any) => `${f.id}: ${f.message || 'Sync failed'}`).join(' | ') || (job?.error?.message || 'Sync failed') }
              : undefined,
        };
      }
      await new Promise((r) => setTimeout(r, 1200));
    }

    throw new Error('Sync job timed out while waiting for completion.');

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
    response = await fetchApi(`${BACKEND_URL}/api/baselinker/lookup`, {
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
    studio?: { front?: string; detail?: string; topdown?: string };
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
      return {
        ok: false,
        error: {
          code: response.status,
          message: result?.error?.message || 'SerpAPI-freies Enrichment fehlgeschlagen.',
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
  inventoryId?: string
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

  let response: Response | undefined;
  try {
    response = await fetchApi(`${BACKEND_URL}/api/v2/identify`, {
      method: 'POST',
      body: formData,
    });
    const result = await parseResponse(response);
    if (!response.ok) {
      return {
        ok: false,
        error: {
          code: response.status,
          message: result?.error?.message || 'Identify (v2) fehlgeschlagen.',
        },
      };
    }
    const product = result?.data ? normalizeProduct(result.data) : undefined;
    return { ok: true, data: product, meta: result?.meta };
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
