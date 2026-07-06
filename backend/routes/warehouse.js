const router = require('express').Router();
const { requirePermission } = require('../lib/rbac');
const { getProduct } = require('../lib/firestore');
const {
  listWarehouseZones,
  createWarehouseLayout,
  getBinsForZone,
  getBinByCode,
  deleteWarehouseGang,
  deleteWarehouseRegal,
  deleteWarehouseEbene,
  assignProductToBin,
  removeProductFromBin,
  refreshProductInventory,
  findProductDocument,
  bookStockIn,
  bookStockOut,
  listBinsForProduct,
  createChildBin,
  deleteChildBin,
  listChildBins,
} = require('../lib/warehouse');
const {
  buildBinLabelHtml,
  buildBinLabelsHtml,
  buildBinLabelsPdf,
} = require('../services/label-printer');

// ── Helpers ──────────────────────────────────────────────────────────

const parseTruthy = (value) => {
  if (value === true || value === 1) return true;
  const v = String(value || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'y';
};

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

// ── Routes ───────────────────────────────────────────────────────────

router.get('/zones', requirePermission('warehouse', 'read'), async (req, res) => {
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

router.post('/layouts', requirePermission('warehouse', 'write'), async (req, res) => {
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

router.delete('/layouts/:zone/:etage/gangs/:gang', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const zone = req.params.zone.toUpperCase();
    const etage = req.params.etage.toUpperCase();
    const gang = Number(req.params.gang);
    const dryRun = parseTruthy(req.query?.dryRun) || !parseTruthy(req.query?.confirm);

    const result = await deleteWarehouseGang(zone, etage, gang, { dryRun });
    res.json({ ok: true, data: { ...result, dryRun } });
  } catch (error) {
    console.error('Failed to delete warehouse gang:', error);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: error.message || 'Gang konnte nicht gelöscht werden.' },
    });
  }
});

router.delete('/layouts/:zone/:etage/gangs/:gang/regale/:regal', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const zone = req.params.zone.toUpperCase();
    const etage = req.params.etage.toUpperCase();
    const gang = Number(req.params.gang);
    const regal = Number(req.params.regal);
    const dryRun = parseTruthy(req.query?.dryRun) || !parseTruthy(req.query?.confirm);

    const result = await deleteWarehouseRegal(zone, etage, gang, regal, { dryRun });
    res.json({ ok: true, data: { ...result, dryRun } });
  } catch (error) {
    console.error('Failed to delete warehouse regal:', error);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: error.message || 'Regal konnte nicht gelöscht werden.' },
    });
  }
});

router.delete('/layouts/:zone/:etage/gangs/:gang/regale/:regal/ebenen/:ebene', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const zone = req.params.zone.toUpperCase();
    const etage = req.params.etage.toUpperCase();
    const gang = Number(req.params.gang);
    const regal = Number(req.params.regal);
    const ebene = String(req.params.ebene).toUpperCase();
    const dryRun = parseTruthy(req.query?.dryRun) || !parseTruthy(req.query?.confirm);

    const result = await deleteWarehouseEbene(zone, etage, gang, regal, ebene, { dryRun });
    res.json({ ok: true, data: { ...result, dryRun } });
  } catch (error) {
    console.error('Failed to delete warehouse ebene:', error);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: error.message || 'Ebene konnte nicht gelöscht werden.' },
    });
  }
});

