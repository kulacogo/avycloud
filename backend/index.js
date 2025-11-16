
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const { saveProduct, getProduct, getAllProducts, deleteProduct, updateProductSyncStatus } = require('./lib/firestore');
const { uploadBase64Image, deleteProductImages, uploadJobFile } = require('./lib/storage');
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
const { getSecretValue } = require('./lib/secret-values');
const { enqueueJob, resumePendingJobs } = require('./services/job-runner');
const {
  createWarehouseLayout,
  listWarehouseZones,
  getBinsForZone,
  getBinByCode,
  assignProductToBin,
  removeProductFromBin,
} = require('./lib/warehouse');
const { buildLabelHtml } = require('./services/label-printer');

// --- Configuration ---
const PORT = process.env.PORT || 8080;
const GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud'; // Auto-detect from Cloud Run or fallback

// --- Initialization ---
const app = express();
const MAX_IMAGE_FILES = 25;
const MAX_IMAGE_FILE_SIZE = 8 * 1024 * 1024; // 8 MB per file, total tracked separately
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

resumePendingJobs().catch((error) => {
  console.error('Failed to resume pending identification jobs:', error);
});

async function resolveGeminiApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  return await getSecretValue('GEMINI_API_KEY');
}

async function generateImagesWithGemini(product, count = 3) {
  // Use Gemini 2.5 Flash Image (Nano Banana) for image generation
  const apiKey = await resolveGeminiApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  // Build detailed prompt based on product data
  const prompt = `Generate a professional product photograph based on these specifications:

Product Name: ${product.identification?.name}
Brand: ${product.identification?.brand}
Category: ${product.identification?.category}
Description: ${product.details?.short_description || 'N/A'}
Key Features: ${(product.details?.key_features || []).join(', ')}
Attributes: ${Object.entries(product.details?.attributes || {}).map(([k,v]) => `${k}: ${v}`).join(', ')}

Requirements:
- Professional studio lighting
- White or neutral background
- Product centered and clearly visible
- Photorealistic, high quality, 4K
- Show the actual product based on the description and attributes above
- Match the brand style and product category`;

  const variants = ['front view', 'angled view', 'detail shot', 'packaging'];
  const results = [];

  // If product has existing images, include them as reference
  const existingImages = (product.details?.images || [])
    .filter(img => img.url_or_base64 && img.url_or_base64.startsWith('http'))
    .slice(0, 2); // Max 2 reference images

  // Generate images one by one
  for (let i = 0; i < Math.min(count, 4); i++) {
    try {
      const parts = [];
      
      // Add existing product images as reference if available
      if (existingImages.length > 0 && i === 0) {
        for (const img of existingImages) {
          try {
            const imgResponse = await fetch(img.url_or_base64);
            const imgBuffer = await imgResponse.arrayBuffer();
            const base64 = Buffer.from(imgBuffer).toString('base64');
            parts.push({
              inlineData: {
                mimeType: 'image/jpeg',
                data: base64
              }
            });
          } catch (e) {
            console.log('Could not fetch reference image:', e.message);
          }
        }
        parts.push({ text: `Based on these reference images, generate a similar professional product photo showing: ${prompt}. ${variants[i]}.` });
      } else {
        parts.push({ text: `${prompt}\n\nGenerate: ${variants[i]}` });
      }

      const response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-goog-api-key': apiKey
          },
          body: JSON.stringify({
            contents: [{
              parts: parts
            }],
            generationConfig: {
              temperature: 0.4,
              topK: 40,
              topP: 0.95,
              maxOutputTokens: 8192
            }
          })
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Gemini image generation failed for variant ${variants[i]}:`, errorText);
        continue;
      }

      const data = await response.json();
      
      // Extract base64 image from response
      const candidate = data.candidates?.[0];
      if (!candidate?.content?.parts) {
        console.error('No image parts in response');
        continue;
      }

      // Find the inline data part
      const imagePart = candidate.content.parts.find(p => p.inlineData);
      if (!imagePart?.inlineData?.data) {
        console.error('No inline data in response');
        continue;
      }

      const base64Image = imagePart.inlineData.data;
      const mimeType = imagePart.inlineData.mimeType || 'image/png';
      
      // Upload to Cloud Storage
      const imageUrl = await uploadBase64Image(
        `data:${mimeType};base64,${base64Image}`, 
        product.id, 
        `generated_${variants[i].replace(/\s+/g, '_')}_${Date.now()}`
      );
      
      results.push({ url: imageUrl, variant: variants[i].split(' ')[0] });
      
      // Delay to avoid rate limiting
      if (i < count - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch (error) {
      console.error(`Error generating image ${i}:`, error.message);
    }
  }

  if (results.length === 0) {
    throw new Error('No images could be generated');
  }

  return results;
}

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
app.use(express.json({ limit: '1mb' }));

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
          message: `Bildupload überschreitet das 25 MB-Gesamtkontingent (Konfiguration: ${MAX_IMAGE_FILES} Dateien à ca. ${Math.floor(
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
    
    res.status(200).json({
      ok: allSucceeded,
      results: results
    });
    
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
    res.json({ ok: true, products });
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
    res.json({ ok: true, product });
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

    const html = await buildLabelHtml({
      code: sku,
      title: product.identification?.name || '',
      label: 'SKU',
    });

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

app.get('/api/warehouse/bins/:code/label', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const bin = await getBinByCode(code);
    if (!bin) {
      return res.status(404).json({ ok: false, error: { code: 404, message: 'BIN nicht gefunden.' } });
    }
    const html = await buildLabelHtml({
      code,
      title: `${bin.zone} ${bin.etage} Gang ${bin.gang} Regal ${bin.regal} Ebene ${bin.ebene}`,
      label: 'BIN',
    });
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
            const publicUrl = await uploadBase64Image(image.url_or_base64, product.id, variant);
            
            processedImages.push({
              ...image,
              url_or_base64: publicUrl,
              source: image.source || 'uploaded'
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
      
      product.details.images = processedImages;
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

// --- Image Generation Endpoint ---
app.post('/api/image-gen', async (req, res) => {
  try {
    const { productId, count = 3 } = req.body;
    
    if (!productId) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: 'Product ID is required'
        }
      });
    }
    
    const product = await getProduct(productId);
    if (!product) {
      return res.status(404).json({ ok: false, error: { code: 404, message: 'Product not found' } });
    }

    const foundImages = [];
    
    // STEP 1: Search for real product images on the internet FIRST
    console.log('Step 1: Searching for real product images...');
    
    // Try to find images from price sources
    const sources = product.details?.pricing?.lowest_price?.sources || [];
    for (const source of sources) {
      if (source?.url && foundImages.length < 3) {
        try {
          const resp = await fetch(source.url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
          const html = await resp.text();
          
          // Extract OpenGraph images
          const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1];
          if (og && !foundImages.some(img => img.url === og)) {
            foundImages.push({ url: og, variant: 'web', source: 'web' });
          }
          
          // Extract regular img tags
          const imgs = Array.from(html.matchAll(/<img[^>]+src=["']([^"']+)["']/g))
            .map(m => m[1])
            .filter(u => /^https?:\/\//.test(u) && !u.includes('logo') && !u.includes('icon'))
            .slice(0, 5);
          
          for (const imgUrl of imgs) {
            if (foundImages.length >= 3) break;
            if (!foundImages.some(img => img.url === imgUrl)) {
              foundImages.push({ url: imgUrl, variant: 'web', source: 'web' });
            }
          }
        } catch (e) {
          console.log('Failed to fetch images from', source.url, e.message);
        }
      }
    }
    
    // Search via Google/DuckDuckGo if still not enough images
    if (foundImages.length < 3) {
      const searchQuery = `${product.identification?.name} ${product.identification?.brand} ${product.details?.identifiers?.ean || ''}`.trim();
      const q = encodeURIComponent(searchQuery);
      
      try {
        // Try DuckDuckGo image search
        const searchUrl = `https://duckduckgo.com/html/?iax=images&ia=images&q=${q}`;
        const resp = await fetch(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = await resp.text();
        const imgLinks = Array.from(html.matchAll(/imgurl=([^&"]+)/g))
          .map(m => decodeURIComponent(m[1]))
          .filter(u => /^https?:\/\//.test(u));
        
        for (const url of imgLinks.slice(0, 5)) {
          if (foundImages.length >= 3) break;
          if (!foundImages.some(img => img.url === url)) {
            foundImages.push({ url, variant: 'web', source: 'web' });
          }
        }
      } catch (e) {
        console.log('Image search failed:', e.message);
      }
    }
    
    console.log(`Found ${foundImages.length} real product images on the internet`);
    
    // STEP 2: Only if NO real images found, generate with Gemini
    let generatedImages = [];
    if (foundImages.length === 0) {
      console.log('Step 2: No real images found, generating with Gemini 2.5 Flash Image...');
      generatedImages = await generateImagesWithGemini(product, Math.min(count, 3));
    }
    
    // Combine found and generated images
    const allImages = [
      ...foundImages.map(img => ({ url: img.url, variant: img.variant })),
      ...generatedImages.map(img => ({ url: img.url, variant: img.variant }))
    ];
    
    // Persist to product
    const newImageObjects = allImages.map(img => ({
      source: foundImages.some(f => f.url === img.url) ? 'web' : 'generated',
      variant: img.variant,
      url_or_base64: img.url
    }));
    
    const updatedProduct = { 
      ...product, 
      details: { 
        ...product.details, 
        images: [...(product.details.images || []), ...newImageObjects] 
      } 
    };
    await saveProduct(updatedProduct);

    return res.json({ 
      ok: true, 
      data: { 
        images: allImages,
        summary: {
          found: foundImages.length,
          generated: generatedImages.length
        }
      } 
    });
    
  } catch (error) {
    console.error('Error in image generation:', error);
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

// --- Server Start ---
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
