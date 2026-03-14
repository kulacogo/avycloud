'use strict';

/**
 * invoice-engine.js — Invoice & Delivery Note PDF generation.
 *
 * Generates professional PDF invoices and delivery notes from order data
 * using pdfkit. Stores PDFs in GCS and records in Firestore.
 */

const PDFDocument = require('pdfkit');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { Storage } = require('@google-cloud/storage');
const { getNextNumber } = require('./number-sequence');

const INVOICES_COLLECTION = 'invoices';
const ORDERS_COLLECTION = 'orders';
const GCS_BUCKET = process.env.GCS_BUCKET || 'prodsandjobs';

let _db;
function getDb() {
  if (!_db) _db = new Firestore();
  return _db;
}

let _storage;
function getStorage() {
  if (!_storage) _storage = new Storage();
  return _storage;
}

/**
 * Default company info (overridden by company_settings in Firestore).
 */
const DEFAULT_COMPANY = {
  name: '',
  street: '',
  zip: '',
  city: '',
  country: 'Deutschland',
  phone: '',
  email: '',
  taxId: '',
  vatId: '',
  bankName: '',
  iban: '',
  bic: '',
};

/**
 * Load company settings for a tenant.
 * @param {string} tenantId
 * @returns {Promise<object>}
 */
async function getCompanySettings(tenantId) {
  try {
    const snap = await getDb().collection('company_settings').doc(tenantId).get();
    if (snap.exists) return { ...DEFAULT_COMPANY, ...snap.data() };
  } catch {
    // Fall through to default
  }
  return { ...DEFAULT_COMPANY };
}

/**
 * Generate an invoice for an order.
 *
 * @param {{
 *   orderId: string,
 *   tenantId?: string,
 *   actor?: { uid: string, email: string },
 *   paymentTermDays?: number,
 * }} opts
 * @returns {Promise<{ invoiceId: string, invoiceNumber: string, pdfUrl: string | null }>}
 */
