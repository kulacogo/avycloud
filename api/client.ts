
import { Product, ProductBundle, DatasheetChange, ImageSuggestionGroup, SerpInsight } from '../types';

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

// This function now makes a REAL API call to the live backend server.
export const identifyProductApi = async (
  images: File[], 
  barcodes: string,
  options?: { model?: string; signal?: AbortSignal }
): Promise<{ ok: boolean; data?: ProductBundle; error?: { code: number; message: string } }> => {
  
  const formData = new FormData();
  formData.append('barcodes', barcodes);
  images.forEach((image) => {
    formData.append('images', image, image.name);
  });

  const model = options?.model;
  const signal = options?.signal;
  const query = model ? `?model=${encodeURIComponent(model)}` : '';

  let response: Response;
  
  try {
    response = await fetch(`${BACKEND_URL}/api/identify${query}`, {
      method: 'POST',
      body: formData,
      signal,
      // Note: Do not set 'Content-Type' header manually for FormData.
      // The browser will set it automatically with the correct boundary.
    });
  } catch (error: any) {
    // Check if it was aborted
    if (error?.name === 'AbortError') {
      return { ok: false, error: { code: 499, message: 'Request cancelled by user' } };
    }
    
    // Network error - couldn't reach the server
    console.error('Network error:', error);
    const errorInfo = extractErrorInfo(error);
    return { ok: false, error: errorInfo };
  }

  try {
    const result = await parseResponse(response);

    if (!response.ok) {
      throw new Error(result?.error?.message || `Request failed with status ${response.status}`);
    }
    
    // Check if the backend returned an error even with 200 status
    if (result?.ok === false || result?.error) {
      const error = result.error || { code: 500, message: 'Backend returned error without details' };
      return { ok: false, error };
    }
    
    // The backend response is already in the format { ok: true, data: ... }
    // Handle different response formats from backend
    const data = result?.data;
    
    // Check if we have any data at all
    if (!data) {
      return { 
        ok: false, 
        error: { 
          code: 502,
          message: 'Backend returned empty or invalid data. The server might be experiencing issues.'
        }
      };
    }
    
    // If data has a 'products' array, it's the new format
    if (data && data.products && Array.isArray(data.products)) {
      return { ok: true, data: data };
    }
    
    // If data is a single product (old format), wrap it in the expected structure
    if (data && (data.id || data.ean || data.name)) {
      // Convert single product to expected format
      const product = {
        id: data.id || data.ean || Date.now().toString(),
        identification: {
          method: data.identification?.method || (images.length > 0 ? (barcodes ? 'hybrid' : 'image') : 'barcode'),
          barcodes: data.barcodes || (data.ean ? [data.ean] : []),
          name: data.name || '',
          brand: data.brand || '',
          category: data.category || '',
          confidence: data.confidence || 0.9
        },
        details: {
          short_description: data.description || '',
          key_features: data.key_features || [],
          attributes: data.attributes || {
            ...(data.net_content && { 'Inhalt': data.net_content }),
            ...(data.ingredients && { 'Zutaten': data.ingredients }),
            ...(data.allergens && { 'Allergene': data.allergens }),
            ...(data.storage_instructions && { 'Lagerung': data.storage_instructions }),
            ...(data.country_of_origin && { 'Herkunft': data.country_of_origin }),
            ...(data.packaging && typeof data.packaging === 'object' && { 
              'Verpackung': `${data.packaging.type || ''} ${data.packaging.size || ''}`.trim() 
            }),
            ...(data.nutrition_facts && Object.entries(data.nutrition_facts).reduce((acc, [key, value]) => {
              if (key !== 'portion_size') {
                acc[`Nährwerte (${key})`] = value;
              }
              return acc;
            }, {} as Record<string, any>))
          },
          identifiers: {
            ean: data.ean || data.gtin || '',
            gtin: data.gtin || data.ean || ''
          },
          images: (data.images || []).map((img: any) => ({
            source: img.source || 'web',
            variant: img.variant || 'front',
            url_or_base64: img.url_or_base64 || img.url || img
          })),
          pricing: {
            lowest_price: data.lowest_price || { amount: 0, currency: 'EUR', sources: [] },
            price_confidence: data.lowest_price?.confidence || 0
          }
        },
        ops: data.ops || {
          sync_status: 'pending',
          revision: 1
        }
      };
      
      return { 
        ok: true, 
        data: {
          products: [product],
          rendering: {
            format: "html",
            datasheet_page: "",
            admin_table_page: ""
          }
        }
      };
    }
    
    // If no valid data format is recognized, return error
    return { 
      ok: false, 
      error: { 
        code: 502,
        message: 'Backend returned unrecognized data format. Expected either products array or single product.'
      }
    };

  } catch (error) {
    console.error('Failed to fetch from backend API:', error);
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

// --- The rest of the functions remain as mocks for now ---
// In a real application, these would also be implemented on the backend.

export const saveProduct = async (product: Product): Promise<{ ok: boolean; data?: { id: string; revision: number }; error?: { code: number; message: string } }> => {
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


// Sync a single product to BaseLinker
export const syncToBaseLinker = async (productOrProducts: Product | Product[]): Promise<{ ok: boolean; results?: Array<{id: string; status: 'synced' | 'failed'; message?: string}>; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  
  try {
    const isSingle = !Array.isArray(productOrProducts);
    const payload = isSingle ? { product: productOrProducts } : { products: productOrProducts };
    
    if (import.meta.env.DEV) {
      const count = Array.isArray(productOrProducts) ? productOrProducts.length : 1;
      console.log('API CALL: /api/sync-baselinker', { count });
    }
    
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
    
    return result;

  } catch (error) {
    console.error('Failed to sync to BaseLinker:', error);
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
};

export const generateImages = async (productId: string): Promise<{ ok: boolean; data?: { images: { url: string; variant: string }[] }; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  
  try {
    if (import.meta.env.DEV) {
      console.log('API CALL: /api/image-gen', { productId });
    }
    
    response = await fetch(`${BACKEND_URL}/api/image-gen`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ productId }),
    });

    const result = await parseResponse(response);

    if (!response.ok) {
      const errorInfo = { 
        code: response.status, 
        message: result?.error?.message || response.statusText || `Request failed with status ${response.status}` 
      };
      return { ok: false, error: errorInfo };
    }
    
    return result || { ok: true, data: { images: [] } };
    
  } catch (error) {
    console.error('Failed to generate images:', error);
    const errorInfo = extractErrorInfo(error, response);
    return { ok: false, error: errorInfo };
  }
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
  message: string
): Promise<{ ok: boolean; data?: ChatAssistantPayload; error?: { code: number; message: string } }> => {
  let response: Response | undefined;
  
  try {
    if (import.meta.env.DEV) {
      console.log('API CALL: /api/chat', { productId, messageLength: message.length });
    }
    
    response = await fetch(`${BACKEND_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ productId, message }),
    });

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
