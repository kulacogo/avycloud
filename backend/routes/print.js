/**
 * Druckwege — Etiketten gehen IMMER ueber AvyCloud an den richtigen Drucker.
 *
 * Der Bediener soll nie wieder Androids Teilen-/Druckauswahl sehen und nie
 * wieder den Drucker selbst raten. Weil Cloud Run keine LAN-Adresse erreicht,
 * laeuft das ueber eine Warteschlange: AvyCloud legt den Auftrag ab, der
 * Druck-Agent im Buero (`tools/print-agent/`) holt ihn und druckt.
 *
 * Endpunkte:
 *   POST /api/print/jobs               — Auftrag einreihen (Oberflaeche)
 *   GET  /api/print/status             — lebt ein Agent? (entscheidet ueber Rueckfallweg)
 *   POST /api/print/agent/heartbeat    — Agent meldet sich
 *   POST /api/print/agent/claim        — Agent holt den naechsten Auftrag
 *   GET  /api/print/jobs/:id/document  — Agent laedt das fertig skalierte PDF
 *   POST /api/print/jobs/:id/result    — Agent meldet Erfolg/Fehler
 */

const express = require('express');
const router = express.Router();
const { firestore } = require('../lib/firestore');
const { requirePermission } = require('../lib/rbac');
const {
  PRINT_JOBS_COLLECTION,
  PRINT_AGENTS_COLLECTION,
  JOB_STATUS,
  buildPrintJob,
  isAgentOnline,
  isClaimable,
  shouldRetry,
  computeRetryDelayMs,
  printQueueEnabled,
} = require('../lib/print-queue');
const { resolveLabelFormat, labelExactSizeEnabled } = require('../lib/label-format');
const { resizeLabelPdfSafe } = require('../lib/label-pdf-resize');

function getTenantId(req) {
  return req.user?.tenantId || 'default';
}

/**
 * Sendung eines Auftrags bestimmen — PRIMAER-Sendung, sonst die neueste
 * Nicht-Zusatz-Sendung. Gleiche Regel wie beim Label-Proxy: nach einem
 * Zusatz-Label darf der Haupt-Druckknopf nicht still das Zusatz-Etikett
 * erwischen (Review-Befund 2026-08-21).
 */
async function resolveShipment({ orderId, shipmentId }) {
  if (shipmentId) {
    const snap = await firestore.collection('shipments').doc(shipmentId).get();
    if (!snap.exists || snap.data().orderId !== orderId) return null;
    return { id: snap.id, ...snap.data() };
  }

  const orderSnap = await firestore.collection('orders').doc(orderId).get();
  const primary = orderSnap.exists ? String(orderSnap.data().shipmentId || '') : '';
  if (primary) {
    const primSnap = await firestore.collection('shipments').doc(primary).get();
    if (primSnap.exists && primSnap.data().orderId === orderId) {
      return { id: primSnap.id, ...primSnap.data() };
    }
  }

  const snap = await firestore.collection('shipments')
    .where('orderId', '==', orderId)
    .orderBy('createdAt', 'desc')
    .limit(5)
    .get();
  if (snap.empty) return null;
  const best = snap.docs.find((d) => d.data().additionalLabel !== true) || snap.docs[0];
  return { id: best.id, ...best.data() };
}

/* ── Oberflaeche ──────────────────────────────────────────────────────── */

/**
 * GET /api/print/status — lebt ein Druck-Agent?
 *
 * Die Oberflaeche faellt bei `online:false` bewusst auf den alten Teilen-Weg
 * zurueck. Einen Auftrag bei totem Agenten einzureihen waere schlimmer als die
 * Android-Auswahl: das Paket bliebe unfrankiert liegen, ohne dass es jemand
 * merkt.
 */
