
import React, { useState, useCallback, useEffect, useMemo, useRef, lazy, Suspense } from 'react';
import { Product, WarehouseBin, View } from './types';
import { useIdentification, UploadGroupPayload } from './hooks/useIdentification';
import { useImproveQueue } from './hooks/useImproveQueue';
import CookieConsentBanner from './components/CookieConsentBanner';
import { CookieConsentProvider } from './context/CookieConsentContext';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { Spinner } from './components/Spinner';
import JobStatusPopup from './components/JobStatusPopup';
import StatusDock from './components/StatusDock';
import MobileTabBar from './components/MobileTabBar';
import ProductsPageHeader from './components/ProductsPageHeader';

import { fetchOrders, fetchProducts, refreshPrice } from './api/client';
import { isIdentifyRunning, subscribeIdentifyRun } from './utils/identifyRunFlag';
import { startVisiblePolling } from './utils/visiblePolling';
import { useI18n } from './i18n';
import { addMediaQueryListener } from './utils/mediaQuery';
import { isInventoryItem, isProductBacklogItem } from './utils/inventorySplit';
import { AuthProvider, useAuth } from './context/AuthContext';
import { InventoryProvider } from './context/InventoryContext';
import { ToastProvider } from './context/ToastContext';
import { LoginScreen } from './components/LoginScreen';
import { ResetPasswordScreen } from './components/ResetPasswordScreen';
import { ErrorBoundary } from './components/ErrorBoundary';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSSE } from './hooks/useSSE';

/**
 * Ansichten werden erst geladen, wenn sie geoeffnet werden.
 *
 * Vorher zog App.tsx 47 Ansichten sofort herein — alles landete in EINER
 * 2,4-MB-Datei, die komplett geladen und ausgewertet werden musste, bevor der
 * erste Bildschirm bedienbar war. Sichtbar ist aber immer nur eine Ansicht.
 */
const Dashboard = lazy(() => import('./components/Dashboard'));
const DashboardMobile = lazy(() => import('./components/DashboardMobile'));
const AdminPanel = lazy(() => import('./components/admin/AdminPanel').then((m) => ({ default: m.AdminPanel })));
const AdminTable = lazy(() => import('./components/AdminTable'));
const ApiSettings = lazy(() => import('./components/settings/ApiSettings').then((m) => ({ default: m.ApiSettings })));
const AuditLogView = lazy(() => import('./components/AuditLogView'));
const BillingSettings = lazy(() => import('./components/settings/BillingSettings').then((m) => ({ default: m.BillingSettings })));
const CaptureView = lazy(() => import('./components/capture/CaptureView'));
const CategoryManagement = lazy(() => import('./components/CategoryManagement').then((m) => ({ default: m.CategoryManagement })));
const CompanySettings = lazy(() => import('./components/settings/CompanySettings').then((m) => ({ default: m.CompanySettings })));
const DeduplicationView = lazy(() => import('./components/DeduplicationView'));
const FinanceView = lazy(() => import('./components/FinanceView'));
const ImportModal = lazy(() => import('./components/ImportModal'));
const IntegrationConfigPage = lazy(() => import('./components/integrations/IntegrationConfigPage').then((m) => ({ default: m.IntegrationConfigPage })));
const IntegrationsHub = lazy(() => import('./components/IntegrationsHub').then((m) => ({ default: m.IntegrationsHub })));
const InventoryView = lazy(() => import('./components/InventoryView'));
const InvoicesView = lazy(() => import('./components/orders/InvoicesView').then((m) => ({ default: m.InvoicesView })));
const ListingErrorsView = lazy(() => import('./components/ListingErrorsView'));
const MarketplaceListingsView = lazy(() => import('./components/MarketplaceListingsView'));
const MitarbeiterRollen = lazy(() => import('./components/admin/MitarbeiterRollen').then((m) => ({ default: m.MitarbeiterRollen })));
const MobileOperationsView = lazy(() => import('./components/MobileOperationsView'));
const MobileSearchView = lazy(() => import('./components/MobileSearchView'));
const OperationsView = lazy(() => import('./components/OperationsView'));
const OrderSettingsView = lazy(() => import('./components/orders/OrderSettingsView').then((m) => ({ default: m.OrderSettingsView })));
const OrdersView = lazy(() => import('./components/OrdersView'));
const PricingDashboard = lazy(() => import('./components/PricingDashboard'));
const ProductInput = lazy(() => import('./components/ProductInput'));
const ProductSheet = lazy(() => import('./components/ProductSheet'));
const ProfileSettings = lazy(() => import('./components/settings/ProfileSettings').then((m) => ({ default: m.ProfileSettings })));
const ReturnsView = lazy(() => import('./components/orders/ReturnsView').then((m) => ({ default: m.ReturnsView })));
const RuleDashboard = lazy(() => import('./components/RuleDashboard'));
const ShippingView = lazy(() => import('./components/orders/ShippingView').then((m) => ({ default: m.ShippingView })));
const ShopGesundheit = lazy(() => import('./components/ShopGesundheit').then((m) => ({ default: m.ShopGesundheit })));
const WarehouseSettingsView = lazy(() => import('./components/warehouse/WarehouseSettingsView').then((m) => ({ default: m.WarehouseSettingsView })));
const WarehouseView = lazy(() => import('./components/WarehouseView'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnMount: true,
    },
  },
});

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
  'orders',
  'orders-returns',
  'orders-shipping',
  'orders-invoices',
  'orders-settings',
  'warehouse',
  'warehouse-settings',
  'marketplace-ebay',
  'marketplace-kaufland',
  'marketplace-errors',
  'finance',
  'integrations',
  'integrations-ebay',
  'integrations-kaufland',
  'integrations-sendcloud',
  'integrations-sevdesk',
  'settings',
  'settings-profile',
  'settings-team',
  'settings-api',
  'settings-billing',
  'shop-health',
  'duplicates',
  'audit-log',
  'pricing',
  'rules',
];
type Theme = 'light' | 'dark';

