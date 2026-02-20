
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Product, WarehouseBin } from './types';
import { useIdentification, UploadGroupPayload } from './hooks/useIdentification';
import { useImproveQueue } from './hooks/useImproveQueue';
import ProductInput from './components/ProductInput';
import ProductSheet from './components/ProductSheet';
import AdminTable from './components/AdminTable';
import WarehouseView from './components/WarehouseView';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { Spinner } from './components/Spinner';
import { Menu, X } from 'lucide-react';
import JobStatusPopup from './components/JobStatusPopup';
import StatusDock from './components/StatusDock';
import Dashboard from './components/Dashboard';
import DashboardMobile from './components/DashboardMobile';
import OperationsView from './components/OperationsView';
import MobileSearchView from './components/MobileSearchView';
import MobileOperationsView from './components/MobileOperationsView';
import MobileTabBar from './components/MobileTabBar';
import { CategoryManagement } from './components/CategoryManagement';
import { EbayListingsView } from './components/EbayListingsView';
import { fetchOrders, fetchProducts, refreshPrice } from './api/client';
import { useI18n } from './i18n';
import { addMediaQueryListener } from './utils/mediaQuery';
import { isInventoryItem, isProductBacklogItem } from './utils/inventorySplit';
import { AuthProvider, useAuth } from './context/AuthContext';
import { InventoryProvider } from './context/InventoryContext';
import { LoginScreen } from './components/LoginScreen';
import { AdminPanel } from './components/admin/AdminPanel';
import { ResetPasswordScreen } from './components/ResetPasswordScreen';

type View =
  | 'dashboard'
  | 'home'
  | 'search'
  | 'admin'
  | 'categories'
  | 'operations'
  | 'operations-identify'
  | 'operations-stow'
  | 'operations-pick'
  | 'operations-pack'
  | 'ebay-listings'
  | 'input'
  | 'sheet'
  | 'inventory'
  | 'products'
  | 'warehouse';
const VIEW_STORAGE_KEY = 'avystock:view';
const VIEW_PRODUCT_KEY = 'avystock:view:productId';
const THEME_STORAGE_KEY = 'avystock:theme';
const DASHBOARD_RANGE_PRESET_STORAGE_KEY = 'avystock:dashboard:rangePreset';
const ALLOWED_VIEWS: View[] = [
  'dashboard',
  'home',
  'search',
  'admin',
  'categories',
  'operations',
  'operations-identify',
  'operations-stow',
  'operations-pick',
  'operations-pack',
  'ebay-listings',
  'input',
  'sheet',
  'inventory',
  'products',
  'warehouse',
];
type Theme = 'light' | 'dark';

const sanitizeIdentifier = (value?: string | null) => {
  if (!value) return null;
  const cleaned = value.toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned || null;
};

