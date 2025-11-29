
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const {
  saveProduct,
  getProduct,
  getAllProducts,
  deleteProduct,
  updateProductSyncStatus,
  listOrders,
} = require('./lib/firestore');
const {
  createJob: createImproveJob,
  getJob: getImproveJob,
} = require('./lib/improve-jobs');
const { uploadBase64Image, deleteProductImages, uploadJobFile } = require('./lib/storage');
const { recordManualProductImage } = require('./lib/product-images');
const { createJob, getJob } = require('./lib/jobs');
const { ensureProductSku } = require('./lib/sku');
const {
  runProductIdentification,
  BARCODE_LIMIT_ERROR,
  IMAGE_PAYLOAD_ERROR,
  MAX_BARCODE_COUNT,
  MAX_IMAGE_PAYLOAD_BYTES,
  TOOL_ITERATION_ERROR,
} = require('./services/enrichment');
const { runProductChat } = require('./services/product-chat');
const { improveExistingProduct } = require('./services/improve');
const { getSecretValue } = require('./lib/secret-values');
const { enqueueJob, startJobRunner } = require('./services/job-runner');
const { enqueueImproveJob, startImproveRunner } = require('./services/improve-runner');
const {
  createWarehouseLayout,
  listWarehouseZones,
  getBinsForZone,
  getBinByCode,
  assignProductToBin,
  removeProductFromBin,
  bookStockIn,
  bookStockOut,
  listBinsForProduct,
  getProductBinSummaryMap,
} = require('./lib/warehouse');
const { buildProductLabelsHtml, buildBinLabelHtml, buildBinLabelsHtml, buildBinLabelsPdf } = require('./services/label-printer');
const { scanToBuffer } = require('./services/scanner');
const { syncNewOrders, markOrderAsPicked } = require('./services/order-sync');

// --- Configuration ---
const PORT = process.env.PORT || 8080;
const GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud'; // Auto-detect from Cloud Run or fallback
const IMAGE_PROXY_TIMEOUT_MS = parseInt(process.env.IMAGE_PROXY_TIMEOUT_MS || '10000', 10);
const IMAGE_PROXY_MAX_BYTES = parseInt(process.env.IMAGE_PROXY_MAX_BYTES || `${5 * 1024 * 1024}`, 10); // 5 MB by default
const REQUEST_BODY_LIMIT =
  process.env.API_REQUEST_BODY_LIMIT ||
  process.env.REQUEST_BODY_LIMIT ||
  '50mb';

const normalizeIdentityKey = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized.toLowerCase();
};

const buildSkuToProductIdMap = (products = []) => {
  const map = new Map();
  products.forEach((product) => {
    if (!product || !product.id) return;
    const productId = String(product.id);
    const addKey = (value) => {
      const key = normalizeIdentityKey(value);
      if (key) {
        map.set(key, productId);
      }
    };
    addKey(productId);
    addKey(product.identification?.sku);
    addKey(product.details?.identifiers?.sku);
    addKey(product.details?.identifiers?.ean);
    addKey(product.details?.identifiers?.gtin);
    addKey(product.details?.identifiers?.upc);
  });
  return map;
};

const enrichProductsWithBinSummaries = async (products = []) => {
  if (!Array.isArray(products) || products.length === 0) return products;
  const productIds = products
    .map((product) => (product?.id ? String(product.id) : null))
    .filter(Boolean);
  if (!productIds.length) return products;

  const skuMap = buildSkuToProductIdMap(products);
  const summaryMap = await getProductBinSummaryMap(productIds, skuMap);

  return products.map((product) => {
    const key = product?.id ? String(product.id) : null;
    if (!key || !summaryMap.has(key)) {
      return product;
    }
    const summary = summaryMap.get(key);
    const mergedInventory = {
      ...(product.inventory || {}),
      quantity: summary.totalQuantity,
      physicalQuantity: summary.totalQuantity,
    };
    return {
      ...product,
      inventory: mergedInventory,
      storageBins: summary.bins,
    };
  });
};

// --- Initialization ---
const app = express();
const MAX_IMAGE_FILES = 25;
const MAX_IMAGE_FILE_SIZE = 8 * 1024 * 1024; // 8 MB per file, total tracked separately
const MAX_IMPROVE_BATCH = parseInt(process.env.MAX_IMPROVE_BATCH || '20', 10);
const GENERATED_IMAGE_SIGNATURE = /\b(generated|gpt|gemini|ai[-\s]?image|ai[-\s]?render)\b/i;