/**
 * Ansichten, über denen das Produktdatenblatt NICHT aufgehen darf.
 *
 * Bewusst eine Ausschluss- statt einer Erlaubnisliste: vorher stand hier eine
 * Aufzählung erlaubter Ansichten, und jede neue Ansicht musste daran denken,
 * sich einzutragen. Wer es vergaß, bekam eine tote Fläche — genau das war im
 * Handy-Reiter "Suche" der Fall: Tippen auf einen Treffer setzte den Zustand,
 * gerendert wurde nichts, und am Handy führte damit überhaupt kein Weg mehr ins
 * Datenblatt. Dasselbe traf die klickbaren Zeilen der Nachbestellungs-Warnungen
 * auf dem Dashboard.
 *
 * Ausgeschlossen bleiben die Scan-Ansichten (ein bildschirmfüllendes Overlay
 * würde dem Handscanner den Fokus nehmen) und das Erfassen (das Overlay würde
 * den Assistenten verdecken).
 */
const isProductSheetBlockedView = (view: string) =>
  view === 'input' || view.startsWith('operations');

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

  // Legacy route redirect
  if (first === 'ebay') {
    return { view: 'marketplace-ebay', productId: null };
  }

  // Nested routes: #/orders/returns, #/orders/shipping, etc.
  if (first === 'orders' && second) {
    const ordersMap: Record<string, View> = {
      returns: 'orders-returns',
      shipping: 'orders-shipping',
      invoices: 'orders-invoices',
      settings: 'orders-settings',
    };
    if (ordersMap[second]) return { view: ordersMap[second], productId: null };
  }

  // Nested routes: #/warehouse/settings
  if (first === 'warehouse' && second === 'settings') {
    return { view: 'warehouse-settings', productId: null };
  }

  // Nested routes: #/marketplace/ebay, #/marketplace/kaufland
  if (first === 'marketplace' && second) {
    const mpMap: Record<string, View> = {
      ebay: 'marketplace-ebay',
      kaufland: 'marketplace-kaufland',
      errors: 'marketplace-errors',
    };
    if (mpMap[second]) return { view: mpMap[second], productId: null };
  }

  // Nested routes: #/settings/profile, #/settings/team, etc.
  if (first === 'integrations' && second) {
    const integrationsMap: Record<string, View> = {
      ebay: 'integrations-ebay',
      kaufland: 'integrations-kaufland',
      sendcloud: 'integrations-sendcloud',
      sevdesk: 'integrations-sevdesk',
    };
    if (integrationsMap[second]) return { view: integrationsMap[second], productId: null };
  }

  if (first === 'settings' && second) {
    const settingsMap: Record<string, View> = {
      profile: 'settings-profile',
      team: 'settings-team',
      api: 'settings-api',
      billing: 'settings-billing',
    };
    if (settingsMap[second]) return { view: settingsMap[second], productId: null };
  }

  // Nested routes: #/products/inventory, #/products/identify
  if (first === 'products' && second) {
    const productsMap: Record<string, View> = {
      inventory: 'inventory',
      identify: 'input',
      capture: 'input',
    };
    if (productsMap[second]) return { view: productsMap[second], productId: null };
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
  const map: Partial<Record<View, string>> = {
    home: '/home',
    search: '/search',
    admin: '/admin',
    'operations-identify': '/operations/identify',
    'operations-stow': '/operations/stow',
    'operations-pick': '/operations/pick',
    'operations-pack': '/operations/pack',
    operations: '/operations',
    'ebay-listings': '/marketplace/ebay',
    'orders-returns': '/orders/returns',
    'orders-shipping': '/orders/shipping',
    'orders-invoices': '/orders/invoices',
    'orders-settings': '/orders/settings',
    'warehouse-settings': '/warehouse/settings',
    'marketplace-ebay': '/marketplace/ebay',
    'marketplace-kaufland': '/marketplace/kaufland',
    'marketplace-errors': '/marketplace/errors',
    finance: '/finance',
    input: '/products/capture',
    integrations: '/integrations',
    settings: '/settings',
    'settings-profile': '/settings/profile',
    'settings-team': '/settings/team',
    'settings-api': '/settings/api',
    'settings-billing': '/settings/billing',
  };
  if (view === 'sheet') return productId ? `/sheet/${productId}` : '/sheet';
  return map[view] || `/${view}`;
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
  // "inventory" is now a dedicated view (InventoryView).
  home: 'home',
  search: 'search',
  ebay: 'marketplace-ebay',
  'ebay-listings': 'marketplace-ebay',
};

