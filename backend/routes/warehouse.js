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

// ── Factory: backgroundSync wird von index.js injiziert ─────────────

let _backgroundSyncProductStockToBaseLinker = () => {};

function setBackgroundSync(fn) {
  _backgroundSyncProductStockToBaseLinker = fn;
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

router.post('/bins/:code/assign', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const { productId, quantity = 1 } = req.body || {};
    if (!productId) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'productId ist erforderlich.' } });
    }
    const bin = await assignProductToBin(code, productId, Number(quantity));
    const updatedProduct = await getProduct(productId);
    if (updatedProduct) {
      _backgroundSyncProductStockToBaseLinker(updatedProduct, 'bin-assign');
    }
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
    try {
      const updatedProduct = await getProduct(productId);
      if (updatedProduct) {
        _backgroundSyncProductStockToBaseLinker(updatedProduct, 'bin-remove');
      }
    } catch (syncErr) {
      console.warn('Background BaseLinker stock sync after bin-remove failed:', syncErr?.message || syncErr);
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to remove product from bin:', error);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: error.message || 'Fehler beim Entfernen des Produkts.' },
    });
  }
});

router.post('/stock-in', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const { sku, productId, barcode, binCode, quantity, meta } = req.body || {};
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
      },
    });
    if (result?.product) {
      _backgroundSyncProductStockToBaseLinker(result.product, 'stock-in');
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
      _backgroundSyncProductStockToBaseLinker(result.product, 'stock-out');
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

module.exports = { router, setBackgroundSync };