router.get('/zones/:zone/:etage', requirePermission('warehouse', 'read'), async (req, res) => {
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

// BIN label endpoints – define before generic /:code route to avoid shadowing
router.get('/bins/labels', requirePermission('warehouse', 'read'), async (req, res) => {
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

router.post('/bins/labels', requirePermission('warehouse', 'read'), async (req, res) => {
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

router.get('/bins/labels.pdf', requirePermission('warehouse', 'read'), async (req, res) => {
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

router.post('/bins/labels.pdf', requirePermission('warehouse', 'read'), async (req, res) => {
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

router.get('/bins/:code', requirePermission('warehouse', 'read'), async (req, res) => {
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

router.get('/bins/:code/label', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!code) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'BIN-Code ist erforderlich.' } });
    }
    const bin = await getBinByCode(code);
    if (!bin) {
      console.warn(`BIN ${code} nicht gefunden – Label wird trotzdem erzeugt.`);
    }
    const labelInput = bin && bin.parentBinCode ? { code, parentBinCode: bin.parentBinCode } : { code };
    const html = await buildBinLabelHtml(labelInput);
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

router.post('/bins/:code/assign', requirePermission('warehouse', 'write'), async (req, res) => {
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

router.delete('/bins/:code/products/:productId', requirePermission('warehouse', 'write'), async (req, res) => {
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

// ── Child-BIN (Container) Routes ─────────────────────────────────────

router.get('/bins/:code/containers', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const children = await listChildBins(code);
    res.json({ ok: true, data: children });
  } catch (err) {
    console.error(`[GET /api/warehouse/bins/:code/containers] ${err.message}`, err);
    res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: err.message } });
  }
});

router.post('/bins/:code/containers', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const child = await createChildBin(code, req.body || {});
    res.status(201).json({ ok: true, data: child });
  } catch (err) {
    console.error(`[POST /api/warehouse/bins/:code/containers] ${err.message}`, err);
    res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: err.message } });
  }
});

router.delete('/bins/:code/containers/:childCode', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const childCode = req.params.childCode.toUpperCase();
    const result = await deleteChildBin(childCode);
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error(`[DELETE /api/warehouse/bins/:code/containers/:childCode] ${err.message}`, err);
    res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: err.message } });
  }
});

router.post('/stock-in', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const { sku, productId, barcode, binCode, quantity, meta, paletteCode } = req.body || {};
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
      meta: {
        ...(meta && typeof meta === 'object' ? meta : {}),
        source: 'api',
        action: 'stock-in',
        // who put it away — for the Mitarbeiter-Leistung scoreboard (eingelagert)
        ...(req.user?.uid ? { actor: { uid: req.user.uid, email: req.user.email || null } } : {}),
        ...(paletteCode ? { paletteCode } : {}),
      },
    });
    if (result?.product) {
      // Multi-channel stock push (eBay + Kaufland) — with retry on failure
      const tenantId = req.user?.tenantId || 'default';
      const { syncStockWithRetry } = require('../services/stock-sync-dispatcher');
      syncStockWithRetry({ tenantId, product: result.product, reason: 'stock-in' })
        .catch((err) => console.warn('[stock-sync] dispatch failed:', err?.message || err));
    }
    res.json({ ok: true, data: result });
  } catch (error) {
    console.error('Stow workflow failed:', error);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: error.message || 'Einlagerung fehlgeschlagen.' },
    });
  }
});

router.post('/stock-out', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const { sku, productId, barcode, binCode, quantity, meta, orderId, orderItemId } = req.body || {};
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
      meta: {
        ...(meta && typeof meta === 'object' ? meta : {}),
        source: 'api',
        action: 'stock-out',
        orderId: orderId || null,
        orderItemId: orderItemId || null,
      },
    });
    if (result?.product) {
      // Multi-channel stock push (eBay + Kaufland) — with retry on failure
      const tenantId = req.user?.tenantId || 'default';
      const { syncStockWithRetry } = require('../services/stock-sync-dispatcher');
      syncStockWithRetry({ tenantId, product: result.product, reason: 'stock-out' })
        .then((r) => {
          const channels = r.results.filter((c) => c.status === 'success').map((c) => c.channel);
          if (channels.length) {
            console.log(`[stock-sync] pushed to ${channels.join(',')} for product=${result.product.id}`);
          }
        })
        .catch((err) => {
          console.warn('[stock-sync] dispatch failed:', err?.message || err);
        });
    }
    res.json({ ok: true, data: result });
  } catch (error) {
    console.error('Pick workflow failed:', error);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: error.message || 'Auslagerung fehlgeschlagen.' },
    });
  }
});

router.post('/refresh-inventory', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const { productId, sku, barcode } = req.body || {};
    if (!productId && !sku && !barcode) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'productId, sku oder barcode ist erforderlich.' },
      });
    }

    const { ref } = await findProductDocument({ productId, sku, barcode });
    const resolvedProductId = ref.id;
    await refreshProductInventory(resolvedProductId);
    const product = await getProduct(resolvedProductId);

    res.json({ ok: true, data: { product } });
  } catch (error) {
    console.error('Failed to refresh inventory for product:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Inventar konnte nicht aktualisiert werden.', details: error.message },
    });
  }
});

// ── Warehouse Settings ──────────────────────────────────────

const { firestore } = require('../lib/firestore');

function getWarehouseTenantId(req) {
  return req.user?.tenantId || 'default';
}