function looksGeneratedImageMeta(image = {}) {
  if (!image || typeof image !== 'object') {
    return false;
  }
  const source = (image.source || '').toString().toLowerCase();
  const notes = (image.notes || '').toString().toLowerCase();
  return GENERATED_IMAGE_SIGNATURE.test(source) || GENERATED_IMAGE_SIGNATURE.test(notes);
}
const allowedOrigins = [
  'https://avycloud.web.app',
  'https://avycloud.firebaseapp.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_FILE_SIZE,
    files: MAX_IMAGE_FILES,
  },
});

startJobRunner();
startImproveRunner();


// --- Middleware ---
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      ok: false,
      error: {
        code: 403,
        message: 'Origin not allowed by CORS policy.',
      },
    });
  }
  return next(err);
});
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));

// --- API Endpoints ---

app.get('/', (req, res) => {
  res.status(200).send('Product Intelligence Backend is running.');
});

app.post('/api/jobs', upload.array('images'), async (req, res) => {
  try {
    const files = req.files || [];
    const barcodes = req.body?.barcodes || '';
    if (files.length === 0 && (!barcodes || !barcodes.trim())) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: 'Bitte mindestens ein Bild oder einen Barcode bereitstellen.',
        },
      });
    }

    const locale = req.body?.locale || 'de-DE';
    const model = req.body?.model || null;
    const jobId = crypto.randomUUID();

    const uploadedFiles = await Promise.all(
      files.map((file) =>
        uploadJobFile(file.buffer, file.mimetype, jobId, file.originalname)
      )
    );

    await createJob(
      {
        payload: {
          files: uploadedFiles,
          barcodes,
          locale,
          model,
        },
      },
      jobId
    );

    enqueueJob(jobId);

    res.json({
      ok: true,
      jobId,
    });
  } catch (error) {
    console.error('Error creating job:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to create identification job',
        details: error.message,
      },
    });
  }
});

app.get('/api/jobs/:id', async (req, res) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 404,
          message: 'Job not found',
        },
      });
    }

    const response = {
      id: job.id,
      status: job.status,
      attempts: job.attempts,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      model: job.payload?.model || null,
    };

    if (job.status === 'done') {
      response.result = job.result;
      response.serpTrace = job.serpTrace;
    }
    if (job.status === 'failed') {
      response.error = job.error;
    }

    res.json({
      ok: true,
      data: response,
    });
  } catch (error) {
    console.error('Failed to load job:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to load job',
        details: error.message,
      },
    });
  }
});

app.get('/api/image-proxy', async (req, res) => {
  const sourceUrl = req.query?.url;
  if (!sourceUrl || typeof sourceUrl !== 'string') {
    return res.status(400).json({
      ok: false,
      error: {
        code: 400,
        message: 'Missing url query parameter.',
      },
    });
  }

  let target;
  try {
    target = new URL(sourceUrl);
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: {
        code: 400,
        message: 'Invalid image URL.',
      },
    });
  }

  if (!['http:', 'https:'].includes(target.protocol)) {
    return res.status(400).json({
      ok: false,
      error: {
        code: 400,
        message: 'Only http/https protocols are supported.',
      },
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_PROXY_TIMEOUT_MS);

  try {
    const upstream = await fetch(target.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'avystock-image-proxy/1.0',
        'Accept': 'image/*,*/*;q=0.8',
        'Referer': '',
      },
    });

    const contentLengthHeader = upstream.headers.get('content-length');
    if (!upstream.ok) {
      return res.status(502).json({
        ok: false,
        error: {
          code: upstream.status,
          message: `Upstream image request failed (${upstream.status}).`,
        },
      });
    }

    if (contentLengthHeader && Number(contentLengthHeader) > IMAGE_PROXY_MAX_BYTES) {
      return res.status(413).json({
        ok: false,
        error: {
          code: 413,
          message: 'Remote image exceeds proxy size limit.',
        },
      });
    }

    const arrayBuffer = await upstream.arrayBuffer();
    const body = Buffer.from(arrayBuffer);
    if (body.length > IMAGE_PROXY_MAX_BYTES) {
      return res.status(413).json({
        ok: false,
        error: {
          code: 413,
          message: 'Remote image exceeds proxy size limit.',
        },
      });
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return res.status(200).send(body);
  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({
        ok: false,
        error: {
          code: 504,
          message: 'Image proxy request timed out.',
        },
      });
    }
    console.error('Image proxy failed:', error);
    return res.status(502).json({
      ok: false,
      error: {
        code: 502,
        message: 'Failed to fetch upstream image.',
      },
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.post('/api/identify', upload.array('images'), async (req, res) => {
  try {
    const files = req.files || [];
    const barcodes = req.body?.barcodes || '';
    const locale = req.body?.locale || 'de-DE';
    const modelOverride = req.query?.model || req.body?.model || null;

    const result = await runProductIdentification({
      files,
      barcodes,
      locale,
      modelOverride,
    });

    res.status(200).json({
      ok: true,
      model: result.modelUsed,
      data: result.bundle,
      serpTrace: result.serpTrace,
    });
  } catch (error) {
    console.error('Error in /api/identify:', error);
    if (error.code === BARCODE_LIMIT_ERROR) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: `Zu viele Barcodes übermittelt. Maximal ${MAX_BARCODE_COUNT} Barcodes pro Anfrage sind erlaubt.`,
        },
      });
    }
    if (error.code === IMAGE_PAYLOAD_ERROR) {
      return res.status(413).json({
        ok: false,
        error: {
          code: 413,
          message: `Bildupload überschreitet das ${Math.floor(
            MAX_IMAGE_PAYLOAD_BYTES / (1024 * 1024)
          )} MB-Gesamtkontingent (Konfiguration: ${MAX_IMAGE_FILES} Dateien à ca. ${Math.floor(
            MAX_IMAGE_FILE_SIZE / (1024 * 1024)
          )} MB).`,
        },
      });
    }
    if (error.code === TOOL_ITERATION_ERROR) {
      return res.status(503).json({
        ok: false,
        model: error.modelUsed,
        error: {
          code: 503,
          message: 'SerpAPI/GPT Workflow hat zu viele Tool-Aufrufe benötigt. Bitte Eingabe verfeinern oder erneut versuchen.',
        },
        serpTrace: error.serpTrace || [],
      });
    }

    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: error.message,
      },
    });
  }
});


