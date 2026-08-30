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
  buildProductKeySet,
  binEntryMatchesKeySet,
  normalizeKey,
} = require('../lib/warehouse');
const {
  buildBinLabelHtml,
  buildBinLabelsHtml,
  buildBinLabelsPdf,
} = require('../services/label-printer');
const {
  createLots,
  listLots,
  updateLot,
  deleteLot,
} = require('../lib/warehouse-lots');

// ── Helpers ──────────────────────────────────────────────────────────

const parseTruthy = (value) => {
  if (value === true || value === 1) return true;
  const v = String(value || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'y';
};

// Idempotenz-Schluessel des Clients: Body (requestId | idempotencyKey),
// meta.requestId oder Header. Erste nicht-leere Quelle gewinnt.
function resolveStockInRequestId(req, meta) {
  const candidates = [
    req.body?.requestId,
    req.body?.idempotencyKey,
    meta && typeof meta === 'object' ? meta.requestId : null,
    meta && typeof meta === 'object' ? meta.idempotencyKey : null,
    req.get ? req.get('x-idempotency-key') : null,
    req.get ? req.get('x-request-id') : null,
  ];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const value = String(candidate).trim();
    if (value) return value.slice(0, 256);
  }
  return null;
}

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

// ── Los-Struktur (Einkaufs-Zugehörigkeit, ersetzt Paletten) ──────────
// Lose sind reine Zuordnungs-Metadaten (ops.sourceLot am Produkt), kein Bestand.

router.get('/lots', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const tenantId = req.user?.tenantId || 'default';
    // Counts sind teuer (eine Aggregation je Los) — nur auf Anfrage (Los-Struktur-Tab).
    const withCounts = parseTruthy(req.query?.withCounts);
    const lots = await listLots({ tenantId, withCounts });

    // Kennzahlen (Einheiten erfasst/Bestand/verkauft, Los-Wert) sind zwei
    // Voll-Scans — deshalb ebenfalls opt-in und hinter einem 5-Minuten-Cache.
    // Scheitern sie, wird die Los-Liste TROTZDEM ausgeliefert: die Lose selbst
    // sind die Stammdaten, die Kennzahlen nur eine Auswertung darueber. Der
    // Fehler wandert sichtbar als `metricsError` mit, statt still 0 Einheiten
    // und 0 € zu behaupten.
    if (parseTruthy(req.query?.withMetrics)) {
      try {
        const { getLotMetricsStore } = require('../lib/lot-metrics-store');
        const ergebnis = await getLotMetricsStore().kennzahlen(lots);
        return res.json({
          ok: true,
          data: lots.map((lot) => ({ ...lot, metrics: ergebnis.proLos.get(lot.code) || null })),
          meta: {
            ereignisseOhneLos: ergebnis.ereignisseOhneLos,
            ausreisser: ergebnis.ausreisser,
          },
        });
      } catch (err) {
        console.error(`[GET /api/warehouse/lots] Kennzahlen fehlgeschlagen: ${err.message}`, err);
        return res.json({ ok: true, data: lots, meta: { metricsError: err.message } });
      }
    }

    res.json({ ok: true, data: lots });
  } catch (err) {
    console.error(`[GET /api/warehouse/lots] ${err.message}`, err);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Laden der Lose', details: err.message },
    });
  }
});

router.post('/lots', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const { type, month, year, numbers } = req.body || {};
    if (!type || !month || !year) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Typ, Monat und Jahr sind erforderlich.' },
      });
    }
    const result = await createLots({
      type: String(type).toUpperCase(),
      month,
      year,
      numbers,
      tenantId: req.user?.tenantId || 'default',
      createdBy: req.user?.uid ? { uid: req.user.uid, email: req.user.email || null } : null,
    });
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error(`[POST /api/warehouse/lots] ${err.message}`, err);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: err.message || 'Fehler beim Anlegen der Lose.' },
    });
  }
});

