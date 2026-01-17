
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Product, WarehouseBin } from './types';
import { useIdentification, UploadGroupPayload } from './hooks/useIdentification';
import { useImproveQueue } from './hooks/useImproveQueue';
import ProductInput from './components/ProductInput';
import ProductSheet from './components/ProductSheet';
import AdminTable from './components/AdminTable';
import WarehouseView from './components/WarehouseView';
import { Header } from './components/Header';
import { Spinner } from './components/Spinner';
import JobStatusPopup from './components/JobStatusPopup';
import StatusDock from './components/StatusDock';
import Dashboard from './components/Dashboard';
import DashboardMobile from './components/DashboardMobile';
import OperationsView from './components/OperationsView';
import MobileSearchView from './components/MobileSearchView';
import MobileOperationsView from './components/MobileOperationsView';
import MobileTabBar from './components/MobileTabBar';
import IdentifyQueueView from './components/IdentifyQueueView';
import { fetchProducts, refreshPrice } from './api/client';
import { useI18n } from './i18n';
import { addMediaQueryListener } from './utils/mediaQuery';

type View =
  | 'dashboard'
  | 'home'
  | 'search'
  | 'operations'
  | 'operations-identify'
  | 'operations-stow'
  | 'operations-pick'
  | 'operations-pack'
  | 'input'
  | 'sheet'
  | 'inventory'
  | 'warehouse'
  | 'queue';
const VIEW_STORAGE_KEY = 'avystock:view';
const VIEW_PRODUCT_KEY = 'avystock:view:productId';
const THEME_STORAGE_KEY = 'avystock:theme';
const ALLOWED_VIEWS: View[] = [
  'dashboard',
  'home',
  'search',
  'operations',
  'operations-identify',
  'operations-stow',
  'operations-pick',
  'operations-pack',
  'input',
  'sheet',
  'inventory',
  'warehouse',
  'queue',
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

  if (first && ALLOWED_VIEWS.includes(first as View)) {
    return { view: first as View, productId: null };
  }

  return { view: 'dashboard', productId: null };
};

const viewToHashPath = (view: View, productId?: string | null) => {
  switch (view) {
    case 'home':
      return '/home';
    case 'search':
      return '/search';
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
  admin: 'inventory',
  home: 'home',
  search: 'search',
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

const App: React.FC = () => {
  const { t } = useI18n();
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
  const [warehouseRefresh, setWarehouseRefresh] = useState<WarehouseBin | null>(null);
  const [inventoryFocusId, setInventoryFocusId] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 768px)').matches : false
  );
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
    if (current !== target) {
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

  const refreshPricingForProducts = useCallback(async (productIds: string[]) => {
    if (!productIds.length) return;
    const priceResults: Array<{ id: string; data: any }> = [];
    for (const id of productIds) {
      try {
        const res = await refreshPrice(id);
        if (res.ok && res.data) {
          priceResults.push({ id, data: res.data });
        }
      } catch (err) {
        console.warn('Price refresh failed', id, (err as any)?.message || err);
      }
    }
    if (!priceResults.length) return;
    setProducts(prev =>
      prev.map(p => {
        const hit = priceResults.find(r => r.id === p.id);
        if (!hit) return p;
        return {
          ...p,
          details: {
            ...(p.details || ({} as any)),
            pricing: {
              ...(p.details?.pricing || {}),
              ...hit.data,
            },
          },
        };
      })
    );
  }, []);

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
      await refreshPricingForProducts([productId]);
      enqueueImproveJobs([productId]);
    },
    [enqueueImproveJobs, refreshPricingForProducts]
  );

  const handleImproveSelected = useCallback(
    async (productIds: string[]) => {
      if (!productIds.length) return;
      await refreshPricingForProducts(productIds);
      enqueueImproveJobs(productIds);
    },
    [enqueueImproveJobs, refreshPricingForProducts]
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
          />
        ) : (
          <Dashboard products={products} onSelectProduct={handleSelectProduct} onRefreshProducts={loadProducts} />
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
          <div className="text-center p-8 text-slate-400">{t('app.sheet.empty')}</div>
        );
      case 'inventory':
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
          />
        );
      case 'warehouse':
        return <WarehouseView refreshBin={warehouseRefresh} onRefreshBinConsumed={() => setWarehouseRefresh(null)} />;
      case 'queue':
        return <IdentifyQueueView />;
      case 'dashboard':
        return isMobile ? (
          <DashboardMobile products={products} onRefreshProducts={loadProducts} isLoading={productsLoading} />
        ) : (
          <Dashboard products={products} onSelectProduct={handleSelectProduct} onRefreshProducts={loadProducts} />
        );
      case 'input':
      default:
        return <ProductInput onIdentify={handleIdentification} />;
    }
  };

  const renderLoadState = () => {
    if (productsLoading && products.length === 0) {
      return (
        <div className="flex items-center justify-center h-[calc(100vh-10rem)] text-slate-200">
          <div className="bg-slate-800/80 border border-slate-700 rounded-2xl px-6 py-5 shadow-xl text-center space-y-2">
            <p className="text-lg font-semibold">{t('status.loading.products')}</p>
            <p className="text-sm text-slate-400">{t('status.loading.hint')}</p>
          </div>
        </div>
      );
    }
    return renderView();
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 font-sans flex flex-col">
      <Header currentView={view} setView={setView} theme={theme} onToggleTheme={toggleTheme} />
      <main className="flex-1 w-full px-4 sm:px-6 lg:px-10 xl:px-16 py-4 safe-area-content pb-28 sm:pb-6">
        {productsError && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-rose-800 bg-rose-900/50 px-4 py-3 text-sm text-rose-50">
            <span>{productsError}</span>
            <button
              type="button"
              onClick={loadProducts}
              className="inline-flex items-center rounded-lg bg-rose-700 px-3 py-1.5 font-semibold text-white hover:bg-rose-600 transition-colors"
            >
              {t('error.reload')}
            </button>
          </div>
        )}
        {identificationError && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-rose-800 bg-rose-900/50 px-4 py-3 text-sm text-rose-50">
            <span>{identificationError}</span>
            <button
              type="button"
              onClick={clearError}
              className="inline-flex items-center rounded-lg bg-rose-700 px-3 py-1.5 font-semibold text-white hover:bg-rose-600 transition-colors"
            >
              {t('common.close')}
            </button>
          </div>
        )}
        {renderLoadState()}
      </main>
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
      {(jobsRunning || jobStatuses.length > 0 || improveJobStatuses.length > 0) && (
        <>
          {jobsRunning && (
            <div className="fixed bottom-6 left-6 z-40 flex items-center gap-3 rounded-2xl bg-slate-900/90 border border-slate-700 px-4 py-3 shadow-xl shadow-black/40 max-w-sm">
              <Spinner className="w-6 h-6 text-sky-300" />
              <div className="text-sm text-slate-100">
                <p className="font-semibold">{t('status.backgroundUploads.title')}</p>
                <p className="text-slate-400 text-xs">{t('status.backgroundUploads.subtitle')}</p>
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

export default App;
