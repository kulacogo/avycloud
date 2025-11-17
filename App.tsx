
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

const BACKEND_URL = 'https://product-hub-backend-79205549235.europe-west3.run.app';

type View = 'input' | 'sheet' | 'admin' | 'warehouse';

const App: React.FC = () => {
  const [view, setView] = useState<View>('input');
  const [products, setProducts] = useState<Product[]>([]);
  const [currentProduct, setCurrentProduct] = useState<Product | null>(null);
  const { identifyProducts, isLoading, error, cancelRequest, status } = useGemini();
  const [isLoadingProducts, setIsLoadingProducts] = useState(true);
  
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
      // Add newly identified products to the list, avoiding duplicates by ID
      setProducts(prev => {
        const existingIds = new Set(prev.map(p => p.id));
        const newProducts = result.products.filter(p => !existingIds.has(p.id));
        return [...newProducts, ...prev];
      });
      setCurrentProduct(result.products[0]);
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

  const renderView = () => {
    if (isLoading) {
        return (
            <div className="flex flex-col items-center justify-center h-[calc(100vh-10rem)] bg-slate-900 text-center px-4">
                <Spinner className="w-10 h-10" />
                <p className="mt-4 text-lg text-slate-100">{status.message || 'AI analysiert dein Produkt …'}</p>
                <p className="text-sm text-slate-400">
                  {status.model ? `Genutztes Modell: ${status.model}` : 'Modell wird vorbereitet …'}
                </p>
                <p className="text-xs text-slate-500 mt-4">Bitte Tab geöffnet lassen.</p>
            </div>
        );
    }

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
      case 'admin':
        return <AdminTable products={products} onSelectProduct={handleSelectProduct} onUpdateProducts={setProducts} />;
      case 'warehouse':
        return <WarehouseView products={products} onProductUpdate={handleUpdateProduct} />;
      case 'input':
      default:
        return <ProductInput onIdentify={handleIdentification} />;
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 font-sans flex flex-col">
      <Header currentView={view} setView={setView} />
      <main className="flex-1 w-full max-w-screen-2xl mx-auto p-4 sm:p-6 lg:p-8 safe-area-content">
        <ProcessStatusBar status={status} onCancel={cancelRequest} />
        {renderView()}
      </main>
    </div>
  );
};

export default App;