async function generateInvoice({
  orderId,
  tenantId = 'default',
  actor = null,
  paymentTermDays = 14,
}) {
  const db = getDb();

  // Load order
  const orderSnap = await db.collection(ORDERS_COLLECTION).doc(orderId).get();
  if (!orderSnap.exists) throw new Error('Auftrag nicht gefunden');
  const order = { id: orderSnap.id, ...orderSnap.data() };

  // Idempotency: skip if order already has an invoice
  if (order.invoiceId) {
    return { invoiceId: order.invoiceId, invoiceNumber: order.invoiceNumber || null, pdfUrl: order.pdfUrl || null };
  }

  // Generate invoice number
  const seq = await getNextNumber({ tenantId, type: 'invoice' });

  // Load company settings
  const company = await getCompanySettings(tenantId);

  // Calculate amounts
  const items = order.items || [];
  const totalBrutto = order.totalAmount || items.reduce((sum, item) => sum + (item.priceBrutto || 0) * (item.quantity || 1), 0);
  const vatRate = order.vatRate ?? 0.19;
  const totalNetto = Math.round((totalBrutto / (1 + vatRate)) * 100) / 100;
  const vatAmount = Math.round((totalBrutto - totalNetto) * 100) / 100;

  const invoiceDate = new Date().toISOString().split('T')[0];
  const dueDate = new Date(Date.now() + paymentTermDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  // Generate PDF
  const pdfBuffer = await buildInvoicePdf({
    type: 'invoice',
    number: seq.formatted,
    date: invoiceDate,
    dueDate,
    company,
    customer: order.customer || {},
    items,
    totalNetto,
    vatRate,
    vatAmount,
    totalBrutto,
    orderNumber: order.orderId || order.number || orderId,
  });

  // Upload to GCS
  let pdfUrl = null;
  try {
    const filePath = `${tenantId}/invoices/${seq.formatted}.pdf`;
    const bucket = getStorage().bucket(GCS_BUCKET);
    const file = bucket.file(filePath);
    await file.save(pdfBuffer, { contentType: 'application/pdf', resumable: false });
    pdfUrl = `gs://${GCS_BUCKET}/${filePath}`;
  } catch (err) {
    console.error(`[invoice-engine] GCS upload failed: ${err.message}`);
  }

  // Save invoice record
  const invoiceDoc = {
    tenantId,
    invoiceNumber: seq.formatted,
    orderId,
    orderNumber: order.orderId || order.number || null,
    customer: order.customer || null,
    amountNetto: totalNetto,
    amountBrutto: totalBrutto,
    vatRate,
    vatAmount,
    currency: order.currency || 'EUR',
    status: 'erstellt',
    date: invoiceDate,
    dueDate,
    pdfUrl,
    createdAt: new Date().toISOString(),
    createdBy: actor?.uid || null,
  };

  const ref = await db.collection(INVOICES_COLLECTION).add(invoiceDoc);

  // Link invoice to order
  await orderSnap.ref.set({
    invoiceId: ref.id,
    invoiceNumber: seq.formatted,
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  return {
    invoiceId: ref.id,
    invoiceNumber: seq.formatted,
    pdfUrl,
  };
}

/**
 * Generate a delivery note for an order.
 *
 * @param {{ orderId: string, tenantId?: string }} opts
 * @returns {Promise<{ deliveryNoteNumber: string, pdfUrl: string | null }>}
 */
async function generateDeliveryNote({ orderId, tenantId = 'default' }) {
  const db = getDb();

  const orderSnap = await db.collection(ORDERS_COLLECTION).doc(orderId).get();
  if (!orderSnap.exists) throw new Error('Auftrag nicht gefunden');
  const order = { id: orderSnap.id, ...orderSnap.data() };

  const seq = await getNextNumber({ tenantId, type: 'delivery_note' });
  const company = await getCompanySettings(tenantId);

  const pdfBuffer = await buildInvoicePdf({
    type: 'delivery_note',
    number: seq.formatted,
    date: new Date().toISOString().split('T')[0],
    company,
    customer: order.customer || {},
    items: order.items || [],
    orderNumber: order.orderId || order.number || orderId,
  });

  let pdfUrl = null;
  try {
    const filePath = `${tenantId}/delivery-notes/${seq.formatted}.pdf`;
    const bucket = getStorage().bucket(GCS_BUCKET);
    const file = bucket.file(filePath);
    await file.save(pdfBuffer, { contentType: 'application/pdf', resumable: false });
    pdfUrl = `gs://${GCS_BUCKET}/${filePath}`;
  } catch (err) {
    console.error(`[invoice-engine] GCS upload failed: ${err.message}`);
  }

  // Link to order
  await orderSnap.ref.set({
    deliveryNoteNumber: seq.formatted,
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  return { deliveryNoteNumber: seq.formatted, pdfUrl };
}

/**
 * Build a PDF document (invoice or delivery note).
 *
 * @param {object} data
 * @returns {Promise<Buffer>}
 */
function buildInvoicePdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const isInvoice = data.type === 'invoice';
      const title = isInvoice ? 'Rechnung' : 'Lieferschein';

      // ── Header ──
      doc.fontSize(10).fillColor('#666');
      if (data.company.name) {
        doc.text(data.company.name, 50, 50, { align: 'left' });
        const addressParts = [data.company.street, `${data.company.zip} ${data.company.city}`.trim(), data.company.country].filter(Boolean);
        doc.text(addressParts.join(' · '), 50, 63, { align: 'left' });
      }

      // ── Recipient ──
      doc.fontSize(10).fillColor('#333');
      const customer = data.customer;
      const recipientLines = [
        customer.name || 'Unbekannt',
        customer.street,
        `${customer.zip || ''} ${customer.city || ''}`.trim(),
        customer.country && customer.country !== 'DE' ? customer.country : null,
      ].filter(Boolean);

      let y = 120;
      for (const line of recipientLines) {
        doc.text(line, 50, y);
        y += 14;
      }

      // ── Document title & meta ──
      y = 120;
      doc.fontSize(18).fillColor('#000').text(title, 350, y, { align: 'right' });
      y += 30;
      doc.fontSize(9).fillColor('#666');
      doc.text(`${title}-Nr.: ${data.number}`, 350, y, { align: 'right' });
      y += 13;
      doc.text(`Datum: ${formatDate(data.date)}`, 350, y, { align: 'right' });
      y += 13;
      if (data.orderNumber) {
        doc.text(`Auftrags-Nr.: ${data.orderNumber}`, 350, y, { align: 'right' });
        y += 13;
      }
      if (isInvoice && data.dueDate) {
        doc.text(`Fällig am: ${formatDate(data.dueDate)}`, 350, y, { align: 'right' });
        y += 13;
      }

      // ── Items Table ──
      y = Math.max(y, 230) + 20;

      // Table header
      doc.fontSize(8).fillColor('#999');
      doc.text('Pos', 50, y);
      doc.text('Beschreibung', 80, y);
      doc.text('Menge', 330, y, { width: 40, align: 'right' });
      if (isInvoice) {
        doc.text('Einzelpreis', 380, y, { width: 70, align: 'right' });
        doc.text('Gesamt', 460, y, { width: 80, align: 'right' });
      }
      y += 15;

      // Divider
      doc.moveTo(50, y).lineTo(545, y).strokeColor('#ddd').stroke();
      y += 8;

      // Items
      doc.fontSize(9).fillColor('#333');
      const items = data.items || [];
      items.forEach((item, idx) => {
        if (y > 720) {
          doc.addPage();
          y = 50;
        }

        const qty = item.quantity || 1;
        const price = item.priceBrutto || 0;
        const lineTotal = price * qty;

        doc.text(String(idx + 1), 50, y, { width: 25 });

        const nameLines = [];
        nameLines.push(item.name || 'Artikel');
        if (item.sku) nameLines.push(`SKU: ${item.sku}`);
        if (item.ean) nameLines.push(`EAN: ${item.ean}`);

        doc.text(nameLines[0], 80, y, { width: 240 });
        if (nameLines.length > 1) {
          doc.fontSize(7).fillColor('#999');
          doc.text(nameLines.slice(1).join(' · '), 80, y + 12, { width: 240 });
          doc.fontSize(9).fillColor('#333');
        }

        doc.text(String(qty), 330, y, { width: 40, align: 'right' });
        if (isInvoice) {
          doc.text(`${price.toFixed(2)} €`, 380, y, { width: 70, align: 'right' });
          doc.text(`${lineTotal.toFixed(2)} €`, 460, y, { width: 80, align: 'right' });
        }

        y += nameLines.length > 1 ? 28 : 18;
      });

      // ── Totals (invoice only) ──
      if (isInvoice) {
        y += 10;
        doc.moveTo(350, y).lineTo(545, y).strokeColor('#ddd').stroke();
        y += 10;

        doc.fontSize(9).fillColor('#666');
        doc.text('Nettobetrag:', 350, y, { width: 100, align: 'right' });
        doc.text(`${(data.totalNetto || 0).toFixed(2)} €`, 460, y, { width: 80, align: 'right' });
        y += 15;

        doc.text(`MwSt. ${Math.round((data.vatRate || 0.19) * 100)}%:`, 350, y, { width: 100, align: 'right' });
        doc.text(`${(data.vatAmount || 0).toFixed(2)} €`, 460, y, { width: 80, align: 'right' });
        y += 15;

        doc.fontSize(11).fillColor('#000');
        doc.text('Gesamtbetrag:', 350, y, { width: 100, align: 'right' });
        doc.text(`${(data.totalBrutto || 0).toFixed(2)} €`, 460, y, { width: 80, align: 'right' });
        y += 25;
      }

      // ── Footer / Payment info (invoice only) ──
      if (isInvoice && (data.company.iban || data.company.taxId)) {
        y = Math.max(y, 600);
        doc.fontSize(8).fillColor('#999');
        doc.moveTo(50, y).lineTo(545, y).strokeColor('#eee').stroke();
        y += 10;

        const footerParts = [];
        if (data.company.taxId) footerParts.push(`St.-Nr.: ${data.company.taxId}`);
        if (data.company.vatId) footerParts.push(`USt-IdNr.: ${data.company.vatId}`);
        if (data.company.iban) footerParts.push(`IBAN: ${data.company.iban}`);
        if (data.company.bic) footerParts.push(`BIC: ${data.company.bic}`);
        if (data.company.bankName) footerParts.push(`Bank: ${data.company.bankName}`);

        doc.text(footerParts.join('  ·  '), 50, y, { align: 'center', width: 495 });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Export an invoice to SevDesk.
 *
 * @param {{ invoiceId: string }} opts
 * @returns {Promise<{ ok: boolean, sevdeskId?: string, error?: string }>}
 */
async function exportToSevDesk({ invoiceId }) {
  try {
    const snap = await getDb().collection(INVOICES_COLLECTION).doc(invoiceId).get();
    if (!snap.exists) throw new Error('Rechnung nicht gefunden');
    const invoice = snap.data();

    const { getSecretValue } = require('../lib/secret-values');
    const token = await getSecretValue('SEVDESK_API_TOKEN');
    if (!token) throw new Error('SevDesk API Token not configured');

    // Create invoice in SevDesk
    const res = await fetch('https://my.sevdesk.de/api/v1/Invoice', {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        invoice: {
          objectName: 'Invoice',
          invoiceNumber: invoice.invoiceNumber,
          invoiceDate: invoice.date,
          deliveryDate: invoice.date,
          status: 100, // Draft
          taxRate: Math.round((invoice.vatRate || 0.19) * 100),
          sumNet: String(invoice.amountNetto || 0),
          sumGross: String(invoice.amountBrutto || 0),
          currency: invoice.currency || 'EUR',
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`SevDesk ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const sevdeskId = data?.objects?.id || null;

    // Update invoice with SevDesk ID
    await snap.ref.set({
      sevdeskId,
      sevdeskExportedAt: new Date().toISOString(),
    }, { merge: true });

    return { ok: true, sevdeskId };
  } catch (err) {
    console.error(`[invoice-engine] SevDesk export failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Format date string to German format.
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string}
 */
function formatDate(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

module.exports = {
  generateInvoice,
  generateDeliveryNote,
  exportToSevDesk,
  getCompanySettings,
  buildInvoicePdf,
};