// --- Image Generation Endpoint ---
const { generateImagesForProduct } = require('./services/image-generation');

app.post('/api/generate-images', async (req, res) => {
  try {
    const { productId, product } = req.body;

    let targetProduct = product;
    if (!targetProduct && productId) {
      targetProduct = await getProduct(productId);
    }

    if (!targetProduct) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Product ID or object required' }
      });
    }

    const images = await generateImagesForProduct(targetProduct);

    res.json({
      ok: true,
      data: images
    });

  } catch (error) {
    console.error('Image generation failed:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to generate images',
        details: error.message
      }
    });
  }
});

// --- BaseLinker sync endpoint ---
const { syncProductToBaseLinker, syncProductsToBaseLinker } = require('./lib/baselinker');

app.post('/api/sync-baselinker', async (req, res) => {
  console.log('Received request on /api/sync-baselinker');

  try {
    const { product, products } = req.body;

    // Validate input
    if (!product && !products) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Please provide either a product or products array' }
      });
    }

    let results;

    // Handle single product
    if (product && !products) {
      const result = await syncProductToBaseLinker(product);
      results = [result];
    }
    // Handle multiple products
    else if (products && Array.isArray(products)) {
      if (products.length === 0) {
        return res.status(400).json({
          ok: false,
          error: { code: 400, message: 'Products array cannot be empty' }
        });
      }
      if (products.length > 100) {
        return res.status(400).json({
          ok: false,
          error: { code: 400, message: 'Maximum 100 products per sync request' }
        });
      }
      results = await syncProductsToBaseLinker(products);
    }
    else {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Invalid request format' }
      });
    }

    // Check if all succeeded
    const allSucceeded = results.every(r => r.status === 'synced');
    const failedResults = results.filter(r => r.status === 'failed');

    try {
      await Promise.all(
        results.map((result) =>
          updateProductSyncStatus(
            result.id,
            result.status,
            result.status === 'synced' ? new Date().toISOString() : null
          ).catch((error) => {
            console.error(`Failed to update sync status for ${result.id}:`, error);
          })
        )
      );
    } catch (statusError) {
      console.error('Error while updating sync status metadata:', statusError);
    }

    const responsePayload = {
      ok: allSucceeded,
      results,
    };

    if (failedResults.length) {
      responsePayload.error = {
        code: 502,
        message: failedResults
          .map((entry) => `${entry.id}: ${entry.message || 'Sync fehlgeschlagen'}`)
          .join(' | '),
      };
    }

    res.status(200).json(responsePayload);

  } catch (error) {
    console.error('Error in sync-baselinker endpoint:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'An internal server error occurred during sync',
        details: error.message
      }
    });
  }
});

