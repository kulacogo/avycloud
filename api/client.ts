
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

const waitForJobResult = async (
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
      return job.result as ProductBundle;
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

// This function now makes a REAL API call to the live backend server.
export const identifyProductApi = async (
  images: File[],
  barcodes: string,
  options?: IdentifyApiOptions
): Promise<{ ok: boolean; data?: ProductBundle; error?: { code: number; message: string } }> => {
  const formData = new FormData();
  formData.append('barcodes', barcodes);
  images.forEach((image) => {
    formData.append('images', image, image.name);
  });
  if (options?.model) {
    formData.append('model', options.model);
  }

  let response: Response | undefined;
  const reportStatus = createStatusReporter(options?.onStatus);
  reportStatus('upload');

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

    reportStatus('queued');

    const bundle = await waitForJobResult(jobId, options?.signal, reportStatus);
    if (!bundle || !bundle.products) {
      return {
        ok: false,
        error: {
          code: 502,
          message: 'Job finished without valid product data.',
        },
      };
    }

    return { ok: true, data: bundle };
  } catch (error) {
    console.error('Failed to process job:', error);
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

export const fetchOrders = async (limit = 50): Promise<Order[]> => {
  const response = await fetch(`${BACKEND_URL}/api/orders?limit=${limit}`);
  const result = await parseResponse(response);
  if (!response.ok) {
    throw new Error(result?.error?.message || 'Aufträge konnten nicht geladen werden.');
  }
  return result?.data || [];
};

export const syncOrders = async (): Promise<Order[]> => {
  const response = await fetch(`${BACKEND_URL}/api/orders/sync`, {
    method: 'POST',
  });
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

  const targetName = `bin-labels-${Date.now()}`;
  const popup = window.open('about:blank', targetName, 'noopener');
  if (!popup) {
    return { ok: false, error: { code: 0, message: 'Popup wurde blockiert.' } };
  }
  popup.document.write('<p style="font-family:system-ui;padding:16px;">Bereite BIN-Labels vor...</p>');

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = `${BACKEND_URL}/api/warehouse/bins/labels`;
  form.target = targetName;
  form.style.display = 'none';

  if (normalizedCodes?.length) {
    normalizedCodes.forEach((code) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'codes';
      input.value = code;
      form.appendChild(input);
    });
  } else {
    const mapping: Record<string, string | number | undefined> = {
      zone: options.zone,
      etage: options.etage,
      gang: options.gang,
      regal: options.regal,
    };
    Object.entries(mapping).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = key;
      input.value = String(value);
      form.appendChild(input);
    });
  }

  document.body.appendChild(form);
  form.submit();
  window.setTimeout(() => {
    form.remove();
  }, 0);

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