// Los-Label-Routen VOR /lots/:code definieren (Route-Shadowing, wie /bins/labels).
router.get('/lots/labels', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const codes = normalizeCodeList(req.query.codes);
    if (!codes.length) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Keine Los-Codes angegeben.' },
      });
    }
    const html = await buildBinLabelsHtml([...new Set(codes)]);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  } catch (err) {
    console.error(`[GET /api/warehouse/lots/labels] ${err.message}`, err);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Erstellen der Los-Labels', details: err.message },
    });
  }
});

router.get('/lots/labels.pdf', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const codes = normalizeCodeList(req.query.codes);
    if (!codes.length) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Keine Los-Codes angegeben.' },
      });
    }
    const pdfBuffer = await buildBinLabelsPdf([...new Set(codes)]);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', 'inline; filename="los-labels.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    console.error(`[GET /api/warehouse/lots/labels.pdf] ${err.message}`, err);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Erstellen der Los-Labels (PDF)', details: err.message },
    });
  }
});

router.patch('/lots/:code', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const body = req.body || {};
    const payload = {};
    if ('ekBrutto' in body) payload.ekBrutto = body.ekBrutto;
    if ('note' in body) payload.note = body.note;
    const lot = await updateLot(req.params.code, payload);
    res.json({ ok: true, data: lot });
  } catch (err) {
    console.error(`[PATCH /api/warehouse/lots/:code] ${err.message}`, err);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: err.message || 'Los konnte nicht aktualisiert werden.' },
    });
  }
});

router.delete('/lots/:code', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const result = await deleteLot(req.params.code);
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error(`[DELETE /api/warehouse/lots/:code] ${err.message}`, err);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: err.message || 'Los konnte nicht gelöscht werden.' },
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
    const { sku, productId, barcode, binCode, quantity, meta, lotCode } = req.body || {};
    if (!binCode) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Bin-Code ist erforderlich.' } });
    }
    const amount = Number(quantity);
    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Menge muss größer als 0 sein.' } });
    }
    // Idempotenz-Schluessel (Incident 05.06.2026 — Doppel-Einlagerung).
    // Der Client soll pro Absicht EINE Id senden; ein Doppelklick/Retry schickt
    // dieselbe Id und wird in bookStockIn als Wiederholung erkannt. Fehlt sie,
    // greift dort zusaetzlich das Dedup-Fenster (Alt-Clients).
    const requestId = resolveStockInRequestId(req, meta);
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
        tenantId: req.user?.tenantId || 'default',
        ...(requestId ? { requestId } : {}),
        // who put it away — for the Mitarbeiter-Leistung scoreboard (eingelagert)
        ...(req.user?.uid ? { actor: { uid: req.user.uid, email: req.user.email || null } } : {}),
        ...(lotCode ? { lotCode } : {}),
      },
    });
    if (result?.deduped) {
      // Wiederholung: nichts gebucht → kein zweiter Marktplatz-Push
      // (der erste Lauf hat schon synchronisiert). Antwortform bleibt gleich.
      console.warn(
        `[POST /api/warehouse/stock-in] deduped (${result.dedupReason}) bin=${String(binCode).toUpperCase()} ` +
        `qty=${amount} requestId=${requestId || '-'} — Doppel-Absendung, kein zweiter Bestandszugang`
      );
      return res.json({ ok: true, data: result, deduped: true });
    }
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

// ── Inventur-Abschluss: Zaehlwert wird zur Wahrheit ──────────────────────
//
// Bis 2026-07-30 setzte `complete` nur `status:'completed'` und zeigte die
// Abweichung rot an — es korrigierte WEDER Bin NOCH Bestand. Die Inventur ist
// der einzige physische Eingang ins System und war damit wirkungslos.
//
// Flag `INVENTORY_COMPLETE_BOOKS` ('off' = Default = heutiges Verhalten,
// 'on' = bucht). Echte Verhaltensaenderung an einem Schreibpfad → gegated.
function inventoryCompleteBooksEnabled() {
  return String(process.env.INVENTORY_COMPLETE_BOOKS || 'off').trim().toLowerCase() === 'on';
}