// --- Product Management Endpoints ---

// Get all products
app.get('/api/products', async (req, res) => {
  try {
    const products = await getAllProducts();
    const enriched = await enrichProductsWithBinSummaries(products);
    res.json({ ok: true, products: enriched });
  } catch (error) {
    console.error('Error getting products:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to load products',
        details: error.message
      }
    });
  }
});

// Batch product labels (needs to be defined before /:id routes)
app.get('/api/products/labels', async (req, res) => {
  try {
    const idsParam = req.query.ids;
    if (!idsParam) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Es wurden keine Produkt-IDs angegeben.' },
      });
    }
    const ids = Array.isArray(idsParam)
      ? idsParam
      : String(idsParam)
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    if (!ids.length) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Es wurden keine gültigen Produkt-IDs angegeben.' },
      });
    }

    const labels = [];
    const missing = [];
    for (const id of ids) {
      const product = await getProduct(id);
      if (!product) {
        missing.push(`Produkt ${id} wurde nicht gefunden`);
        continue;
      }
      const sku =
        product.identification?.sku || product.details?.identifiers?.sku || product.details?.identifiers?.ean;
      if (!sku) {
        missing.push(`${product.identification?.name || id} (keine SKU)`);
        continue;
      }
      const skuLine = sku.startsWith('SKU-') ? sku : `SKU-${sku}`;
      const name = (product.identification?.name || '').trim() || skuLine;
      labels.push({
        code: skuLine,
        skuLine,
        description: name,
      });
    }

    if (!labels.length) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: missing.length ? missing.join(', ') : 'Keine druckbaren Labels vorhanden.',
        },
      });
    }

    const html = await buildProductLabelsHtml(labels);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  } catch (error) {
    console.error('Failed to build product labels:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Labeldruck fehlgeschlagen', details: error.message },
    });
  }
});

// Get single product
app.get('/api/products/:id', async (req, res) => {
  try {
    const product = await getProduct(req.params.id);
    if (!product) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 404,
          message: 'Product not found'
        }
      });
    }
    const [enriched] = await enrichProductsWithBinSummaries([product]);
    res.json({ ok: true, product: enriched || product });
  } catch (error) {
    console.error('Error getting product:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to load product',
        details: error.message
      }
    });
  }
});

app.get('/api/products/:id/label', async (req, res) => {
  try {
    const product = await getProduct(req.params.id);
    if (!product) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 404,
          message: 'Product not found',
        },
      });
    }

    const sku =
      product.identification?.sku ||
      product.details?.identifiers?.sku ||
      product.details?.identifiers?.ean ||
      null;

    if (!sku) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: 'Product has no SKU assigned yet.',
        },
      });
    }

    const skuLine = sku.startsWith('SKU-') ? sku : `SKU-${sku}`;

    const html = await buildProductLabelsHtml([
      {
        code: skuLine,
        skuLine,
        description: product.identification?.name || skuLine,
      },
    ]);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(html);
  } catch (error) {
    console.error('Failed to generate label:', error);
    return res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to generate SKU label',
        details: error.message,
      },
    });
  }
});

// Warehouse APIs
app.get('/api/warehouse/zones', async (req, res) => {
  try {
    const zones = await listWarehouseZones();
    res.json({ ok: true, data: zones });
  } catch (error) {
    console.error('Failed to load warehouse zones:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Laden der Lagerzonen', details: error.message },
    });
  }
});

app.post('/api/warehouse/layouts', async (req, res) => {
  try {
    const { zone, etage, gangs, regale, ebenen } = req.body || {};
    if (!zone || !etage || !gangs || !regale || !ebenen) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Zone, Etage, Gänge, Regale und Ebenen sind erforderlich.' },
      });
    }
    const layout = await createWarehouseLayout({
      zone: String(zone).toUpperCase(),
      etage: String(etage).toUpperCase(),
      gangRange: gangs,
      regalRange: regale,
      ebeneRange: ebenen,
    });
    res.json({ ok: true, data: layout });
  } catch (error) {
    console.error('Failed to create warehouse layout:', error);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: error.message || 'Fehler beim Anlegen der Lagerstruktur.' },
    });
  }
});