const parseHash = (): { view: View; productId: string | null } => {
  if (typeof window === 'undefined') return { view: 'dashboard', productId: null };
  const raw = window.location.hash.replace(/^#/, '').replace(/^\/+/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const [first, second] = segments;

  if (first === 'sheet') {
    const productId = segments[1] || new URLSearchParams(queryPart || '').get('productId') || null;
    return { view: 'sheet', productId };
  }

  if (first === 'operations') {
    const opMap: Record<string, View> = {
      identify: 'operations-identify',
      stow: 'operations-stow',
      pick: 'operations-pick',
      pack: 'operations-pack',
    };
    const mapped = opMap[second || ''] || 'operations';
    return { view: mapped, productId: null };
  }

  if (first === 'ebay') {
    return { view: 'ebay-listings', productId: null };
  }

  if (first && ALLOWED_VIEWS.includes(first as View)) {
    return { view: first as View, productId: null };
  }

  return { view: 'dashboard', productId: null };
};

const parseHashQuery = (): URLSearchParams => {
  if (typeof window === 'undefined') return new URLSearchParams();
  const raw = window.location.hash.replace(/^#/, '').replace(/^\/+/, '');
  const queryPart = raw.split('?')[1] || '';
  return new URLSearchParams(queryPart);
};

const viewToHashPath = (view: View, productId?: string | null) => {
  switch (view) {
    case 'home':
      return '/home';
    case 'search':
      return '/search';
    case 'admin':
      return '/admin';
    case 'operations-identify':
      return '/operations/identify';
    case 'operations-stow':
      return '/operations/stow';
    case 'operations-pick':
      return '/operations/pick';
    case 'operations-pack':
      return '/operations/pack';
    case 'operations':
      return '/operations';
    case 'ebay-listings':
      return '/ebay';
    case 'sheet':
      return productId ? `/sheet/${productId}` : '/sheet';
    default:
      return `/${view}`;
  }
};

const collectIdentityKeys = (product?: Product | null) => {
  const keys = new Set<string>();
  if (!product) return keys;
  const add = (value?: string | null) => {
    const normalized = sanitizeIdentifier(value);
    if (normalized) {
      keys.add(normalized);
    }
  };

  add(product.id);
  add(product.identification?.sku);
  add(product.details?.identifiers?.sku);
  add(product.details?.identifiers?.ean);
  add(product.details?.identifiers?.gtin);
  add(product.details?.identifiers?.upc);

  product.identification?.barcodes?.forEach(add);

  if (product.identification?.brand && product.identification?.name) {
    add(`${product.identification.brand}::${product.identification.name}`);
  } else if (product.identification?.name) {
    add(product.identification.name);
  }

  return keys;
};

const ensureInventoryQuantity = (product: Product, minQuantity = 1): Product => {
  if (product.ops?.last_saved_iso) {
    return product;
  }
  const currentQuantity = product.inventory?.quantity;
  const hasDefinedQuantity =
    typeof currentQuantity === 'number' && Number.isFinite(currentQuantity) && currentQuantity > 0;
  if (hasDefinedQuantity || (product.storageBins && product.storageBins.length > 0)) {
    return product;
  }
  const nextQuantity = Math.max(product.inventory?.quantity ?? 0, minQuantity);
  return {
    ...product,
    inventory: {
      ...(product.inventory ?? {}),
      quantity: nextQuantity,
    },
  };
};

const mergeIdentifiedProducts = (
  incoming: Product[],
  existing: Product[]
): { list: Product[]; focus: Product | null } => {
  if (!incoming.length) {
    return { list: existing, focus: null };
  }
  const updated = [...existing];
  let focus: Product | null = null;

  incoming.forEach((candidate) => {
    const normalizedIncoming = ensureInventoryQuantity(candidate, 1);
    const incomingKeys = collectIdentityKeys(normalizedIncoming);
    const matchIndex = updated.findIndex((item) => {
      if (!item) return false;
      const existingKeys = collectIdentityKeys(item);
      for (const key of incomingKeys) {
        if (existingKeys.has(key)) {
          return true;
        }
      }
      return false;
    });

    if (matchIndex >= 0) {
      const matched = updated[matchIndex];
      const existingPersisted = Boolean(matched?.ops?.last_saved_iso);
      const incomingPersisted = Boolean(normalizedIncoming?.ops?.last_saved_iso);

      if (existingPersisted && !incomingPersisted) {
        const reuse: Product = {
          ...matched,
          inventory: normalizedIncoming.inventory?.inventoryId
            ? {
              ...(matched.inventory || {}),
              inventoryId: normalizedIncoming.inventory.inventoryId,
              inventoryName:
                normalizedIncoming.inventory.inventoryName ?? matched.inventory?.inventoryName ?? null,
              quantity: normalizedIncoming.inventory.quantity ?? matched.inventory?.quantity,
            }
            : matched.inventory,
          ops: {
            ...(matched.ops || {}),
            pending_intake_quantity:
              normalizedIncoming.ops?.pending_intake_quantity ??
              matched.ops?.pending_intake_quantity,
          },
        };
        updated[matchIndex] = reuse;
        focus = reuse;
        return;
      }

      const merged: Product = {
        ...matched,
        ...normalizedIncoming,
        inventory: normalizedIncoming.inventory || matched.inventory || undefined,
        storage: normalizedIncoming.storage ?? matched.storage ?? null,
        ops: {
          ...(matched.ops || {}),
          ...(normalizedIncoming.ops || {}),
        },
      };
      updated[matchIndex] = merged;
      focus = merged;
    } else {
      updated.unshift(normalizedIncoming);
      focus = normalizedIncoming;
    }
  });

  return { list: updated, focus };
};

const VIEW_MIGRATIONS: Partial<Record<string, View>> = {
  // Historical: "admin" used to be the product list; keep behavior stable.
  admin: 'products',
  // Historical: "inventory" used to be the full product list; keep behavior stable.
  inventory: 'products',
  home: 'home',
  search: 'search',
  ebay: 'ebay-listings',
};

const readInitialView = (): { view: View; productId: string | null } => {
  if (typeof window === 'undefined') return { view: 'dashboard', productId: null };
  const fromHash = parseHash();
  if (fromHash.view !== 'dashboard' || fromHash.productId) return fromHash;
  const stored = window.localStorage.getItem(VIEW_STORAGE_KEY) as View | string | null;
  if (stored) {
    const migrated = VIEW_MIGRATIONS[stored] || stored;
    if (ALLOWED_VIEWS.includes(migrated as View)) {
      return { view: migrated as View, productId: null };
    }
  }
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  return { view: isMobile ? 'home' : 'dashboard', productId: null };
};

const readInitialTheme = (): Theme => {
  if (typeof window === 'undefined') {
    return 'dark';
  }
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
};

const readInitialDashboardRangePreset = (): string => {
  if (typeof window === 'undefined') return 'last7';
  try {
    const stored = window.localStorage.getItem(DASHBOARD_RANGE_PRESET_STORAGE_KEY);
    const v = (stored || '').toString().trim();
    const allowed = new Set(['last7', 'month_to_date', 'last_month', 'year_to_date', 'last_year', 'today']);
    if (!v) return 'last7';
    return allowed.has(v) ? v : 'last7';
  } catch {
    return 'last7';
  }
};

const AppInner: React.FC = () => {
  const { t } = useI18n();
  const { hasPermission } = useAuth();
  const [{ view: initialView, productId: initialHashProductId }] = useState(() => readInitialView());
  const [view, setView] = useState<View>(initialView);
  const [initialProductId] = useState<string | null>(initialHashProductId);
  const [products, setProducts] = useState<Product[]>([]);
  const [productsLoading, setProductsLoading] = useState<boolean>(false);
  const [productsError, setProductsError] = useState<string | null>(null);
  const productsRef = useRef<Product[]>([]);
  const [currentProduct, setCurrentProduct] = useState<Product | null>(null);
  const {
    enqueueIdentification,
    jobStatuses,
    isLoading: jobsRunning,
    error: identificationError,
    cancelJob,
    dismissJob,
    clearError,
  } = useIdentification({
    onJobCompleted: (bundle) => {
      if (!bundle?.products?.length) {
        return;
      }
      let nextFocus: Product | null = null;
      setProducts((prev) => {
        const merged = mergeIdentifiedProducts(bundle.products, prev);
        nextFocus = merged.focus;
        return merged.list;
      });
      const focusProduct = nextFocus as Product | null;
      if (focusProduct) {
        setCurrentProduct(focusProduct);
        setInventoryFocusId(focusProduct.id);
        setView('sheet');
      }
    },
  });
  const [theme, setTheme] = useState<Theme>(() => readInitialTheme());
  const [dashboardRangePreset, setDashboardRangePreset] = useState<string>(() => readInitialDashboardRangePreset());
  const [warehouseRefresh, setWarehouseRefresh] = useState<WarehouseBin | null>(null);
  const [inventoryFocusId, setInventoryFocusId] = useState<string | null>(null);
  const [hashQueryString, setHashQueryString] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    const raw = window.location.hash.replace(/^#/, '').replace(/^\/+/, '');
    return raw.split('?')[1] || '';
  });
  const [drilldownProductIds, setDrilldownProductIds] = useState<Set<string> | null>(null);
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 768px)').matches : false
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const historyReadyRef = useRef(false);
  const skipNextHistoryPushRef = useRef(false);
  const lastHistoryStateRef = useRef<{ view: View; productId: string | null } | null>(null);
  const initialProductHydratedRef = useRef(false);
  const viewRef = useRef<View>(initialView);

  const loadProducts = useCallback(async () => {
    setProductsLoading(true);
    try {
      const list = await fetchProducts();
      setProducts(list);
      setProductsError(null);
    } catch (error: any) {
      console.error('Failed to load products:', error);
      setProductsError(error?.message || t('error.products'));
    } finally {
      setProductsLoading(false);
    }
  }, [t]);

  // Load products from backend on mount + lightweight polling
  useEffect(() => {
    loadProducts();
    const interval = setInterval(() => {
      loadProducts();
    }, 60000);
    return () => clearInterval(interval);
  }, [loadProducts]);

  // keep hash + storage in sync when view changes (for back/forward navigation)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const target = viewToHashPath(view, currentProduct?.id).replace(/^#/, '').replace(/^\/+/, '');
    const current = window.location.hash.replace(/^#/, '').replace(/^\/+/, '');
    const currentPath = current.split('?')[0] || '';
    const targetPath = target.split('?')[0] || '';
    // Preserve hash query params (e.g. drilldowns like ?orderStatus=neu) when staying on same view.
    if (currentPath !== targetPath) {
      window.location.hash = `#${target}`;
    }
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, view);
    } catch {
      // ignore storage errors
    }
  }, [view, currentProduct?.id]);

  // Handle deep linking for products once loaded
  useEffect(() => {
    if (products.length === 0) return;
    const { view: v, productId } = parseHash();
    if (v === 'sheet' && productId) {
      const product = products.find((p) => p.id === productId);
        if (product) {
          setCurrentProduct(product);
          setInventoryFocusId(product.id);
      }
    }
  }, [products]);

  useEffect(() => {
    productsRef.current = products;
  }, [products]);

  const handleProductImproved = useCallback(
    (product: Product) => {
      setProducts((prev) => prev.map((p) => (p.id === product.id ? product : p)));
      if (currentProduct?.id === product.id) {
        setCurrentProduct(product);
      }
    },
    [currentProduct]
  );

  const resolveProductLabel = useCallback((productId: string) => {
    const product = productsRef.current.find((p) => p.id === productId);
    if (!product) return `Produkt ${productId}`;
    const parts = [product.identification?.brand, product.identification?.name].filter(Boolean);
    return parts.join(' ') || `Produkt ${productId}`;
  }, []);

  const {
    enqueueImproveJobs,
    trackJobs,
    jobStatuses: improveJobStatuses,
    activeProductIds,
    error: improveError,
    clearError: clearImproveError,
    dismissJob: dismissImproveJob,
  } = useImproveQueue({
    onProductImproved: handleProductImproved,
    resolveLabel: resolveProductLabel,
  });

  const handleIdentification = useCallback(
    (
      groupsPayload: UploadGroupPayload[],
      barcodes: string
    ) => {
      // Single identify pipeline (v2) only.
      enqueueIdentification(groupsPayload, barcodes, null, null);
    },
    [enqueueIdentification]
  );

  const handleUpdateProduct = (updatedProduct: Product) => {
    setProducts(prevProducts =>
      prevProducts.map(p => (p.id === updatedProduct.id ? updatedProduct : p))
    );
    if (currentProduct?.id === updatedProduct.id) {
      setCurrentProduct(updatedProduct);
    }
  };

  const handleBinStockChanged = (bin: WarehouseBin) => {
    setWarehouseRefresh(bin);
  };

  const handleImproveProduct = useCallback(
    async (productId: string) => {
      if (!productId) return;
      enqueueImproveJobs([productId]);
    },
    [enqueueImproveJobs]
  );

  const handleImproveSelected = useCallback(
    async (productIds: string[]) => {
      if (!productIds.length) return;
      enqueueImproveJobs(productIds);
    },
    [enqueueImproveJobs]
  );

  const handleBulkImprove = useCallback(async () => {
    if (!confirm(t('improve.bulk.confirm'))) return;
    try {
      const ids = productsRef.current.map((p) => p.id).filter(Boolean);
      if (!ids.length) {
        alert(t('improve.bulk.noProducts'));
        return;
      }
      // Bulk improve uses the same queue-based improve jobs, but created in safe batches in useImproveQueue.
      enqueueImproveJobs(ids);
    } catch (err: any) {
      alert(`${t('chat.ui.errorPrefix')} ${err.message}`);
    }
  }, [enqueueImproveJobs, t]);

  useEffect(() => {
    if (!improveError) return;
    alert(improveError);
    clearImproveError();
  }, [improveError, clearImproveError]);

  const handleSelectProduct = (productId: string) => {
    const product = products.find(p => p.id === productId);
    if (product) {
      setCurrentProduct(product);
      setInventoryFocusId(product.id);
      setView('sheet');
    }
  };


  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // Operations desktop gating: keep mobile flow intact, but avoid using OperationsView on desktop.
  useEffect(() => {
    if (isMobile) return;
    if (!view || typeof view !== 'string') return;
    if (view.startsWith('operations')) {
      setView('dashboard');
    }
  }, [isMobile, view]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore storage issues (private mode, etc.)
    }
  }, [theme]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(DASHBOARD_RANGE_PRESET_STORAGE_KEY, dashboardRangePreset);
    } catch {
      // ignore storage issues (private mode, etc.)
    }
  }, [dashboardRangePreset]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem(THEME_STORAGE_KEY)) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event: MediaQueryListEvent) => {
      setTheme(event.matches ? 'dark' : 'light');
    };
    const detach = addMediaQueryListener(media, listener);
    return () => detach();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 768px)');
    const mqHandler = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    mq.addEventListener('change', mqHandler);

    historyReadyRef.current = true;

    const applyHash = () => {
      const { view: nextView, productId } = parseHash();
      const q = window.location.hash.replace(/^#/, '').replace(/^\/+/, '').split('?')[1] || '';
      setHashQueryString((prev) => (prev === q ? prev : q));
      if (nextView !== viewRef.current) {
        setView(nextView);
      }
      if (productId) {
        const product = productsRef.current.find((p) => p.id === productId) || null;
        setCurrentProduct(product);
        if (product) setInventoryFocusId(product.id);
      } else if (nextView !== 'sheet') {
        setCurrentProduct(null);
      }
    };

    applyHash(); // initial hydrate
    window.addEventListener('hashchange', applyHash);
    return () => {
      window.removeEventListener('hashchange', applyHash);
      mq.removeEventListener('change', mqHandler);
    };
  }, []);

  const orderStatusParam = useMemo(() => {
    const qs = new URLSearchParams(hashQueryString || '');
    const raw = qs.get('orderStatus');
    return raw ? String(raw).trim().toLowerCase() : '';
  }, [hashQueryString]);

  const skuEanToProductId = useMemo(() => {
    const map = new Map<string, string>();
    const normSku = (v: any) =>
      String(v || '')
        .trim()
        .toLowerCase()
        .replace(/^sku[-\s]*/i, '')
        .replace(/\s+/g, '');
    const normEan = (v: any) => String(v || '').replace(/\D+/g, '').trim();
    for (const p of products) {
      const sku = normSku(p?.identification?.sku || p?.details?.identifiers?.sku || '');
      if (sku) map.set(`sku:${sku}`, p.id);
      const ean = normEan(p?.details?.identifiers?.ean || p?.details?.identifiers?.gtin || p?.details?.identifiers?.upc || '');
      if (ean) map.set(`ean:${ean}`, p.id);
      const barcodes = Array.isArray(p?.identification?.barcodes) ? p.identification.barcodes : [];
      for (const b of barcodes) {
        const bn = normEan(b);
        if (bn) map.set(`ean:${bn}`, p.id);
      }
    }
    return map;
  }, [products]);

  useEffect(() => {
    // Dashboard drilldown: #/inventory?orderStatus=neu or #/products?orderStatus=kommissioniert ...
    if (!(view === 'inventory' || view === 'products')) {
      if (drilldownProductIds) setDrilldownProductIds(null);
      return;
    }
    if (!orderStatusParam) {
      if (drilldownProductIds) setDrilldownProductIds(null);
      return;
    }
    if (!hasPermission('orders', 'read')) {
      // If user can't read orders, keep list usable (no filter).
      if (drilldownProductIds) setDrilldownProductIds(null);
      return;
    }

    let cancelled = false;
    const normalize = (v: any) => String(v || '').toLowerCase();
    const categorize = (order: any): string => {
      const raw = normalize(order?.statusLabel || order?.status || '');
      if (order?.status === 'new' || raw.includes('neu') || raw.includes('new')) return 'neu';
      if (raw.includes('kommission') || raw.includes('picked') || order?.status === 'picked') return 'kommissioniert';
      if (raw.includes('verpackt') || raw.includes('packed') || order?.status === 'packed') return 'verpackt';
      if (raw.includes('versendet') || raw.includes('shipped') || raw.includes('dispatched')) return 'versendet';
      if (raw.includes('zugestellt') || raw.includes('delivered')) return 'zugestellt';
      return 'other';
    };

    (async () => {
      try {
        const orders = await fetchOrders(200, { timeoutMs: 25000 });
        if (cancelled) return;
        const ids = new Set<string>();
        for (const order of orders || []) {
          if (categorize(order) !== orderStatusParam) continue;
          const items = Array.isArray((order as any)?.items) ? (order as any).items : [];
          for (const item of items) {
            const fromHint = (item as any)?.pickHint?.productId;
            const direct = (item as any)?.productId;
            const pid = (fromHint || direct) ? String(fromHint || direct) : '';
            if (pid) {
              ids.add(pid);
              continue;
            }
            const sku = String((item as any)?.sku || '').trim();
            const ean = String((item as any)?.ean || '').trim();
            const normSkuKey = sku
              ? `sku:${sku.toLowerCase().replace(/^sku[-\s]*/i, '').replace(/\s+/g, '')}`
              : '';
            const normEanKey = ean ? `ean:${ean.replace(/\D+/g, '').trim()}` : '';
            const mapped =
              (normSkuKey && skuEanToProductId.get(normSkuKey)) ||
              (normEanKey && skuEanToProductId.get(normEanKey)) ||
              null;
            if (mapped) ids.add(mapped);
          }
        }
        setDrilldownProductIds(ids);
      } catch (e) {
        // Best-effort: drilldown is optional; keep table usable.
        if (!cancelled) setDrilldownProductIds(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [view, orderStatusParam, hasPermission, skuEanToProductId]);

  const toggleTheme = useCallback(() => {
    setTheme(prev => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  // Hydrate initial product after products are loaded (for refresh)
  useEffect(() => {
    if (initialProductHydratedRef.current) return;
    if (!products.length) return;
    if (!initialProductId) {
      initialProductHydratedRef.current = true;
      return;
    }
    const product = products.find((p) => p.id === initialProductId);
    if (product) {
      setCurrentProduct(product);
      setInventoryFocusId(product.id);
      if (view === 'sheet') {
        // keep sheet
      } else {
        // if stored view was different, keep it; we only set product, not force view
      }
    }
    initialProductHydratedRef.current = true;
  }, [products, initialProductId, view]);

  // Keep the currently opened product sheet in sync with the latest product list.
  // This prevents stale quantities (e.g., after warehouse stock changes) from lingering in ProductSheet.
  // ProductSheet itself will ignore prop refreshes while the user is actively editing/dirty.
  useEffect(() => {
    if (!currentProduct?.id) return;
    const updated = products.find((p) => p.id === currentProduct.id) || null;
    if (!updated) return;
    // Avoid re-setting state if nothing materially changed (best-effort shallow check).
    if (updated === currentProduct) return;
    setCurrentProduct(updated);
    setInventoryFocusId(updated.id);
  }, [products, currentProduct?.id]);

  const renderView = () => {
    switch (view) {
      case 'home':
        return isMobile ? (
          <DashboardMobile
            products={products}
            onRefreshProducts={loadProducts}
            onNavigate={(next) => setView(next as View)}
            isLoading={productsLoading}
            rangePreset={dashboardRangePreset}
            onRangePresetChange={setDashboardRangePreset}
          />
        ) : (
          <Dashboard
            products={products}
            onSelectProduct={handleSelectProduct}
            onRefreshProducts={loadProducts}
            rangePreset={dashboardRangePreset}
            onRangePresetChange={setDashboardRangePreset}
          />
        );
      case 'search':
        return isMobile ? (
          <MobileSearchView products={products} onSelectProduct={handleSelectProduct} isLoading={productsLoading} />
        ) : (
          <AdminTable
            products={products}
            onSelectProduct={handleSelectProduct}
            onUpdateProducts={setProducts}
            focusProductId={inventoryFocusId}
            onImproveProduct={handleImproveProduct}
            onImproveSelected={handleImproveSelected}
            onBulkImprove={handleBulkImprove}
            improvingProductIds={activeProductIds}
          />
        );
      case 'operations':
      case 'operations-identify':
      case 'operations-stow':
      case 'operations-pick':
      case 'operations-pack':
        if (isMobile) {
          return (
            <MobileOperationsView
              products={products}
              mode={view}
              onNavigate={setView}
              onSelectProduct={handleSelectProduct}
              onIdentify={handleIdentification}
            />
          );
        }
        return (
          <OperationsView
            products={products}
            onProductUpdate={handleUpdateProduct}
            onStockChanged={handleBinStockChanged}
            onSwitchView={setView}
          />
        );
      case 'sheet':
        return currentProduct ? (
          <ProductSheet
            product={currentProduct}
            onUpdate={handleUpdateProduct}
            onImprove={handleImproveProduct}
            isImproving={Boolean(currentProduct && activeProductIds.has(currentProduct.id))}
          />
        ) : (
          <div className="text-center p-8 text-[color:var(--text-tertiary)]">{t('app.sheet.empty')}</div>
        );
      case 'inventory':
      case 'products':
        if (!hasPermission('products', 'read')) {
          return <div className="text-center p-8 text-[color:var(--text-tertiary)]">{t('error.forbidden')}</div>;
        }
        return (
          <AdminTable
            products={products}
            onSelectProduct={handleSelectProduct}
            onUpdateProducts={setProducts}
            focusProductId={inventoryFocusId}
            onImproveProduct={handleImproveProduct}
            onImproveSelected={handleImproveSelected}
            onBulkImprove={handleBulkImprove}
            improvingProductIds={activeProductIds}
            mode={view}
            scopeProductIds={drilldownProductIds}
          />
        );
      case 'categories':
        if (!(hasPermission('categories', 'read') || hasPermission('categories', 'write'))) {
          return <div className="text-center p-8 text-[color:var(--text-tertiary)]">{t('error.forbidden')}</div>;
        }
        return <CategoryManagement />;
      case 'ebay-listings':
        if (!(hasPermission('products', 'read') || hasPermission('products', 'write'))) {
          return <div className="text-center p-8 text-[color:var(--text-tertiary)]">{t('error.forbidden')}</div>;
        }
        return <EbayListingsView />;
      case 'admin':
        if (
          !(
            hasPermission('admin', 'users.read') ||
            hasPermission('admin', 'roles.read') ||
            hasPermission('admin', 'groups.read') ||
            hasPermission('admin', 'llm.read') ||
            hasPermission('admin', 'reports.read')
          )
        ) {
          return <div className="text-center p-8 text-[color:var(--text-tertiary)]">{t('error.forbidden')}</div>;
        }
        return <AdminPanel />;
      case 'warehouse':
        if (!(hasPermission('warehouse', 'read') || hasPermission('warehouse', 'write'))) {
          return <div className="text-center p-8 text-[color:var(--text-tertiary)]">{t('error.forbidden')}</div>;
        }
        return <WarehouseView refreshBin={warehouseRefresh} onRefreshBinConsumed={() => setWarehouseRefresh(null)} />;
      case 'dashboard':
        return isMobile ? (
          <DashboardMobile
            products={products}
            onRefreshProducts={loadProducts}
            onNavigate={(next) => setView(next as View)}
            isLoading={productsLoading}
            rangePreset={dashboardRangePreset}
            onRangePresetChange={setDashboardRangePreset}
          />
        ) : (
          <Dashboard
            products={products}
            onSelectProduct={handleSelectProduct}
            onRefreshProducts={loadProducts}
            rangePreset={dashboardRangePreset}
            onRangePresetChange={setDashboardRangePreset}
          />
        );
      case 'input':
      default:
        if (!hasPermission('identify', 'run')) {
          return <div className="text-center p-8 text-[color:var(--text-tertiary)]">{t('error.forbidden')}</div>;
        }
        return <ProductInput onIdentify={handleIdentification} />;
    }
  };

  const renderLoadState = () => {
    if (productsLoading && products.length === 0) {
      return (
        <div className="flex items-center justify-center h-[calc(100vh-10rem)] text-[color:var(--text-primary)]">
          <div className="bg-[var(--surface-secondary)]/80 border border-[var(--border)] rounded-2xl px-6 py-5 shadow-xl text-center space-y-2">
            <p className="text-lg font-semibold">{t('status.loading.products')}</p>
            <p className="text-sm text-[color:var(--text-tertiary)]">{t('status.loading.hint')}</p>
          </div>
        </div>
      );
    }
    return renderView();
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)', color: 'var(--text-primary)' }}>
      {/* Desktop Sidebar */}
      {!isMobile && <Sidebar currentView={view} setView={setView} productCount={products.length || undefined} />}

      {/* Mobile Sidebar Overlay */}
      {isMobile && mobileMenuOpen && (
        <>
          <div className="sidebar-overlay" onClick={() => setMobileMenuOpen(false)} />
          <div className="sidebar open">
            <Sidebar currentView={view} setView={setView} onClose={() => setMobileMenuOpen(false)} />
          </div>
        </>
      )}

      {/* Main Content Area */}
      <div className="main" style={isMobile ? { marginLeft: 0 } : undefined}>
        {/* Mobile Header */}
        {isMobile && (
          <div className="mobile-header">
            <button className="hamburger" onClick={() => setMobileMenuOpen(true)}>
              <Menu size={22} />
            </button>
            <span className="mobile-brand">AvyCloud</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
              <button
                className="topbar-btn"
                style={{ color: 'rgba(255,255,255,0.7)' }}
                onClick={toggleTheme}
              >
                {theme === 'dark' ? (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="3.5"/><path d="M8 1.5v1M8 13.5v1M1.5 8h1M13.5 8h1"/></svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M13.5 8.5A5.5 5.5 0 117.5 2.5a4 4 0 006 6z"/></svg>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Desktop Topbar */}
        {!isMobile && <Topbar theme={theme} onToggleTheme={toggleTheme} />}

        <main className="content safe-area-content">
          {productsError && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '12px 16px', borderRadius: 'var(--radius-lg)', background: 'var(--error-bg)', border: '1px solid var(--error-border)', marginBottom: 'var(--space-4)', fontSize: 13 }}>
              <span style={{ color: 'var(--error)', flex: 1 }}>{productsError}</span>
              <button
                type="button"
                onClick={loadProducts}
                className="btn btn-danger btn-sm"
              >
                {t('error.reload')}
              </button>
            </div>
          )}
          {identificationError && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '12px 16px', borderRadius: 'var(--radius-lg)', background: 'var(--error-bg)', border: '1px solid var(--error-border)', marginBottom: 'var(--space-4)', fontSize: 13 }}>
              <span style={{ color: 'var(--error)', flex: 1 }}>{identificationError}</span>
              <button
                type="button"
                onClick={clearError}
                className="btn btn-ghost btn-sm"
              >
                {t('common.close')}
              </button>
            </div>
          )}
          {renderLoadState()}
        </main>

        {/* Mobile Bottom Tabs */}
        {isMobile && (
          <div className="sm:hidden fixed left-0 right-0 bottom-0 z-40">
            <MobileTabBar
              currentView={view}
              onNavigate={(next) => {
                setView(next as View);
              }}
              theme={theme}
            />
          </div>
        )}
      </div>

      {/* Job Status Overlay */}
      {(jobsRunning || jobStatuses.length > 0 || improveJobStatuses.length > 0) && (
        <>
          {jobsRunning && (
            <div style={{ position: 'fixed', bottom: 24, left: isMobile ? 16 : 272, zIndex: 40, display: 'flex', alignItems: 'center', gap: 12, borderRadius: 'var(--radius-lg)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '12px 16px', boxShadow: 'var(--shadow-lg)', maxWidth: 340 }}>
              <Spinner className="w-5 h-5" style={{ color: 'var(--avy-purple)' }} />
              <div style={{ fontSize: 13 }}>
                <p style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{t('status.backgroundUploads.title')}</p>
                <p style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t('status.backgroundUploads.subtitle')}</p>
              </div>
            </div>
          )}
          <JobStatusPopup
            jobs={[...jobStatuses, ...improveJobStatuses]}
            onCancel={cancelJob}
            onDismiss={(id) => {
              dismissJob(id);
              dismissImproveJob(id);
            }}
          />
          <StatusDock
            identifyActive={jobStatuses.filter((j) => !j.finishedAt && j.phase !== 'error').length}
            identifyTotal={jobStatuses.length}
            improveActive={improveJobStatuses.filter((j) => !j.finishedAt && j.phase !== 'error').length}
            improveTotal={improveJobStatuses.length}
          />
        </>
      )}
    </div>
  );
};

const AuthGate: React.FC = () => {
  const { t } = useI18n();
  const { user, loading, initError, isAdmin, logout } = useAuth();

  // Public auth flows (password reset / email verification) must be reachable without login.
  if (typeof window !== 'undefined') {
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    if (path === '/reset-password') {
      return <ResetPasswordScreen />;
    }
  }

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderRadius: 'var(--radius-lg)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '20px 24px', boxShadow: 'var(--shadow-md)' }}>
          <Spinner className="w-5 h-5" style={{ color: 'var(--avy-purple)' }} />
          <div style={{ fontSize: 13 }}>
            <p style={{ fontWeight: 600 }}>{t('auth.loading.title')}</p>
            <p style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t('auth.loading.subtitle')}</p>
          </div>
        </div>
      </div>
    );
  }

  if (initError) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px' }}>
        <div style={{ width: '100%', maxWidth: 640, borderRadius: 'var(--radius-xl)', background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)', padding: 24 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>{t('auth.devSetup.title')}</h1>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 16 }}>
            {t('auth.devSetup.description')}
          </p>
          <div style={{ borderRadius: 'var(--radius-md)', background: 'var(--error-bg)', border: '1px solid var(--error-border)', padding: '12px 16px', fontSize: 13, color: 'var(--error)', marginBottom: 16 }}>
            {initError}
          </div>
          <div style={{ fontSize: 14 }}>
            <p style={{ fontWeight: 600, marginBottom: 8 }}>{t('auth.devSetup.fixTitle')}</p>
            <ol style={{ listStyle: 'decimal inside', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <li>
                {t('auth.devSetup.fix.step1.before')}{' '}
                <span className="font-mono">.env.local</span> {t('auth.devSetup.fix.step1.after')}
              </li>
              <li>
                {t('auth.devSetup.fix.step2.prefix')}{' '}
                <span className="font-mono">VITE_FIREBASE_API_KEY</span>,{' '}
                <span className="font-mono">VITE_FIREBASE_AUTH_DOMAIN</span>,{' '}
                <span className="font-mono">VITE_FIREBASE_PROJECT_ID</span>,{' '}
                <span className="font-mono">VITE_FIREBASE_APP_ID</span>.
              </li>
              <li>{t('auth.devSetup.fix.step3')}</li>
            </ol>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen />;
  }

  if (!isAdmin && !user.emailVerified) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px' }}>
        <div style={{ width: '100%', maxWidth: 480, borderRadius: 'var(--radius-xl)', background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>{t('auth.verifyEmail.title')}</h1>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
            {t('auth.verifyEmail.description')}
          </p>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {t('auth.verifyEmail.signedInAs')}: <span style={{ color: 'var(--text-primary)' }}>{user.email}</span>
          </div>
          <button
            type="button"
            onClick={() => logout()}
            className="btn btn-secondary"
          >
            {t('common.logout')}
          </button>
        </div>
      </div>
    );
  }

  return <AppInner />;
};

const App: React.FC = () => (
  <AuthProvider>
    <InventoryProvider>
      <AuthGate />
    </InventoryProvider>
  </AuthProvider>
);

export default App;