// Produkt einer Zaehlposition auflösen: erst über die Doc-ID, dann über die SKU.
async function resolveInventoryPositionProduct(position) {
  const attempts = [];
  const productId = position && position.productId ? String(position.productId).trim() : '';
  const sku = position && position.sku ? String(position.sku).trim() : '';
  if (productId) attempts.push({ productId });
  if (sku) attempts.push({ sku });
  let lastError = null;
  for (const attempt of attempts) {
    try {
      return await findProductDocument(attempt);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Zaehlposition ohne productId/sku');
}

// Aktuelle Menge des Produkts im gezaehlten BIN (nicht die Zaehlvorgabe!).
function currentBinQuantity(bin, productData, productDocId) {
  const keySet = buildProductKeySet(productData || {});
  const normalized = normalizeKey(productDocId);
  if (normalized) keySet.add(normalized);
  const entries = Array.isArray(bin && bin.products) ? bin.products : [];
  return entries
    .filter((p) => binEntryMatchesKeySet(p, keySet))
    .reduce((sum, p) => sum + (Number(p.quantity) || 0), 0);
}

/**
 * Bucht EINE Zaehlposition: kompensierendes Ereignis, das den Bestand auf den
 * Zaehlwert bringt.
 *
 * - `inventory.quantitySource === 'ledger'`: NIE per direktem
 *   `inventory.quantity`-Write korrigieren (der naechste Refresh ueberschreibt
 *   das still). Dort laeuft ein idempotentes `adjust`-Event ueber
 *   lib/stock-ledger-correction.js, danach projiziert refreshProductInventory
 *   aus dem Ledger.
 * - sonst (Bin-Projektion): bookStockIn / bookStockOut aus lib/warehouse.js —
 *   der einzige legitime Schreiber von `inventory.quantity` (CLAUDE.md Punkt 13).
 *   Diese Route schreibt `inventory.quantity` NIE selbst.
 *
 * Danach: `stock:changed` + inventory_ledger via notifyStockChange und
 * Marktplatz-Push. Eine SENKUNG ist der Oversell-relevante Fall → der Push
 * wird abgewartet; Fehler landen im Dispatcher in `stock_operation_failures`
 * und werden vom Drain aufgegriffen (nie destruktiv, CLAUDE.md Punkt 14).
 */
async function bookInventoryPosition({ tenantId, inventoryId, position, actor }) {
  const binCode = String((position && position.binCode) || '').trim().toUpperCase();
  // FAIL-CLOSED bei der Zaehlmenge (Abnahme-Befund 2026-07-30): `Number('')` ist 0 und
  // haette als "gezaehlt: 0" eine VOLLSTAENDIGE Ausbuchung der Position ausgeloest —
  // bei vielen Positionen ein Massen-Listing-Ende. Die Oberflaeche filtert Leereingaben
  // heute, aber ein Skript, ein curl oder eine UI-Aenderung oeffnet den Pfad sofort.
  // Deshalb wird der ROHWERT geprueft, nicht das Ergebnis von Number().
  const rawCounted = position ? position.countedQty : undefined;
  const countedQty = Number(rawCounted);
  if (!binCode) return { status: 'error', message: 'Zaehlposition ohne binCode' };
  const istEchteZahl =
    (typeof rawCounted === 'number' && Number.isFinite(rawCounted))
    || (typeof rawCounted === 'string' && rawCounted.trim() !== '' && Number.isFinite(Number(rawCounted)));
  if (!istEchteZahl || !Number.isInteger(countedQty) || countedQty < 0) {
    return { status: 'error', message: `Ungueltige gezaehlte Menge (${JSON.stringify(rawCounted)})` };
  }

  const { ref: productRef, data: productData } = await resolveInventoryPositionProduct(position);
  const productDocId = productRef.id;

  const bin = await getBinByCode(binCode);
  if (!bin) return { status: 'error', message: `BIN ${binCode} nicht gefunden` };

  const currentQty = currentBinQuantity(bin, productData, productDocId);
  const systemQty = Number((position && position.systemQty) || 0);
  if (currentQty !== systemQty) {
    console.warn(
      `[inventory-complete] ${inventoryId} ${binCode}/${productDocId}: BIN-Menge hat sich seit Zaehlbeginn ` +
      `geaendert (Zaehlvorgabe=${systemQty}, aktuell=${currentQty}) — korrigiert wird auf den Zaehlwert ${countedQty}`
    );
  }
  const delta = countedQty - currentQty;
  if (delta === 0) return { status: 'noop', delta: 0, productId: productDocId, binCode };

  const quantityBefore = Number(productData && productData.inventory && productData.inventory.quantity);
  const ledgerSourced = String((productData && productData.inventory && productData.inventory.quantitySource) || '') === 'ledger';
  const skuValue =
    (productData && productData.identification && productData.identification.sku) ||
    (productData && productData.details && productData.details.identifiers && productData.details.identifiers.sku) ||
    (position && position.sku) ||
    null;

  let via = null;
  let syncProduct = null;

  if (ledgerSourced) {
    const { applyLedgerCorrection } = require('../lib/stock-ledger-correction');
    const applied = await applyLedgerCorrection(
      {
        tenantId,
        productId: productDocId,
        adjustDelta: delta,
        // Deterministischer Key → ein zweiter Lauf bucht NICHT doppelt.
        idempotencyKey: `adjust:inventory:${inventoryId}:${binCode}:${productDocId}`,
        sku: skuValue,
      },
      { firestore }
    );
    via = applied && applied.applied ? 'ledger-adjust' : `ledger-adjust-${(applied && applied.reason) || 'skipped'}`;
    await refreshProductInventory(productDocId);
    syncProduct = await getProduct(productDocId);
  } else if (delta > 0) {
    const result = await bookStockIn({
      productId: productDocId,
      binCode,
      quantity: delta,
      meta: {
        source: 'inventory',
        action: 'inventory-correction',
        tenantId,
        inventoryId,
        // Deterministische Request-Id → der Eingang ist auch bei Retry idempotent.
        requestId: `inventory:${inventoryId}:${binCode}:${productDocId}`,
        ...(actor ? { actor } : {}),
      },
    });
    via = result && result.deduped ? 'stock-in-deduped' : 'stock-in';
    syncProduct = result && result.product;
  } else {
    const result = await bookStockOut({
      productId: productDocId,
      binCode,
      quantity: -delta,
      meta: {
        source: 'inventory',
        action: 'inventory-correction',
        tenantId,
        inventoryId,
        ...(actor ? { actor } : {}),
      },
    });
    via = 'stock-out';
    syncProduct = result && result.product;
  }

  const quantityAfter = Number(syncProduct && syncProduct.inventory && syncProduct.inventory.quantity);
  if (Number.isFinite(quantityBefore) && Number.isFinite(quantityAfter) && quantityBefore !== quantityAfter) {
    try {
      const { notifyStockChange } = require('../lib/stock-change-events');
      await notifyStockChange({
        tenantId,
        productId: productDocId,
        sku: skuValue,
        before: quantityBefore,
        after: quantityAfter,
        reason: `inventory-complete:${inventoryId}`,
        source: 'routes/warehouse.inventories.complete',
        actor,
      });
    } catch (err) {
      console.warn(`[inventory-complete] notifyStockChange failed productId=${productDocId}: ${err.message}`);
    }
  }

  if (syncProduct) {
    const { syncStockWithRetry } = require('../services/stock-sync-dispatcher');
    const dispatch = () =>
      syncStockWithRetry({ tenantId, product: syncProduct, reason: 'inventory-correction' });
    if (delta < 0) {
      // Bestand SINKT → muss zuverlaessig bei eBay/Kaufland ankommen.
      await dispatch().catch((err) =>
        console.warn(`[inventory-complete] stock-sync dispatch failed productId=${productDocId}: ${err?.message || err}`)
      );
    } else {
      dispatch().catch((err) =>
        console.warn(`[inventory-complete] stock-sync dispatch failed productId=${productDocId}: ${err?.message || err}`)
      );
    }
  }

  return {
    status: 'booked',
    via,
    delta,
    productId: productDocId,
    binCode,
    countedQty,
    quantityBefore: Number.isFinite(quantityBefore) ? quantityBefore : null,
    quantityAfter: Number.isFinite(quantityAfter) ? quantityAfter : null,
  };
}

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

    // ── Buchung der Abweichungen (Flag) ─────────────────────────────────
    const booksEnabled = inventoryCompleteBooksEnabled();
    const bookings = [];
    const bookingErrors = [];
    if (booksEnabled) {
      const tenantId = getWarehouseTenantId(req);
      const actor = req.user?.uid ? { uid: req.user.uid, email: req.user.email || null } : null;
      const nowIso = new Date().toISOString();
      for (const position of counts) {
        if (!position || position.countedQty === null || position.countedQty === undefined) continue;
        const variance = Number(position.countedQty) - Number(position.systemQty || 0);
        if (!Number.isFinite(variance) || variance === 0) continue;
        // Idempotenz je Position: ein abgebrochener Lauf wird beim naechsten
        // `complete` fortgesetzt, bereits gebuchte Positionen bleiben unberuehrt.
        if (position.bookedAt) {
          bookings.push({ binCode: position.binCode, productId: position.productId, status: 'already-booked' });
          continue;
        }
        try {
          const result = await bookInventoryPosition({ tenantId, inventoryId: req.params.id, position, actor });
          if (result.status === 'error') {
            position.bookError = result.message;
            position.bookErrorAt = nowIso;
            bookingErrors.push({ binCode: position.binCode, productId: position.productId, message: result.message });
            console.error(`[inventory-complete] ${req.params.id} position failed: ${result.message}`);
            continue;
          }
          position.bookedAt = nowIso;
          position.bookedDelta = result.delta || 0;
          position.bookedVia = result.via || result.status;
          position.bookedBy = actor?.uid || null;
          position.bookError = null;
          bookings.push({
            binCode: result.binCode || position.binCode,
            productId: result.productId,
            status: result.status,
            via: result.via || null,
            delta: result.delta || 0,
            quantityBefore: result.quantityBefore ?? null,
            quantityAfter: result.quantityAfter ?? null,
          });
        } catch (err) {
          position.bookError = err.message;
          position.bookErrorAt = nowIso;
          bookingErrors.push({ binCode: position.binCode, productId: position.productId, message: err.message });
          console.error(`[inventory-complete] ${req.params.id} booking failed for ${position.binCode}/${position.productId}: ${err.message}`);
        }
      }
    }

    // Bei Buchungsfehlern bleibt die Inventur OFFEN — `complete` kann gefahrlos
    // wiederholt werden (Positions-Marker verhindern Doppelbuchung).
    const finalize = bookingErrors.length === 0;
    const update = {
      summary: {
        totalItems: counts.length,
        countedItems,
        totalVariance,
        completionPct: 100,
      },
    };
    if (booksEnabled) {
      update.counts = counts;
      update.stockBookedAt = finalize ? new Date().toISOString() : null;
    }
    if (finalize) {
      update.status = 'completed';
      update.completedAt = new Date().toISOString();
    }
    await docRef.update(update);

    res.json({
      ok: true,
      variances,
      totalVariance,
      booked: booksEnabled,
      status: finalize ? 'completed' : 'active',
      ...(booksEnabled ? { bookings, bookingErrors } : {}),
    });
  } catch (err) {
    console.error(`[POST /api/warehouse/inventories/:id/complete] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

module.exports = { router };