router.get('/print/status', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!printQueueEnabled()) {
      return res.json({ ok: true, data: { enabled: false, online: false, agents: [] } });
    }

    const snap = await firestore.collection(PRINT_AGENTS_COLLECTION)
      .where('tenantId', '==', tenantId)
      .limit(20)
      .get();

    const now = Date.now();
    const agents = snap.docs.map((d) => {
      const a = d.data();
      return {
        agentId: d.id,
        lastSeenAt: a.lastSeenAt || null,
        online: isAgentOnline(a.lastSeenAt, now),
        printers: a.printers || {},
      };
    });

    res.json({
      ok: true,
      data: {
        enabled: true,
        online: agents.some((a) => a.online),
        agents,
      },
    });
  } catch (err) {
    console.error(`[GET /api/print/status] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/print/jobs — Versandetikett in die Druckwarteschlange legen.
 * Body: { orderId, shipmentId?, copies? }
 */
router.post('/print/jobs', requirePermission('orders', 'write'), async (req, res) => {
  try {
    if (!printQueueEnabled()) {
      return res.status(503).json({
        ok: false,
        error: { code: 'PRINT_QUEUE_OFF', message: 'Druckwarteschlange ist abgeschaltet.' },
      });
    }

    const tenantId = getTenantId(req);
    const { orderId, shipmentId = null, copies = 1 } = req.body || {};
    if (!orderId) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: 'orderId erforderlich' } });
    }

    const shipment = await resolveShipment({ orderId, shipmentId });
    if (!shipment) {
      return res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Kein Versandlabel fuer diesen Auftrag gefunden.' },
      });
    }

    const format = resolveLabelFormat({
      shippingOptionCode: shipment.shippingOptionCode,
      carrier: shipment.carrier,
    });
    if (!format) {
      // Ohne bekanntes Format waere die Druckerwahl geraten. Lieber ehrlich
      // ablehnen und den Bediener den alten Weg gehen lassen, als das Etikett
      // auf der falschen Rolle abzuschneiden.
      return res.status(422).json({
        ok: false,
        error: {
          code: 'UNKNOWN_LABEL_FORMAT',
          message: `Druckerformat fuer Transporteur "${shipment.carrier || 'unbekannt'}" nicht bekannt — bitte manuell drucken.`,
        },
      });
    }

    const job = buildPrintJob({
      tenantId,
      orderId,
      shipmentId: shipment.id,
      formatKey: format.key,
      printerRole: format.printerRole,
      widthMm: format.widthMm,
      heightMm: format.heightMm,
      copies,
      createdBy: req.user?.email || req.user?.uid || null,
    });

    const ref = await firestore.collection(PRINT_JOBS_COLLECTION).add(job);
    res.json({ ok: true, data: { jobId: ref.id, ...job } });
  } catch (err) {
    console.error(`[POST /api/print/jobs] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * GET /api/print/jobs/:jobId — Zustand eines Auftrags (die Oberflaeche wartet
 * darauf, damit sie „gedruckt" erst meldet, wenn es wirklich gedruckt ist).
 */
router.get('/print/jobs/:jobId', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const snap = await firestore.collection(PRINT_JOBS_COLLECTION).doc(req.params.jobId).get();
    if (!snap.exists || snap.data().tenantId !== getTenantId(req)) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Druckauftrag nicht gefunden.' } });
    }
    res.json({ ok: true, data: { jobId: snap.id, ...snap.data() } });
  } catch (err) {
    console.error(`[GET /api/print/jobs/:jobId] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/* ── Druck-Agent ──────────────────────────────────────────────────────── */

/**
 * POST /api/print/agent/heartbeat — der Agent meldet sich am Leben.
 * Body: { agentId, printers?: { parcel: string, letter: string } }
 */
router.post('/print/agent/heartbeat', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const { agentId, printers = {} } = req.body || {};
    if (!agentId) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: 'agentId erforderlich' } });
    }
    await firestore.collection(PRINT_AGENTS_COLLECTION).doc(String(agentId)).set({
      tenantId,
      agentId: String(agentId),
      printers,
      lastSeenAt: new Date().toISOString(),
    }, { merge: true });
    res.json({ ok: true, data: { agentId } });
  } catch (err) {
    console.error(`[POST /api/print/agent/heartbeat] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/print/agent/claim — naechsten Auftrag zuweisen.
 *
 * Die Zuweisung laeuft in einer Firestore-Transaktion: zwei Agenten (oder
 * derselbe Agent zweimal) duerfen denselben Auftrag nicht bekommen, sonst
 * kommt das Etikett doppelt aus dem Drucker.
 */
router.post('/print/agent/claim', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const agentId = String(req.body?.agentId || '').trim();
    if (!agentId) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: 'agentId erforderlich' } });
    }

    const snap = await firestore.collection(PRINT_JOBS_COLLECTION)
      .where('tenantId', '==', tenantId)
      .where('status', 'in', [JOB_STATUS.QUEUED, JOB_STATUS.CLAIMED])
      .orderBy('createdAt', 'asc')
      .limit(10)
      .get();

    const now = Date.now();
    const candidate = snap.docs.find((d) => isClaimable(d.data(), now));
    if (!candidate) return res.json({ ok: true, data: { job: null } });

    const nowIso = new Date().toISOString();
    const claimed = await firestore.runTransaction(async (tx) => {
      const ref = firestore.collection(PRINT_JOBS_COLLECTION).doc(candidate.id);
      const fresh = await tx.get(ref);
      if (!fresh.exists) return null;
      const job = fresh.data();
      // Erneut pruefen — zwischen Abfrage und Transaktion kann ein anderer
      // Agent zugegriffen haben.
      if (!isClaimable(job, Date.now())) return null;
      tx.update(ref, {
        status: JOB_STATUS.CLAIMED,
        claimedAt: nowIso,
        claimedBy: agentId,
        attempts: (Number(job.attempts) || 0) + 1,
      });
      return { jobId: ref.id, ...job, status: JOB_STATUS.CLAIMED, claimedAt: nowIso, claimedBy: agentId };
    });

    res.json({ ok: true, data: { job: claimed } });
  } catch (err) {
    console.error(`[POST /api/print/agent/claim] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * GET /api/print/jobs/:jobId/document — fertig skaliertes Etikett-PDF.
 *
 * Der Agent bekommt das PDF bereits im Zielmass; er muss nichts rechnen und
 * kann nichts anders skalieren. Die Rolle steht in den Kopfzeilen.
 */
router.get('/print/jobs/:jobId/document', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const jobSnap = await firestore.collection(PRINT_JOBS_COLLECTION).doc(req.params.jobId).get();
    if (!jobSnap.exists || jobSnap.data().tenantId !== tenantId) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Druckauftrag nicht gefunden.' } });
    }
    const job = jobSnap.data();

    const shipment = await resolveShipment({ orderId: job.orderId, shipmentId: job.shipmentId });
    if (!shipment?.sendcloudParcelId && !shipment?.labelUrl) {
      return res.status(404).json({ ok: false, error: { code: 'NO_LABEL', message: 'Kein Etikett zu dieser Sendung.' } });
    }

    const { downloadLabelPdf, getLabel } = require('../services/shipping-engine');
    let labelUrl = null;
    if (shipment.sendcloudParcelId) {
      const r = await getLabel({ parcelId: shipment.sendcloudParcelId, labelFormat: 'a6' });
      labelUrl = r.labelUrl;
    }
    if (!labelUrl) labelUrl = shipment.labelUrl;
    if (!labelUrl) {
      return res.status(404).json({ ok: false, error: { code: 'NO_LABEL', message: 'Kein Etikett von SendCloud verfuegbar.' } });
    }

    const { buffer, contentType } = await downloadLabelPdf(labelUrl);
    const format = labelExactSizeEnabled()
      ? resolveLabelFormat({ shippingOptionCode: shipment.shippingOptionCode, carrier: shipment.carrier })
      : null;
    const { buffer: outBuffer, resized } = await resizeLabelPdfSafe(buffer, format);

    res.set('X-Label-Printer-Role', job.printerRole || '');
    res.set('X-Label-Width-Mm', String(job.widthMm || ''));
    res.set('X-Label-Height-Mm', String(job.heightMm || ''));
    res.set('X-Label-Resized', resized ? '1' : '0');
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `inline; filename="label-${job.orderId}.pdf"`);
    res.send(outBuffer);
  } catch (err) {
    console.error(`[GET /api/print/jobs/:jobId/document] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/print/jobs/:jobId/result — Agent meldet das Ergebnis.
 * Body: { ok: boolean, error?: string }
 */
router.post('/print/jobs/:jobId/result', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const ref = firestore.collection(PRINT_JOBS_COLLECTION).doc(req.params.jobId);
    const snap = await ref.get();
    if (!snap.exists || snap.data().tenantId !== tenantId) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Druckauftrag nicht gefunden.' } });
    }

    const job = snap.data();
    const nowIso = new Date().toISOString();
    const success = req.body?.ok === true;

    if (success) {
      await ref.update({ status: JOB_STATUS.DONE, finishedAt: nowIso, error: null });
      return res.json({ ok: true, data: { status: JOB_STATUS.DONE } });
    }

    const message = String(req.body?.error || 'Druck fehlgeschlagen').slice(0, 500);
    if (shouldRetry(job)) {
      // Zurueck in die Warteschlange, aber nicht sofort — sonst dreht ein
      // defekter Drucker die Schleife mit voller Geschwindigkeit.
      await ref.update({
        status: JOB_STATUS.QUEUED,
        claimedAt: null,
        claimedBy: null,
        error: message,
        notBefore: new Date(Date.now() + computeRetryDelayMs(job.attempts)).toISOString(),
      });
      return res.json({ ok: true, data: { status: JOB_STATUS.QUEUED, retry: true } });
    }

    await ref.update({ status: JOB_STATUS.FAILED, finishedAt: nowIso, error: message });
    res.json({ ok: true, data: { status: JOB_STATUS.FAILED } });
  } catch (err) {
    console.error(`[POST /api/print/jobs/:jobId/result] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

module.exports = router;
