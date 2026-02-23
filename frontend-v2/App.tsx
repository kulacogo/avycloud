
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Product, WarehouseBin } from './types';
import { useIdentification, UploadGroupPayload } from './hooks/useIdentification';
import { useImproveQueue } from './hooks/useImproveQueue';
import { fetchOrders, fetchProducts, refreshPrice } from './api/client';
import { useI18n } from './i18n';
import { addMediaQueryListener } from './utils/mediaQuery';
import { isInventoryItem, isProductBacklogItem } from './utils/inventorySplit';
import { AuthProvider, useAuth } from './context/AuthContext';
import { InventoryProvider } from './context/InventoryContext';

// Routing
import {
  View,
  ALLOWED_VIEWS,
  VIEW_STORAGE_KEY,
  VIEW_PRODUCT_KEY,
  parseHash,
  parseHashQuery,
  viewToHashPath,
  VIEW_MIGRATIONS,
  readInitialView,
} from './router';

// State helpers
import { mergeIdentifiedProducts } from './state/products';
import {
  Theme,
  THEME_STORAGE_KEY,
  DASHBOARD_RANGE_PRESET_STORAGE_KEY,
  readInitialTheme,
  readInitialDashboardRangePreset,
} from './state/app';

// Layout & UI
import { Spinner } from './components/ui/Spinner';

// Views (components imported from their future locations)
import ProductInput from './components/views/ProductInput';
import ProductSheet from './components/views/ProductSheet';
import AdminTable from './components/views/AdminTable';
import WarehouseView from './components/views/WarehouseView';
import Dashboard from './components/views/Dashboard';
import DashboardMobile from './components/views/DashboardMobile';
import OperationsView from './components/views/OperationsView';
import MobileSearchView from './components/views/MobileSearchView';
import MobileOperationsView from './components/views/MobileOperationsView';
import { CategoryManagement } from './components/views/CategoryManagement';
import { EbayAuditView } from './components/views/EbayAuditView';
import { AdminPanel } from './components/admin/AdminPanel';