app.get('/api/warehouse/zones/:zone/:etage', async (req, res) => {
  try {
    const zone = req.params.zone.toUpperCase();
    const etage = req.params.etage.toUpperCase();
    const bins = await getBinsForZone(zone, etage);
    res.json({ ok: true, data: bins });
  } catch (error) {
    console.error('Failed to load bins:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Laden der Bins', details: error.message },
    });
  }
});

app.get('/api/warehouse/bins/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const bin = await getBinByCode(code);
    if (!bin) {
      return res.status(404).json({ ok: false, error: { code: 404, message: 'BIN nicht gefunden.' } });
    }
    res.json({ ok: true, data: bin });
  } catch (error) {
    console.error('Failed to load bin:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Laden des BINs', details: error.message },
    });
  }
});

app.get('/api/products/:id/bins', async (req, res) => {
  try {
    const bins = await listBinsForProduct(req.params.id);
    res.json({ ok: true, data: bins });
  } catch (error) {
    console.error('Failed to load product bins:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Laden der BINs für dieses Produkt.', details: error.message },
    });
  }
});

app.post('/api/warehouse/bins/:code/assign', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const { productId, quantity = 1 } = req.body || {};
    if (!productId) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'productId ist erforderlich.' } });
    }
    const bin = await assignProductToBin(code, productId, Number(quantity));
    const updatedProduct = await getProduct(productId);
    res.json({ ok: true, data: { bin, product: updatedProduct } });
  } catch (error) {
    console.error('Failed to assign product to bin:', error);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: error.message || 'Fehler bei der Einlagerung.' },
    });
  }
});

app.delete('/api/warehouse/bins/:code/products/:productId', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const { productId } = req.params;
    await removeProductFromBin(code, productId);
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to remove product from bin:', error);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: error.message || 'Fehler beim Entfernen des Produkts.' },
    });
  }
});

app.post('/api/warehouse/stock-in', async (req, res) => {
  try {
    const { sku, productId, barcode, binCode, quantity } = req.body || {};
    if (!binCode) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Bin-Code ist erforderlich.' } });
    }
    const amount = Number(quantity);
    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Menge muss größer als 0 sein.' } });
    }
    const result = await bookStockIn({
      sku,
      productId,
      barcode,
      binCode: binCode.toUpperCase(),
      quantity: amount,
    });
    res.json({ ok: true, data: result });
  } catch (error) {
    console.error('Stow workflow failed:', error);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: error.message || 'Einlagerung fehlgeschlagen.' },
    });
  }
});

app.post('/api/warehouse/stock-out', async (req, res) => {
  try {
    const { sku, productId, barcode, binCode, quantity } = req.body || {};
    if (!binCode) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Bin-Code ist erforderlich.' } });
    }
    const amount = Number(quantity);
    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Menge muss größer als 0 sein.' } });
    }
    const result = await bookStockOut({
      sku,
      productId,
      barcode,
      binCode: binCode.toUpperCase(),
      quantity: amount,
    });
    res.json({ ok: true, data: result });
  } catch (error) {
    console.error('Pick workflow failed:', error);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: error.message || 'Auslagerung fehlgeschlagen.' },
    });
  }
});

function normalizeCodeList(input) {
  if (!input) return [];
  const values = Array.isArray(input) ? input : [input];
  return values
    .flatMap((entry) =>
      String(entry || '')
        .split(/[,\s]+/)
        .map((code) => code.trim().toUpperCase())
    )
    .filter(Boolean);
}

async function resolveBinCodes({ codesInput, zone, etage, gang, regal }) {
  const directCodes = normalizeCodeList(codesInput);
  if (directCodes.length) {
    return directCodes;
  }
  if (zone && etage) {
    const zoneCode = String(zone).toUpperCase();
    const etageCode = String(etage).toUpperCase();
    const binsForZone = await getBinsForZone(zoneCode, etageCode);
    const gangNumber = gang != null ? Number(gang) : undefined;
    const regalNumber = regal != null ? Number(regal) : undefined;
    return binsForZone
      .filter((bin) => {
        if (Number.isFinite(gangNumber) && bin.gang !== gangNumber) return false;
        if (Number.isFinite(regalNumber) && bin.regal !== regalNumber) return false;
        return true;
      })
      .map((bin) => bin.code);
  }
  return [];
}

async function sendBinLabelHtml(res, codes) {
  if (!codes.length) {
    return res.status(400).json({
      ok: false,
      error: { code: 400, message: 'Keine BIN-Codes gefunden. Bitte Codes oder Zone/Etage angeben.' },
    });
  }
  const uniqueCodes = [...new Set(codes)];
  const html = await buildBinLabelsHtml(uniqueCodes);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(html);
}