const readInitialView = (): { view: View; productId: string | null } => {
  if (typeof window === 'undefined') return { view: 'dashboard', productId: null };
  const fromHash = parseHash();
  if (fromHash.view !== 'dashboard' || fromHash.productId) return fromHash;
  try {
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY) as View | string | null;
    if (stored) {
      const migrated = VIEW_MIGRATIONS[stored] || stored;
      if (ALLOWED_VIEWS.includes(migrated as View)) {
        return { view: migrated as View, productId: null };
      }
    }
  } catch {
    // Storage might be blocked (SecurityError) or unavailable
  }
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  return { view: isMobile ? 'home' : 'dashboard', productId: null };
};

const readInitialTheme = (): Theme => {
  if (typeof window === 'undefined') {
    return 'dark';
  }
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
  } catch {
    // Storage might be blocked (SecurityError) or unavailable
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
  const { hasPermission, rbacError, retryPermissions } = useAuth();

  // Connect to backend SSE for live cache invalidation
  useSSE();
  const [{ view: initialView, productId: initialHashProductId }] = useState(() => readInitialView());
  const [view, setView] = useState<View>(initialView);
  const [initialProductId] = useState<string | null>(initialHashProductId);
  const [products, setProducts] = useState<Product[]>([]);
  const [productsLoading, setProductsLoading] = useState<boolean>(false);
  const [productsError, setProductsError] = useState<string | null>(null);
  const productsRef = useRef<Product[]>([]);
  const [currentProduct, setCurrentProduct] = useState<Product | null>(null);
  const sheetDirtyRef = useRef(false);

  /**
   * Schließt das Datenblatt — fragt aber nach, wenn ungespeicherte Änderungen
   * anstehen.
   *
   * Vorher wurde `sheetDirtyRef` beim Schließen einfach auf false gesetzt und
   * alles kommentarlos verworfen. Zusammen mit einem "Übernehmen", das gar
   * nicht speicherte, hieß das: übernommene KI-Vorschläge verschwanden beim
   * Schließen spurlos, während die alten (falschen) Daten auf den
   * Marktplätzen online blieben (Vorfall 2026-08-10, SKU-3154363905).
   */
  const currentProductRef = useRef<Product | null>(null);

  const confirmDiscardSheet = () =>
    window.confirm(
      'Es gibt ungespeicherte Änderungen an diesem Produkt.\n\n'
        + 'Wenn du jetzt schließt, gehen sie verloren — das Datenblatt und die '
        + 'Marktplatz-Angebote behalten die alten Werte.\n\n'
        + 'Trotzdem schließen?'
    );

  const closeProductSheet = useCallback(() => {
    if (sheetDirtyRef.current) {
      const proceed = window.confirm(
        'Es gibt ungespeicherte Änderungen an diesem Produkt.\n\n'
          + 'Wenn du jetzt schließt, gehen sie verloren — das Datenblatt und die '
          + 'Marktplatz-Angebote behalten die alten Werte.\n\n'
          + 'Trotzdem schließen?'
      );
      if (!proceed) return;
    }
    sheetDirtyRef.current = false;
    setCurrentProduct(null);
  }, []);
  const [showImportModal, setShowImportModal] = useState(false);
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
      // Only set focus for single-job identify.
      // For multi-job: each completion would overwrite the previous focus,
      // so the user would only see the last product. Instead, merge into
      // the product list and let the user navigate from there.
      const focusProduct = nextFocus as Product | null;
      if (focusProduct && jobStatuses.length <= 1) {
        setCurrentProduct(focusProduct);
        setInventoryFocusId(focusProduct.id);
        if (view !== "products" && view !== "inventory") {
          setView("products");
        }
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

  // Load products from backend on mount + lightweight polling.
  // Skip the polling tick while an identify call is in flight: a 30-180s
  // identify request runs through the same Cloud-Run service and can starve
  // available connections, which produced the spurious "Failed to fetch"
  // banner during product capture (see utils/identifyRunFlag.ts).
  useEffect(() => {
    loadProducts();
    // Taktet nur in sichtbaren Tabs. Jeder Abruf liest alle ~1.700 Produkte;
    // im Hintergrund laufende Tabs verursachten so den Großteil der 355 Mio.
    // Firestore-Lesevorgänge im Juli. Beim Zurückwechseln wird sofort geladen.
    const stopPolling = startVisiblePolling(() => {
      if (isIdentifyRunning()) return;
      loadProducts();
    }, 60000);
    // Re-fetch immediately when an identify run finishes so the user sees
    // the freshly captured product without waiting up to 60s.
    const unsubscribe = subscribeIdentifyRun(() => {
      if (!isIdentifyRunning()) {
        loadProducts();
      }
    });
    return () => {
      stopPolling();
      unsubscribe();
    };
  }, [loadProducts]);

  // keep hash + storage in sync when view changes (for back/forward navigation)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const target = viewToHashPath(view).replace(/^#/, '').replace(/^\/+/, '');
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
  }, [view]);

  // Handle deep linking for products once loaded
  useEffect(() => {
    if (products.length === 0) return;
    const { view: v, productId } = parseHash();
    if (v === 'sheet' && productId) {
      const product = products.find((p) => p.id === productId);
        if (product) {
          setCurrentProduct(product);
          setInventoryFocusId(product.id);
          // Redirect legacy #/sheet/xxx → #/products (overlay will show)
          setView('products');
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
        // Do not overwrite current product while the user has unsaved edits —
        // the improve job result may contain stale data from before the user's changes.
        if (!sheetDirtyRef.current) {
          setCurrentProduct(product);
        }
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
      barcodes: string,
      lotCode?: string
    ) => {
      // Single identify pipeline (v2) only.
      enqueueIdentification(groupsPayload, barcodes, null, null, lotCode || null);
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
      // Don't setView('sheet') — ProductSheet renders as overlay, keeping current view
    }
  };


  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    currentProductRef.current = currentProduct;
  }, [currentProduct]);

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
      // Deep-link #/sheet/xxx → open ProductSheet overlay on products view instead of dedicated sheet view
      const resolvedView = nextView === 'sheet' ? 'products' : nextView;
      if (resolvedView !== viewRef.current) {
        setView(resolvedView);
      }
      if (productId) {
        const product = productsRef.current.find((p) => p.id === productId) || null;
        setCurrentProduct(product);
        if (product) setInventoryFocusId(product.id);
      } else {
        // Die Zurueck-Taste (Handy/Browser) aendert nur den Hash. Hier lief
        // bisher setCurrentProduct(null) DIREKT — am Warndialog vorbei, den der
        // Schliessen-Knopf sehr wohl zeigt. Ungespeicherte Aenderungen am
        // Datenblatt waren damit ohne Nachfrage weg.
        if (sheetDirtyRef.current && currentProductRef.current) {
          if (!confirmDiscardSheet()) {
            // Adresse zurueckdrehen, das Datenblatt bleibt offen.
            window.location.hash = `#/sheet/${currentProductRef.current.id}`;
            return;
          }
          sheetDirtyRef.current = false;
        }
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
      // ProductSheet is overlay-only — ensure we're on a view that shows the overlay
      if (view !== 'products' && view !== 'inventory' && view !== 'marketplace-ebay' && view !== 'marketplace-kaufland' && view !== 'marketplace-errors') {
        setView('products');
      }
    }
    initialProductHydratedRef.current = true;
  }, [products, initialProductId, view]);

  // Keep the currently opened product sheet in sync with the latest product list.
  // This prevents stale quantities (e.g., after warehouse stock changes) from lingering in ProductSheet.
  // ProductSheet itself will ignore prop refreshes while the user is actively editing/dirty.
  // IMPORTANT: Skip sync when ProductSheet has unsaved changes — polling fetches stale Firestore data
  // that would overwrite local edits (e.g., category changes from Chat before saving).
  useEffect(() => {
    if (!currentProduct?.id) return;
    if (sheetDirtyRef.current) return;
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
      // 'sheet' view removed — ProductSheet is now overlay-only (see below in JSX)
      case 'inventory':
        if (!hasPermission('products', 'read')) {
          return <div className="text-center p-8 text-txt-muted">{t('error.forbidden')}</div>;
        }
        return (
          <InventoryView
            onNavigate={(next) => setView(next as View)}
            onSelectProduct={(product) => {
              setCurrentProduct(product);
              setInventoryFocusId(product.id);
            }}
          />
        );
      case 'products':
        if (!hasPermission('products', 'read')) {
          return <div className="text-center p-8 text-txt-muted">{t('error.forbidden')}</div>;
        }
        return (
          <>
            <ProductsPageHeader
              totalCount={products.length}
              filteredCount={products.length}
              mode="products"
              onCreateProduct={() => {
                window.location.hash = '#/input';
                setView('input');
              }}
              onExport={async () => {
                try {
                  const { exportProductsCsv } = await import('./api/client');
                  await exportProductsCsv();
                } catch (err: any) {
                  console.error('Export failed:', err);
                }
              }}
              onImport={() => setShowImportModal(true)}
            />
            <AdminTable
              products={products}
              onSelectProduct={handleSelectProduct}
              onUpdateProducts={setProducts}
              focusProductId={inventoryFocusId}
              onImproveProduct={handleImproveProduct}
              onImproveSelected={handleImproveSelected}
              onBulkImprove={handleBulkImprove}
              improvingProductIds={activeProductIds}
              mode="all"
              scopeProductIds={drilldownProductIds}
            />
          </>
        );
      case 'categories':
        if (!(hasPermission('categories', 'read') || hasPermission('categories', 'write'))) {
          return <div className="text-center p-8 text-txt-muted">{t('error.forbidden')}</div>;
        }
        return <CategoryManagement />;
      case 'ebay-listings':
      case 'marketplace-ebay':
        if (!(hasPermission('products', 'read') || hasPermission('products', 'write'))) {
          return <div className="text-center p-8 text-txt-muted">{t('error.forbidden')}</div>;
        }
        return <MarketplaceListingsView key="ebay" marketplace="ebay" />;
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
          return <div className="text-center p-8 text-txt-muted">{t('error.forbidden')}</div>;
        }
        return <AdminPanel />;
      case 'orders':
        if (!(hasPermission('orders', 'read') || hasPermission('orders', 'pick') || hasPermission('orders', 'pack'))) {
          return <div className="text-center p-8 text-txt-muted">{t('error.forbidden')}</div>;
        }
        return <OrdersView />;
      case 'warehouse':
        if (!(hasPermission('warehouse', 'read') || hasPermission('warehouse', 'write'))) {
          return <div className="text-center p-8 text-txt-muted">{t('error.forbidden')}</div>;
        }
        return <WarehouseView refreshBin={warehouseRefresh} onRefreshBinConsumed={() => setWarehouseRefresh(null)} />;
      case 'orders-returns':
        return <ReturnsView />;
      case 'orders-shipping':
        return <ShippingView />;
      case 'orders-invoices':
        return <InvoicesView />;
      case 'orders-settings':
        return <OrderSettingsView />;
      case 'warehouse-settings':
        return <WarehouseSettingsView />;
      case 'marketplace-kaufland':
        return <MarketplaceListingsView key="kaufland" marketplace="kaufland" />;
      case 'marketplace-errors':
        if (!(hasPermission('products', 'read') || hasPermission('products', 'write'))) {
          return <div className="text-center p-8 text-txt-muted">{t('error.forbidden')}</div>;
        }
        return <ListingErrorsView />;
      case 'finance':
        if (!hasPermission('admin', 'reports.read')) {
          return <div className="text-center p-8 text-txt-muted">{t('error.forbidden')}</div>;
        }
        return <FinanceView />;
      case 'integrations':
        return <IntegrationsHub onNavigate={(id: string) => {
          const viewMap: Record<string, View> = {
            ebay: 'integrations-ebay',
            kaufland: 'integrations-kaufland',
            sendcloud: 'integrations-sendcloud',
            sevdesk: 'integrations-sevdesk',
          };
          if (viewMap[id]) setView(viewMap[id]);
        }} />;
      case 'integrations-ebay':
      case 'integrations-kaufland':
      case 'integrations-sendcloud':
      case 'integrations-sevdesk': {
        const integrationId = view.replace('integrations-', '') as 'ebay' | 'kaufland' | 'sendcloud' | 'sevdesk';
        return <IntegrationConfigPage integration={integrationId} onBack={() => setView('integrations')} />;
      }
      case 'settings':
        return <CompanySettings />;
      case 'settings-profile':
        return <ProfileSettings appTheme={theme} onThemeChange={setTheme} />;
      case 'settings-team':
        if (!(
          hasPermission('admin', 'users.read') ||
          hasPermission('admin', 'roles.read') ||
          hasPermission('admin', 'groups.read')
        )) {
          return <div className="text-center p-8 text-txt-muted">{t('error.forbidden')}</div>;
        }
        return <MitarbeiterRollen />;
      case 'shop-health':
        if (!hasPermission('admin', 'reports.read')) {
          return <div className="text-center p-8 text-txt-muted">{t('error.forbidden')}</div>;
        }
        return <ShopGesundheit />;
      case 'settings-api':
        return <ApiSettings />;
      case 'settings-billing':
        return <BillingSettings />;
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
      case 'pricing':
        if (!hasPermission('products', 'read')) {
          return <div className="text-center p-8 text-txt-muted">{t('error.forbidden')}</div>;
        }
        return <PricingDashboard />;
      case 'rules':
        return <RuleDashboard />;
      case 'duplicates':
        if (!hasPermission('products', 'read')) {
          return <div className="text-center p-8 text-txt-muted">{t('error.forbidden')}</div>;
        }
        return <DeduplicationView />;
      case 'audit-log':
        if (!hasPermission('admin', 'read')) {
          return <div className="text-center p-8 text-txt-muted">{t('error.forbidden')}</div>;
        }
        return <AuditLogView />;
      case 'input':
      default:
        if (!hasPermission('identify', 'run')) {
          return <div className="text-center p-8 text-txt-muted">{t('error.forbidden')}</div>;
        }
        return (
          <CaptureView
            onProductCreated={(product) => {
              // Refresh products list after new product is captured
              loadProducts();
            }}
          />
        );
    }
  };

  const renderLoadState = () => {
    if (productsLoading && products.length === 0) {
      return (
        <div className="p-6 space-y-6 animate-pulse">
          {/* KPI cards skeleton */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="bg-app-surface border border-app-border rounded-xl p-4 space-y-3">
                <div className="h-3 w-20 bg-app-elevated rounded" />
                <div className="h-7 w-16 bg-app-elevated rounded" />
              </div>
            ))}
          </div>
          {/* Toolbar skeleton */}
          <div className="flex items-center gap-3">
            <div className="h-9 w-64 bg-app-elevated rounded-lg" />
            <div className="h-9 w-24 bg-app-elevated rounded-lg" />
          </div>
          {/* Table skeleton */}
          <div className="bg-app-surface border border-app-border rounded-xl overflow-hidden">
            <div className="flex items-center gap-4 px-4 py-3 border-b border-app-border">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="h-3 bg-app-elevated rounded flex-1" />
              ))}
            </div>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3 border-b border-app-border/50">
                <div className="h-8 w-8 bg-app-elevated rounded" />
                {[1, 2, 3, 4, 5].map((j) => (
                  <div key={j} className="h-3 bg-app-elevated rounded flex-1" />
                ))}
              </div>
            ))}
          </div>
        </div>
      );
    }
    // Ansichten werden erst beim Oeffnen geladen — waehrenddessen eine ruhige
    // Anzeige statt eines leeren Bildschirms.
    return (
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-16" role="status" aria-live="polite">
            <Spinner />
          </div>
        }
      >
        {renderView()}
      </Suspense>
    );
  };

  return (
    <div className="min-h-screen bg-app-bg text-txt-primary font-sans flex">
      {/* Desktop Sidebar */}
      <Sidebar currentView={view} setView={setView} />

      {/* Main area (topbar + content) */}
      <div className="flex-1 flex flex-col min-h-screen overflow-hidden">
        {/* Mobile: keep legacy header for nav icons; Desktop: new topbar */}
        {isMobile ? (
          <Header currentView={view} setView={setView} theme={theme} onToggleTheme={toggleTheme} />
        ) : (
          <Topbar currentView={view} theme={theme} onToggleTheme={toggleTheme} onNavigate={(v) => setView(v as View)} />
        )}

        <main className={`flex-1 overflow-y-auto px-4 sm:px-6 lg:px-8 safe-area-content ${isMobile && view.startsWith('operations') ? 'pt-3' : 'py-6'} ${isMobile && view === 'operations' ? 'flex flex-col' : ''}`}>
          {/* Rechte-Abruf endgültig fehlgeschlagen: OHNE diesen Hinweis wirkt die
              halbierte Navigation wie eine Rechte-Entscheidung — der Mitarbeiter
              sieht nur, dass "Operationen" fehlt, und hat keinen Weg zurück
              außer einem manuellen Neuladen. */}
          {rbacError && (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning-dim px-4 py-3 text-sm text-warning">
              <span>Berechtigungen konnten nicht geladen werden — es fehlen möglicherweise Menüpunkte.</span>
              <button
                type="button"
                onClick={retryPermissions}
                className="inline-flex items-center rounded-md bg-warning px-3 py-1.5 font-semibold text-white hover:opacity-90 transition-opacity"
              >
                Erneut versuchen
              </button>
            </div>
          )}
          {productsError && (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger-dim px-4 py-3 text-sm text-danger">
              <span>{productsError}</span>
              <button
                type="button"
                onClick={loadProducts}
                className="inline-flex items-center rounded-md bg-danger px-3 py-1.5 font-semibold text-white hover:opacity-90 transition-opacity"
              >
                {t('error.reload')}
              </button>
            </div>
          )}
          {identificationError && (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger-dim px-4 py-3 text-sm text-danger">
              <span>{identificationError}</span>
              <button
                type="button"
                onClick={clearError}
                className="inline-flex items-center rounded-md bg-danger px-3 py-1.5 font-semibold text-white hover:opacity-90 transition-opacity"
              >
                {t('common.close')}
              </button>
            </div>
          )}
          {renderLoadState()}
        </main>

        {/* ProductSheet overlay — slides in from right, independent of route */}
        {currentProduct && !isProductSheetBlockedView(view) && (
          <div className="fixed inset-0 z-50 flex justify-end">
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-black/40 transition-opacity"
              onClick={closeProductSheet}
              aria-label="Close product sheet"
            />
            {/* Sheet panel */}
            <div className="relative w-full md:w-[66vw] md:max-w-[1080px] bg-app-surface border-l border-app-border overflow-y-auto shadow-2xl animate-slide-in-right">
              <ProductSheet
                product={currentProduct}
                onUpdate={handleUpdateProduct}
                onImprove={handleImproveProduct}
                isImproving={Boolean(currentProduct && activeProductIds.has(currentProduct.id))}
                onClose={closeProductSheet}
                onDirtyChange={(dirty) => { sheetDirtyRef.current = dirty; }}
              />
            </div>
          </div>
        )}

        {/* Import Modal */}
        <ImportModal
          open={showImportModal}
          onClose={() => setShowImportModal(false)}
          onComplete={loadProducts}
        />

        {/* Mobile bottom nav */}
        {isMobile && (
          <div className="md:hidden fixed left-0 right-0 bottom-0 z-40">
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

      {/* Floating elements (job status, uploads) */}
      {(jobsRunning || jobStatuses.length > 0 || improveJobStatuses.length > 0) && (
        <>
          {jobsRunning && (
            <div className="fixed bottom-6 left-6 z-40 flex items-center gap-3 rounded-lg bg-app-surface border border-app-border px-4 py-3 shadow-app max-w-sm">
              <Spinner className="w-6 h-6 text-accent" />
              <div className="text-sm text-txt-primary">
                <p className="font-semibold">{t('status.backgroundUploads.title')}</p>
                <p className="text-txt-muted text-xs">{t('status.backgroundUploads.subtitle')}</p>
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
      <div className="min-h-screen bg-app-bg text-txt-primary flex items-center justify-center">
        <div className="flex items-center gap-3 rounded-lg bg-app-surface border border-app-border px-6 py-5 shadow-app">
          <Spinner className="w-6 h-6 text-accent" />
          <div className="text-sm">
            <p className="font-semibold">{t('auth.loading.title')}</p>
            <p className="text-txt-muted text-xs">{t('auth.loading.subtitle')}</p>
          </div>
        </div>
      </div>
    );
  }

  if (initError) {
    return (
      <div className="min-h-screen bg-app-bg text-txt-primary flex items-center justify-center px-4">
        <div className="w-full max-w-2xl rounded-lg border border-app-border bg-app-surface shadow-app p-6 space-y-4">
          <h1 className="text-xl font-bold">{t('auth.devSetup.title')}</h1>
          <p className="text-sm text-txt-secondary">
            {t('auth.devSetup.description')}
          </p>
          <div className="rounded-md border border-danger/30 bg-danger-dim px-4 py-3 text-sm text-danger">
            {initError}
          </div>
          <div className="text-sm text-txt-primary space-y-2">
            <p className="font-semibold">{t('auth.devSetup.fixTitle')}</p>
            <ol className="list-decimal list-inside text-txt-secondary space-y-1">
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
      <div className="min-h-screen bg-app-bg text-txt-primary flex items-center justify-center px-4">
        <div className="w-full max-w-lg rounded-lg border border-app-border bg-app-surface shadow-app p-6 space-y-4">
          <h1 className="text-xl font-bold">{t('auth.verifyEmail.title')}</h1>
          <p className="text-sm text-txt-secondary">
            {t('auth.verifyEmail.description')}
          </p>
          <div className="text-xs text-txt-muted">
            {t('auth.verifyEmail.signedInAs')}: <span className="text-txt-primary">{user.email}</span>
          </div>
          <button
            type="button"
            onClick={() => logout()}
            className="rounded-md bg-app-elevated hover:bg-app-border px-4 py-2.5 font-semibold text-txt-primary transition-colors"
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
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <CookieConsentProvider>
        <AuthProvider>
          <ToastProvider>
            <InventoryProvider>
              <AuthGate />
            </InventoryProvider>
          </ToastProvider>
        </AuthProvider>
        <CookieConsentBanner />
      </CookieConsentProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