// Layout shell (v2.1 design system)
import { AppShell } from './components/layout/AppShell';
import JobStatusPopup from './components/shared/JobStatusPopup';
import StatusDock from './components/shared/StatusDock';
import { LoginScreen } from './components/views/LoginScreen';
import { ResetPasswordScreen } from './components/views/ResetPasswordScreen';

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
  const historyReadyRef = useRef(false);
  const skipNextHistoryPushRef = useRef(false);
  const lastHistoryStateRef = useRef<{ view: View; productId: string | null } | null>(null);
  const initialProductHydratedRef = useRef(false);
  const viewRef = useRef<View>(initialView);

  // ---------------------------------------------------------------------------
  // Product loading
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Hash / view sync
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Product callbacks
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // View / theme side effects
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Hash change listener + mobile media query
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Dashboard drilldown logic
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Initial product hydration (refresh)
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // View rendering
  // ---------------------------------------------------------------------------

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
          <div className="text-center p-8 text-[var(--text-tertiary)]">{t('app.sheet.empty')}</div>
        );
      case 'inventory':
      case 'products':
        if (!hasPermission('products', 'read')) {
          return <div className="text-center p-8 text-[var(--text-tertiary)]">{t('error.forbidden')}</div>;
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
          return <div className="text-center p-8 text-[var(--text-tertiary)]">{t('error.forbidden')}</div>;
        }
        return <CategoryManagement />;
      case 'ebay-listings':
        if (!(hasPermission('products', 'read') || hasPermission('products', 'write'))) {
          return <div className="text-center p-8 text-[var(--text-tertiary)]">{t('error.forbidden')}</div>;
        }
        return <EbayAuditView />;
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
          return <div className="text-center p-8 text-[var(--text-tertiary)]">{t('error.forbidden')}</div>;
        }
        return <AdminPanel />;
      case 'warehouse':
        if (!(hasPermission('warehouse', 'read') || hasPermission('warehouse', 'write'))) {
          return <div className="text-center p-8 text-[var(--text-tertiary)]">{t('error.forbidden')}</div>;
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
          return <div className="text-center p-8 text-[var(--text-tertiary)]">{t('error.forbidden')}</div>;
        }
        return <ProductInput onIdentify={handleIdentification} />;
    }
  };

  const renderLoadState = () => {
    if (productsLoading && products.length === 0) {
      return (
        <div className="flex items-center justify-center h-[calc(100vh-10rem)] text-[var(--text-secondary)]">
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl px-6 py-5 shadow-[var(--shadow-lg)] text-center space-y-2">
            <p className="text-lg font-semibold">{t('status.loading.products')}</p>
            <p className="text-sm text-[var(--text-tertiary)]">{t('status.loading.hint')}</p>
          </div>
        </div>
      );
    }
    return renderView();
  };

  return (
    <AppShell
      currentView={view}
      onNavigate={(v) => setView(v as View)}
      onToggleTheme={toggleTheme}
    >
      {productsError && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--error)] bg-[var(--error)]/20 px-4 py-3 text-sm text-[var(--text-primary)]">
          <span>{productsError}</span>
          <button
            type="button"
            onClick={loadProducts}
            className="inline-flex items-center rounded-lg bg-[var(--error)] px-3 py-1.5 font-semibold text-[var(--text-primary)] hover:bg-[var(--error)] hover:brightness-110 transition-colors"
          >
            {t('error.reload')}
          </button>
        </div>
      )}
      {identificationError && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--error)] bg-[var(--error)]/20 px-4 py-3 text-sm text-[var(--text-primary)]">
          <span>{identificationError}</span>
          <button
            type="button"
            onClick={clearError}
            className="inline-flex items-center rounded-lg bg-[var(--error)] px-3 py-1.5 font-semibold text-[var(--text-primary)] hover:bg-[var(--error)] hover:brightness-110 transition-colors"
          >
            {t('common.close')}
          </button>
        </div>
      )}
      {renderLoadState()}
      {(jobsRunning || jobStatuses.length > 0 || improveJobStatuses.length > 0) && (
        <>
          {jobsRunning && (
            <div className="fixed bottom-6 left-6 z-40 flex items-center gap-3 rounded-2xl bg-[var(--bg)]/90 border border-[var(--border)] px-4 py-3 shadow-[var(--shadow-lg)] shadow-black/40 max-w-sm">
              <Spinner className="w-6 h-6 text-[var(--avy-purple-light)]" />
              <div className="text-sm text-[var(--text-primary)]">
                <p className="font-semibold">{t('status.backgroundUploads.title')}</p>
                <p className="text-[var(--text-tertiary)] text-xs">{t('status.backgroundUploads.subtitle')}</p>
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
    </AppShell>
  );
};

const AuthGate: React.FC = () => {
  const { t } = useI18n();
  const { user, loading, initError, isAdmin, logout } = useAuth();

  // Apply data-theme on document root so CSS variables resolve for pre-auth screens.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const stored = readInitialTheme();
    document.documentElement.dataset.theme = stored;
  }, []);

  // Public auth flows (password reset / email verification) must be reachable without login.
  if (typeof window !== 'undefined') {
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    if (path === '/reset-password') {
      return <ResetPasswordScreen />;
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text-secondary)] flex items-center justify-center">
        <div className="flex items-center gap-3 rounded-2xl bg-[var(--surface)] border border-[var(--border)] px-6 py-5 shadow-[var(--shadow-lg)]">
          <Spinner className="w-6 h-6 text-[var(--avy-purple-light)]" />
          <div className="text-sm">
            <p className="font-semibold">{t('auth.loading.title')}</p>
            <p className="text-[var(--text-tertiary)] text-xs">{t('auth.loading.subtitle')}</p>
          </div>
        </div>
      </div>
    );
  }

  if (initError) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text-secondary)] flex items-center justify-center px-4">
        <div className="w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)] shadow-black/40 p-6 space-y-4">
          <h1 className="text-xl font-bold">{t('auth.devSetup.title')}</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            {t('auth.devSetup.description')}
          </p>
          <div className="rounded-xl border border-[var(--error)] bg-[var(--error)]/20 px-4 py-3 text-sm text-[var(--text-primary)]">
            {initError}
          </div>
          <div className="text-sm text-[var(--text-secondary)] space-y-2">
            <p className="font-semibold">{t('auth.devSetup.fixTitle')}</p>
            <ol className="list-decimal list-inside text-[var(--text-secondary)] space-y-1">
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
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text-secondary)] flex items-center justify-center px-4">
        <div className="w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)] shadow-black/40 p-6 space-y-4">
          <h1 className="text-xl font-bold">{t('auth.verifyEmail.title')}</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            {t('auth.verifyEmail.description')}
          </p>
          <div className="text-xs text-[var(--text-tertiary)]">
            {t('auth.verifyEmail.signedInAs')}: <span className="text-[var(--text-secondary)]">{user.email}</span>
          </div>
          <button
            type="button"
            onClick={() => logout()}
            className="rounded-xl bg-[var(--surface-hover)] hover:brightness-110 px-4 py-2.5 font-semibold text-[var(--text-primary)] transition-colors"
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