async function sendBinLabelsPdf(res, codes) {
  if (!codes.length) {
    return res.status(400).json({
      ok: false,
      error: { code: 400, message: 'Keine BIN-Codes gefunden. Bitte Codes oder Zone/Etage angeben.' },
    });
  }
  const uniqueCodes = [...new Set(codes)];
  const pdfBuffer = await buildBinLabelsPdf(uniqueCodes);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', 'inline; filename="bin-labels.pdf"');
  return res.send(pdfBuffer);
}

app.get('/api/warehouse/bins/:code/label', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!code) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'BIN-Code ist erforderlich.' } });
    }
    const bin = await getBinByCode(code);
    if (!bin) {
      console.warn(`BIN ${code} nicht gefunden – Label wird trotzdem erzeugt.`);
    }
    const html = await buildBinLabelHtml({ code });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  } catch (error) {
    console.error('Failed to generate bin label:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Erstellen des BIN-Labels', details: error.message },
    });
  }
});

app.get('/api/warehouse/bins/labels', async (req, res) => {
  try {
    const codes = await resolveBinCodes({
      codesInput: req.query.codes,
      zone: req.query.zone,
      etage: req.query.etage,
      gang: req.query.gang,
      regal: req.query.regal,
    });
    await sendBinLabelHtml(res, codes);
  } catch (error) {
    console.error('Failed to generate batch bin labels:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Erstellen der BIN-Labels', details: error.message },
    });
  }
});

app.post('/api/warehouse/bins/labels', async (req, res) => {
  try {
    const { zone, etage, gang, regal } = req.body || {};
    const bodyCodes = req.body?.codes ?? req.body?.['codes[]'];
    const resolvedCodes = await resolveBinCodes({
      codesInput: bodyCodes,
      zone,
      etage,
      gang,
      regal,
    });
    await sendBinLabelHtml(res, resolvedCodes);
  } catch (error) {
    console.error('Failed to generate batch bin labels (POST):', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Erstellen der BIN-Labels', details: error.message },
    });
  }
});

app.get('/api/warehouse/bins/labels.pdf', async (req, res) => {
  try {
    const codes = await resolveBinCodes({
      codesInput: req.query.codes,
      zone: req.query.zone,
      etage: req.query.etage,
      gang: req.query.gang,
      regal: req.query.regal,
    });
    await sendBinLabelsPdf(res, codes);
  } catch (error) {
    console.error('Failed to generate batch bin labels PDF:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Erstellen der BIN-Labels (PDF)', details: error.message },
    });
  }
});

app.post('/api/warehouse/bins/labels.pdf', async (req, res) => {
  try {
    const { zone, etage, gang, regal } = req.body || {};
    const bodyCodes = req.body?.codes ?? req.body?.['codes[]'];
    const resolvedCodes = await resolveBinCodes({
      codesInput: bodyCodes,
      zone,
      etage,
      gang,
      regal,
    });
    await sendBinLabelsPdf(res, resolvedCodes);
  } catch (error) {
    console.error('Failed to generate batch bin labels PDF (POST):', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Erstellen der BIN-Labels (PDF)', details: error.message },
    });
  }
});