router.get('/settings', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const tenantId = getWarehouseTenantId(req);
    const doc = await firestore.collection('warehouse_settings').doc(tenantId).get();
    const data = doc.exists ? doc.data() : {};
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`[GET /api/warehouse/settings] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// write-Gate: überschreibt warehouse_settings inkl. Zonen/BINs — ohne Gate
// konnte jeder eingeloggte Nutzer (auch Betrachter) das Lagerlayout kaputt
// schreiben, während die Geschwister-Routen längst requirePermission tragen.
router.put('/settings', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const tenantId = getWarehouseTenantId(req);
    const { zones, bins, ...rest } = req.body;
    const data = { tenantId, updatedAt: new Date().toISOString(), updatedBy: req.user?.uid || null };
    if (zones !== undefined) data.zones = zones;
    if (bins !== undefined) data.bins = bins;
    Object.assign(data, rest);

    await firestore.collection('warehouse_settings').doc(tenantId).set(data, { merge: true });
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`[PUT /api/warehouse/settings] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// ── Movements (Bewegungen) ────────────────────────────────────────

router.get('/movements', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const { type, binCode, productId, from, to, limit: rawLimit, offset: rawOffset } = req.query;
    const limit = Math.min(parseInt(rawLimit || '50', 10) || 50, 200);
    const offset = parseInt(rawOffset || '0', 10) || 0;

    let query = firestore.collection('warehouseEvents').orderBy('createdAt', 'desc');

    if (type) query = query.where('type', '==', type);
    if (binCode) query = query.where('binCode', '==', binCode);
    if (productId) query = query.where('productId', '==', productId);

    // Date range filters — only apply if no other where clause conflicts with orderBy
    // Firestore limitation: range filter + orderBy must be on same field
    // We use createdAt for orderBy, so date range works
    if (from) {
      query = query.where('createdAt', '>=', new Date(from));
    }
    if (to) {
      const toDate = new Date(to);
      toDate.setDate(toDate.getDate() + 1); // inclusive end day
      query = query.where('createdAt', '<', toDate);
    }

    // For total count, we need a separate query (Firestore has no COUNT)
    // We'll estimate from the limited result set
    const snap = await query.limit(limit + offset + 1).get();
    const allDocs = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    // Convert Firestore Timestamps to ISO strings
    const movements = allDocs.slice(offset, offset + limit).map((m) => ({
      ...m,
      createdAt: m.createdAt?.toDate ? m.createdAt.toDate().toISOString() : m.createdAt,
    }));

    res.json({
      ok: true,
      movements,
      total: allDocs.length,
      hasMore: allDocs.length > offset + limit,
    });
  } catch (err) {
    console.error(`[GET /api/warehouse/movements] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// ── Inventories (Inventur) ────────────────────────────────────────

const INVENTORIES_COLLECTION = 'warehouse_inventories';

// List all inventories
router.get('/inventories', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const tenantId = getWarehouseTenantId(req);
    const snap = await firestore.collection(INVENTORIES_COLLECTION)
      .where('tenantId', '==', tenantId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    const inventories = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        ...d,
        createdAt: d.createdAt?.toDate ? d.createdAt.toDate().toISOString() : d.createdAt,
        startedAt: d.startedAt?.toDate ? d.startedAt.toDate().toISOString() : d.startedAt,
        completedAt: d.completedAt?.toDate ? d.completedAt.toDate().toISOString() : d.completedAt,
        counts: undefined, // Don't send counts in list view (can be large)
      };
    });

    res.json({ ok: true, inventories });
  } catch (err) {
    console.error(`[GET /api/warehouse/inventories] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// Get single inventory with counts
router.get('/inventories/:id', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const doc = await firestore.collection(INVENTORIES_COLLECTION).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Inventur nicht gefunden' } });

    const d = doc.data();
    res.json({
      ok: true,
      inventory: {
        id: doc.id,
        ...d,
        createdAt: d.createdAt?.toDate ? d.createdAt.toDate().toISOString() : d.createdAt,
        startedAt: d.startedAt?.toDate ? d.startedAt.toDate().toISOString() : d.startedAt,
        completedAt: d.completedAt?.toDate ? d.completedAt.toDate().toISOString() : d.completedAt,
      },
    });
  } catch (err) {
    console.error(`[GET /api/warehouse/inventories/:id] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// Create new inventory cycle
router.post('/inventories', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const tenantId = getWarehouseTenantId(req);
    const { name, scope = 'full', zoneFilter } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID', message: 'Name ist erforderlich (min. 2 Zeichen)' } });
    }

    // Build initial bin/product list from warehouse data
    const bins = [];
    if (scope === 'zone' && zoneFilter) {
      // Only bins from the specified zone
      for (const etage of ['GA', 'UG', 'EG']) {
        const zoneBins = await getBinsForZone(zoneFilter, etage);
        bins.push(...zoneBins.filter((b) => b.productCount > 0));
      }
    } else {
      // All zones
      const zones = await listWarehouseZones();
      for (const z of zones) {
        const zoneBins = await getBinsForZone(z.zone, z.etage);
        bins.push(...zoneBins.filter((b) => b.productCount > 0));
      }
    }

    // Build counts list from bins with products
    const counts = [];
    for (const bin of bins) {
      if (bin.products && bin.products.length > 0) {
        for (const prod of bin.products) {
          counts.push({
            binCode: bin.code,
            productId: prod.productId,
            sku: prod.sku || '',
            productName: prod.name || '',
            systemQty: prod.quantity || 0,
            countedQty: null,
            variance: null,
            countedAt: null,
          });
        }
      }
    }

    const now = new Date().toISOString();
    const inventoryData = {
      tenantId,
      name: name.trim(),
      status: 'active',
      scope,
      zoneFilter: scope === 'zone' ? zoneFilter : null,
      createdAt: now,
      startedAt: now,
      completedAt: null,
      counts,
      summary: {
        totalItems: counts.length,
        countedItems: 0,
        totalVariance: 0,
        completionPct: 0,
      },
      createdBy: req.user?.uid || null,
    };

    const ref = await firestore.collection(INVENTORIES_COLLECTION).add(inventoryData);
    res.json({ ok: true, inventory: { id: ref.id, ...inventoryData } });
  } catch (err) {
    console.error(`[POST /api/warehouse/inventories] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// Record counts for an inventory
router.post('/inventories/:id/counts', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const docRef = firestore.collection(INVENTORIES_COLLECTION).doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Inventur nicht gefunden' } });

    const data = doc.data();
    if (data.status === 'completed') {
      return res.status(400).json({ ok: false, error: { code: 'COMPLETED', message: 'Inventur bereits abgeschlossen' } });
    }

    const { counts: newCounts } = req.body;
    if (!Array.isArray(newCounts) || newCounts.length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID', message: 'counts Array erforderlich' } });
    }

    // Merge new counts into existing
    const existingCounts = data.counts || [];
    const now = new Date().toISOString();

    for (const nc of newCounts) {
      const idx = existingCounts.findIndex(
        (c) => c.binCode === nc.binCode && c.productId === nc.productId
      );
      if (idx >= 0) {
        existingCounts[idx].countedQty = nc.countedQty;
        existingCounts[idx].variance = nc.countedQty - existingCounts[idx].systemQty;
        existingCounts[idx].countedAt = now;
      }
    }

    const countedItems = existingCounts.filter((c) => c.countedQty !== null).length;
    const totalVariance = existingCounts
      .filter((c) => c.variance !== null)
      .reduce((sum, c) => sum + c.variance, 0);

    await docRef.update({
      counts: existingCounts,
      summary: {
        totalItems: existingCounts.length,
        countedItems,
        totalVariance,
        completionPct: existingCounts.length > 0 ? Math.round((countedItems / existingCounts.length) * 100) : 0,
      },
    });

    res.json({ ok: true, countedItems, totalVariance });
  } catch (err) {
    console.error(`[POST /api/warehouse/inventories/:id/counts] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// Complete an inventory
router.post('/inventories/:id/complete', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const docRef = firestore.collection(INVENTORIES_COLLECTION).doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Inventur nicht gefunden' } });

    const data = doc.data();
    if (data.status === 'completed') {
      return res.status(400).json({ ok: false, error: { code: 'COMPLETED', message: 'Inventur bereits abgeschlossen' } });
    }

    const counts = data.counts || [];
    const variances = counts.filter((c) => c.variance !== null && c.variance !== 0);
    const countedItems = counts.filter((c) => c.countedQty !== null).length;
    const totalVariance = counts
      .filter((c) => c.variance !== null)
      .reduce((sum, c) => sum + c.variance, 0);

    await docRef.update({
      status: 'completed',
      completedAt: new Date().toISOString(),
      summary: {
        totalItems: counts.length,
        countedItems,
        totalVariance,
        completionPct: 100,
      },
    });

    res.json({ ok: true, variances, totalVariance });
  } catch (err) {
    console.error(`[POST /api/warehouse/inventories/:id/complete] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

module.exports = { router };
