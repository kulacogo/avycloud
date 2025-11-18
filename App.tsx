
import React, { useState, useCallback, useEffect } from 'react';
import { Product, ProductBundle } from './types';
import { useGemini } from './hooks/useGemini';
import ProductInput from './components/ProductInput';
import ProductSheet from './components/ProductSheet';
import AdminTable from './components/AdminTable';
import WarehouseView from './components/WarehouseView';
import { Header } from './components/Header';
import { Spinner } from './components/Spinner';
import { ProcessStatusBar } from './components/ProcessStatusBar';
import Dashboard from './components/Dashboard';

const BACKEND_URL = 'https://product-hub-backend-79205549235.europe-west3.run.app';

type View = 'dashboard' | 'input' | 'sheet' | 'inventory' | 'warehouse';
const VIEW_STORAGE_KEY = 'avystock:view';
const THEME_STORAGE_KEY = 'avystock:theme';
const ALLOWED_VIEWS: View[] = ['dashboard', 'input', 'sheet', 'inventory', 'warehouse'];
type Theme = 'light' | 'dark';

const sanitizeIdentifier = (value?: string | null) => {
  if (!value) return null;
  const cleaned = value.toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned || null;
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
  const nextQuantity = Math.max(product.inventory?.quantity ?? 0, minQuantity);
  return {
    ...product,
    inventory: {
      ...(product.inventory ?? {}),
      quantity: nextQuantity,
    },
  };
};

const mergeIdentifiedProducts = (incoming: Product[], existing: Product[]) => {
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
      const nextQuantity = (matched.inventory?.quantity ?? 0) + 1;
      const merged: Product = {
        ...matched,
        inventory: {
          ...(matched.inventory ?? {}),
          quantity: nextQuantity,
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
};

const readInitialView = (): View => {
  if (typeof window === 'undefined') return 'dashboard';
  const stored = window.localStorage.getItem(VIEW_STORAGE_KEY) as View | string | null;
  if (stored) {
    const migrated = VIEW_MIGRATIONS[stored] || stored;
    if (ALLOWED_VIEWS.includes(migrated as View)) {
      return migrated as View;
    }
  }
  return 'dashboard';
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
  const [view, setView] = useState<View>(() => readInitialView());
  const [products, setProducts] = useState<Product[]>([]);
  const [currentProduct, setCurrentProduct] = useState<Product | null>(null);
  const { identifyProducts, isLoading, error, cancelRequest, status } = useGemini();
  const [isLoadingProducts, setIsLoadingProducts] = useState(true);
  const [theme, setTheme] = useState<Theme>(() => readInitialTheme());
  
  // Load products from Firestore on mount
  useEffect(() => {
    loadProductsFromFirestore();
  }, []);
  
  const loadProductsFromFirestore = async () => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/products`);
      if (response.ok) {
        const data = await response.json();
        setProducts(data.products || []);
      }
    } catch (error) {
      console.error('Failed to load products:', error);
    } finally {
      setIsLoadingProducts(false);
    }
  };

  const handleIdentification = useCallback(async (images: File[], barcodes: string, model?: string) => {
    const result: ProductBundle | null = await identifyProducts(images, barcodes, model);
    if (result && result.products.length > 0) {
      let focusProduct: Product | null = null;
      setProducts(prev => {
        const merged = mergeIdentifiedProducts(result.products, prev);
        focusProduct = merged.focus;
        return merged.list;
      });
      if (focusProduct) {
        setCurrentProduct(focusProduct);
      } else {
        setCurrentProduct(result.products[0]);
      }
      setView('sheet');
    }
    // Error is handled by the hook and displayed via the `error` state
  }, [identifyProducts]);

  const handleUpdateProduct = (updatedProduct: Product) => {
    setProducts(prevProducts =>
      prevProducts.map(p => (p.id === updatedProduct.id ? updatedProduct : p))
    );
    if (currentProduct?.id === updatedProduct.id) {
      setCurrentProduct(updatedProduct);
    }
  };
  
  const handleSelectProduct = (productId: string) => {
    const product = products.find(p => p.id === productId);
    if (product) {
      setCurrentProduct(product);
      setView('sheet');
    }
  };

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(VIEW_STORAGE_KEY, view);
    }
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
    media.addEventListener('change', listener);
    return () => {
      media.removeEventListener('change', listener);
    };
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(prev => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  const renderView = () => {
    if (error) {
        return (
            <div className="flex flex-col items-center justify-center h-[calc(100vh-10rem)] bg-slate-900 text-center p-4">
                <p className="text-2xl text-red-400 mb-4">An Error Occurred</p>
                <p className="text-slate-300 bg-slate-800 p-4 rounded-lg">{error}</p>
                <button
                    onClick={() => window.location.reload()}
                    className="mt-6 px-6 py-2 bg-sky-600 text-white font-semibold rounded-lg hover:bg-sky-500 transition-colors"
                >
                    Try Again
                </button>
            </div>
        );
    }

    switch (view) {
      case 'sheet':
        return currentProduct ? (
          <ProductSheet product={currentProduct} onUpdate={handleUpdateProduct} />
        ) : (
          <div className="text-center p-8 text-slate-400">No product selected. Go to 'New' to identify one or 'Admin' to select an existing one.</div>
        );
      case 'inventory':
        return <AdminTable products={products} onSelectProduct={handleSelectProduct} onUpdateProducts={setProducts} />;
      case 'warehouse':
        return <WarehouseView products={products} onProductUpdate={handleUpdateProduct} />;
      case 'dashboard':
        return <Dashboard products={products} onSelectProduct={handleSelectProduct} />;
      case 'input':
      default:
        return <ProductInput onIdentify={handleIdentification} />;
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 font-sans flex flex-col">
      <Header currentView={view} setView={setView} theme={theme} onToggleTheme={toggleTheme} />
      <main className="flex-1 w-full max-w-screen-2xl mx-auto p-4 sm:p-6 lg:p-8 safe-area-content">
        <ProcessStatusBar status={status} onCancel={cancelRequest} />
        {renderView()}
      </main>
      {isLoading && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 rounded-2xl bg-slate-900/90 border border-slate-700 px-4 py-3 shadow-xl shadow-black/40 max-w-sm">
          <Spinner className="w-6 h-6 text-sky-300" />
          <div className="text-sm text-slate-100">
            <p className="font-semibold">AI arbeitet im Hintergrund …</p>
            <p className="text-slate-400 text-xs">Uploads abgeschlossen? Dann kannst du andere Bereiche nutzen.</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