app.post('/api/scanner/capture', async (req, res) => {
  try {
    const buffer = await scanToBuffer();
    const mimeType = process.env.SCAN_MIME_TYPE || 'image/png';
    res.json({
      ok: true,
      data: {
        mimeType,
        base64: buffer.toString('base64'),
        capturedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Scanner capture failed:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Scanner konnte nicht gestartet werden.', details: error.message },
    });
  }
});

// Save product
app.post('/api/save', async (req, res) => {
  try {
    const product = req.body;

    if (!product || !product.id) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: 'Invalid product data'
        }
      });
    }

    // Ensure SKU is present before persisting
    const assignedSku = ensureProductSku(product);

    // Process and upload images to Cloud Storage
    if (product.details && product.details.images) {
      const processedImages = [];

      for (let i = 0; i < product.details.images.length; i++) {
        const image = product.details.images[i];

        // Only process base64 images
        if (image.url_or_base64 && image.url_or_base64.startsWith('data:')) {
          try {
            const variant = image.variant || `image_${i}`;
            const uploadResult = await uploadBase64Image(image.url_or_base64, product.id, variant);
            const manualUpload = !image.source || image.source === 'upload' || image.source === 'uploaded';
            if (manualUpload) {
              await recordManualProductImage({
                productId: product.id,
                publicUrl: uploadResult.url,
                source: image.source || 'upload',
                variant,
                notes: image.notes || null,
                width: uploadResult.width,
                height: uploadResult.height,
              });
            }

            processedImages.push({
              ...image,
              url_or_base64: uploadResult.url,
              source: image.source || 'uploaded',
              width: uploadResult.width ?? image.width ?? null,
              height: uploadResult.height ?? image.height ?? null,
              mimeType: uploadResult.mimeType || image.mimeType || null,
            });
          } catch (error) {
            console.error('Failed to upload image:', error);
            // Keep original image if upload fails
            processedImages.push(image);
          }
        } else {
          // Keep URLs as-is
          processedImages.push(image);
        }
      }

      const filteredImages = processedImages.filter((img) => {
        if (looksGeneratedImageMeta(img)) {
          console.warn('Rejecting generated image metadata during save:', img?.url_or_base64 || img?.url || '');
          return false;
        }
        return true;
      });

      product.details.images = filteredImages;
    }

    // Save to Firestore
    const result = await saveProduct(product);

    res.json({
      ok: true,
      data: {
        ...result,
        sku: product.identification?.sku || assignedSku || null,
      },
    });
  } catch (error) {
    console.error('Error saving product:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to save product',
        details: error.message
      }
    });
  }
});
// Delete product
app.delete('/api/products/:id', async (req, res) => {
  try {
    const productId = req.params.id;

    // Delete images from Cloud Storage
    await deleteProductImages(productId);

    // Delete from Firestore
    await deleteProduct(productId);

    res.json({ ok: true });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to delete product',
        details: error.message
      }
    });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { productId, message, model: bodyModel } = req.body;
    const modelOverride = req.query?.model || bodyModel || null;

    if (!productId || !message) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: 'Product ID and message are required',
        },
      });
    }

    const product = await getProduct(productId);
    if (!product) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 404,
          message: 'Product not found',
        },
      });
    }

    const chatResult = await runProductChat(product, message, { modelOverride });

    res.json({
      ok: true,
      model: chatResult.modelUsed,
      data: chatResult,
    });
  } catch (error) {
    console.error('Error in chat endpoint:', error);
    res.status(500).json({
      ok: false,
      model: error.modelUsed,
      error: {
        code: 500,
        message: 'Failed to process chat request',
        details: error.message,
      },
    });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const orders = await listOrders(limit);
    res.json({ ok: true, data: orders });
  } catch (error) {
    console.error('Failed to load orders:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Aufträge konnten nicht geladen werden.',
        details: error.message,
      },
    });
  }
});

app.post('/api/orders/sync', async (req, res) => {
  try {
    const orders = await syncNewOrders();
    res.json({ ok: true, data: orders });
  } catch (error) {
    console.error('Failed to sync orders:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Auftragssync fehlgeschlagen.',
        details: error.message,
      },
    });
  }
});

app.post('/api/orders/:orderId/complete', async (req, res) => {
  try {
    const { orderId } = req.params;
    await markOrderAsPicked(orderId);
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to complete order:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Auftragsstatus konnte nicht aktualisiert werden.',
        details: error.message,
      },
    });
  }
});

// --- Price Refresh Endpoint ---
app.post('/api/price-refresh', async (req, res) => {
  try {
    const { productId } = req.body;

    if (!productId) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: 'Product ID is required'
        }
      });
    }

    // Load product from Firestore
    const product = await getProduct(productId);
    if (!product) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 404,
          message: 'Product not found'
        }
      });
    }

    // Helper: fetch HTML and extract price candidates in EUR
    const fetchAndExtractPrice = async (url) => {
      try {
        const resp = await fetch(url, { redirect: 'follow' });
        const html = await resp.text();
        // Common meta tags
        const metaPrice = html.match(/property=["']?product:price:amount["']?\s*content=["']?([\d.,]+)/i)?.[1]
          || html.match(/itemprop=["']?price["']?\s*content=["']?([\d.,]+)/i)?.[1];
        if (metaPrice) {
          return parseFloat(metaPrice.replace(',', '.'));
        }
        // Generic price regex (EUR 64,95 or 64,95 €)
        const m = html.match(/(\d{1,4}[.,]\d{2})\s*€|EUR\s*(\d{1,4}[.,]\d{2})/i);
        if (m) {
          const val = (m[1] || m[2]).replace(',', '.');
          return parseFloat(val);
        }
      } catch (e) {
        console.log('Price scrape failed for', url, e.message);
      }
      return null;
    };

    // 1) Try existing known sources on product
    const candidates = [];
    const sources = product.details?.pricing?.lowest_price?.sources || [];
    for (const s of sources) {
      if (s?.url) {
        const p = await fetchAndExtractPrice(s.url);
        if (!isNaN(p) && p > 0) candidates.push({ name: s.name || 'Source', url: s.url, price: p });
      }
    }

    // 2) Fallback: simple DuckDuckGo HTML search to find a likely shop page (no API key)
    if (candidates.length === 0) {
      const q = encodeURIComponent(`${product.identification.name} ${product.identification.brand} kaufen Preis`);
      const searchUrl = `https://duckduckgo.com/html/?q=${q}`;
      try {
        const resp = await fetch(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = await resp.text();
        const links = Array.from(html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/g)).slice(0, 5).map(m => m[1]);
        for (const link of links) {
          const p = await fetchAndExtractPrice(link);
          if (!isNaN(p) && p > 0) candidates.push({ name: 'Search Result', url: link, price: p });
        }
      } catch (e) {
        console.log('Search failed:', e.message);
      }
    }

    if (candidates.length === 0) {
      return res.json({ ok: true, data: { lowest_price: product.details?.pricing?.lowest_price || { amount: 0, currency: 'EUR', sources: [] }, price_confidence: 0 } });
    }

    // Pick lowest price
    candidates.sort((a, b) => a.price - b.price);
    const best = candidates[0];
    const data = {
      lowest_price: {
        amount: best.price,
        currency: 'EUR',
        sources: candidates.map(c => ({ name: c.name, url: c.url, price: c.price, checked_at: new Date().toISOString() }))
      },
      price_confidence: 0.8
    };

    // Persist
    product.details.pricing.lowest_price = data.lowest_price;
    product.details.pricing.price_confidence = data.price_confidence;
    await saveProduct(product);

    res.json({ ok: true, data });

  } catch (error) {
    console.error('Error in price refresh:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to refresh price',
        details: error.message
      }
    });
  }
});

app.post('/api/products/:id/improve', async (req, res) => {
  try {
    const productId = req.params.id;
    if (!productId) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Product ID is required' },
      });
    }
    const improved = await improveExistingProduct(productId);
    res.json({ ok: true, data: improved });
  } catch (error) {
    const status = error.code === 404 ? 404 : 500;
    res.status(status).json({
      ok: false,
      error: { code: status, message: error.message || 'Failed to improve product' },
    });
  }
});

app.post('/api/improve/jobs', async (req, res) => {
  try {
    const rawIds = Array.isArray(req.body?.productIds) ? req.body.productIds : [];
    const uniqueIds = [...new Set(rawIds.map((id) => String(id || '').trim()))].filter(Boolean);
    if (!uniqueIds.length) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Es wurden keine gültigen Produkt-IDs übermittelt.' },
      });
    }
    if (uniqueIds.length > MAX_IMPROVE_BATCH) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: `Maximal ${MAX_IMPROVE_BATCH} Produkte können gleichzeitig verbessert werden.`,
        },
      });
    }

    const jobs = [];
    const missing = [];

    for (const productId of uniqueIds) {
      const product = await getProduct(productId);
      if (!product) {
        missing.push(productId);
        continue;
      }
      const jobId = crypto.randomUUID();
      await createImproveJob(
        {
          payload: { productId },
          productId,
          productName: product.identification?.name || '',
        },
        jobId
      );
      enqueueImproveJob(jobId);
      jobs.push({ jobId, productId });
    }

    if (!jobs.length) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: 'Keine Improve-Jobs konnten erstellt werden (Produkte nicht gefunden).',
          missing,
        },
      });
    }

    res.json({
      ok: true,
      data: {
        jobs,
        missing,
      },
    });
  } catch (error) {
    console.error('Failed to create improve jobs:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Improve-Jobs konnten nicht angelegt werden.',
        details: error.message,
      },
    });
  }
});

app.get('/api/improve/jobs/:id', async (req, res) => {
  try {
    const job = await getImproveJob(req.params.id);
    if (!job) {
      return res.status(404).json({
        ok: false,
        error: { code: 404, message: 'Improve-Job wurde nicht gefunden.' },
      });
    }
    res.json({ ok: true, data: job });
  } catch (error) {
    console.error('Failed to load improve job:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Improve-Job konnte nicht geladen werden.', details: error.message },
    });
  }
});

// --- Server Start ---
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
