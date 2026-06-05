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
  logoUrl: '',
};

/**
 * Load company settings for a tenant.
 * Maps German Firestore field names to English for buildInvoicePdf().
 * @param {string} tenantId
 * @returns {Promise<object>}
 */
async function getCompanySettings(tenantId) {
  try {
    const snap = await getDb().collection('company_settings').doc(tenantId).get();
    if (snap.exists) {
      const d = snap.data();
      return {
        name: d.firmenname || d.name || DEFAULT_COMPANY.name,
        legalForm: d.rechtsform || '',
        street: d.strasse || d.street || DEFAULT_COMPANY.street,
        zip: d.plz || d.zip || DEFAULT_COMPANY.zip,
        city: d.ort || d.city || DEFAULT_COMPANY.city,
        country: d.land || d.country || DEFAULT_COMPANY.country,
        phone: d.telefon || d.phone || DEFAULT_COMPANY.phone,
        email: d.email || DEFAULT_COMPANY.email,
        website: d.website || '',
        taxId: d.steuernummer || d.taxId || DEFAULT_COMPANY.taxId,
        vatId: d.ustIdNr || d.vatId || DEFAULT_COMPANY.vatId,
        bankName: d.bank || d.bankName || DEFAULT_COMPANY.bankName,
        iban: d.iban || DEFAULT_COMPANY.iban,
        bic: d.bic || DEFAULT_COMPANY.bic,
        owner: d.inhaber || '',
        logoUrl: d.logoUrl || '',
      };
    }
  } catch {
    // Fall through to default
  }
  return { ...DEFAULT_COMPANY };
}

/**
 * Fetch logo image from GCS URL as Buffer for embedding in PDF.
 * Returns null if unavailable.
 */
async function fetchLogoBuffer(logoUrl) {
  if (!logoUrl) return null;
  try {
    // GCS signed URL or public URL
    const resp = await fetch(logoUrl, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf;
  } catch {
    return null;
  }
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
  const orderRef = db.collection(ORDERS_COLLECTION).doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new Error('Auftrag nicht gefunden');
  const order = { id: orderSnap.id, ...orderSnap.data() };

  // Idempotency + concurrency guard: atomically claim invoice generation for
  // this order. Several triggers can fire for one order (pick event, ship
  // transition, bulk cron, manual UI button) — without an atomic claim two of
  // them both read "no invoiceId yet" and each create an invoice + SevDesk
  // voucher. The plain `if (order.invoiceId)` check below was a TOCTOU race
  // because invoiceId is only written at the very end (after the slow SevDesk
  // round-trip). See Incident: doubled invoices (paid + draft, same number).
  const CLAIM_TTL_MS = 5 * 60 * 1000;
  const claim = await db.runTransaction(async (tx) => {
    const s = await tx.get(orderRef);
    const d = s.data() || {};
    if (d.invoiceId) {
      return { existing: { invoiceId: d.invoiceId, invoiceNumber: d.invoiceNumber || null, pdfUrl: d.pdfUrl || null } };
    }
    const claimedAt = d.invoiceClaimedAt ? Date.parse(d.invoiceClaimedAt) : 0;
    if (claimedAt && (Date.now() - claimedAt) < CLAIM_TTL_MS) {
      return { busy: true };
    }
    tx.set(orderRef, { invoiceClaimedAt: new Date().toISOString() }, { merge: true });
    return { claimed: true };
  });
  if (claim.existing) return claim.existing;
  if (claim.busy) {
    console.warn(`[invoice-engine] generateInvoice skipped — claim active for order ${orderId}`);
    return { invoiceId: null, invoiceNumber: null, pdfUrl: null, skipped: true };
  }

  // Load company settings + SevDesk token + logo
  const company = await getCompanySettings(tenantId);
  company._logoBuffer = await fetchLogoBuffer(company.logoUrl);
  const { getSecretValue } = require('../lib/secret-values');
  const token = await getSecretValue('SEVDESK_API_TOKEN').catch(() => null);

  // Calculate amounts — always derive from items
  const items = order.items || [];
  const shippingCost = order.shippingCost || 0;
  const itemsBrutto = items.reduce((sum, item) => sum + (item.priceBrutto || 0) * (item.quantity || 1), 0);
  const totalBrutto = Math.round((itemsBrutto > 0 ? itemsBrutto + shippingCost : (order.totalAmount || 0)) * 100) / 100;
  const vatRate = order.vatRate ?? 0.19;
  const totalNetto = Math.round((totalBrutto / (1 + vatRate)) * 100) / 100;
  const vatAmount = Math.round((totalBrutto - totalNetto) * 100) / 100;
  const vatFactor = 1 + vatRate;
  const taxRate = Math.round(vatRate * 100);

  // Add shipping as separate line item if present
  const invoiceItems = [...items];
  if (shippingCost > 0 && itemsBrutto > 0) {
    invoiceItems.push({ name: 'Versandkosten', priceBrutto: shippingCost, quantity: 1 });
  }

  const invoiceDate = new Date().toISOString().split('T')[0];
  const dueDate = new Date(Date.now() + paymentTermDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const marketplaceOrderRef = order.marketplaceOrderId || order.orderId || order.number || orderId;

  // Guard: never issue a 0 € or customer-less invoice. This is what produced
  // the 47 "eBay Käufer / 0,00 €" finalized invoices (real sales mis-booked as
  // zero). Defer instead — the order keeps no invoiceId and a later run with
  // proper amount/customer data will pick it up. See Incident: invoice cleanup.
  const customerName = (order.customer?.name || '').trim();
  if (totalBrutto <= 0 || !customerName) {
    await orderRef.set({ invoiceClaimedAt: null }, { merge: true }).catch(() => {});
    console.warn(`[invoice-engine] generateInvoice übersprungen — fehlender Betrag/Kunde (order ${orderId}, brutto=${totalBrutto}, kunde='${customerName}')`);
    return { invoiceId: null, invoiceNumber: null, pdfUrl: null, skipped: true, reason: 'no_amount_or_customer' };
  }

  // ── Create invoice in SevDesk first to get the official invoice number ──
  let invoiceNumber = null;
  let sevdeskId = null;

  if (token) {
    try {
      const userId = await getSevdeskUserId(token);
      const headers = { Authorization: token, 'Content-Type': 'application/json' };
      const cust = order.customer || {};
      const addressParts = [cust.name, cust.street, `${cust.zip || ''} ${cust.city || ''}`.trim() || null].filter(Boolean);

      const invoicePosSave = invoiceItems.map((item, i) => ({
        id: null,
        objectName: 'InvoicePos',
        mapAll: true,
        name: item.name || item.sku || 'Artikel',
        quantity: Number(item.quantity) || 1,
        price: Math.round((Number(item.priceBrutto || 0) / vatFactor) * 100) / 100,
        unity: { id: 1, objectName: 'Unity' },
        positionNumber: i + 1,
        taxRate,
      }));

      if (invoicePosSave.length === 0) {
        invoicePosSave.push({
          id: null, objectName: 'InvoicePos', mapAll: true,
          name: `Bestellung ${marketplaceOrderRef}`,
          quantity: 1, price: totalNetto,
          unity: { id: 1, objectName: 'Unity' },
          positionNumber: 1, taxRate,
        });
      }

      const sdPayload = {
        invoice: {
          id: null,
          objectName: 'Invoice',
          invoiceDate: toSevdeskDate(invoiceDate),
          deliveryDate: toSevdeskDate(invoiceDate),
          deliveryDateUntil: null,
          status: '100', // Draft — sendBy call below transitions to 200 and assigns number
          invoiceType: 'RE',
          taxRate,
          taxText: `Umsatzsteuer ${taxRate}%`,
          taxType: taxRate === 0 ? 'noteu' : 'default',
          currency: order.currency || 'EUR',
          discount: 0,
          smallSettlement: 0,
          address: addressParts.join('\n') || null,
          // Marketplace order number on the invoice — required for traceability
          // and as the join key for accounting reconciliation (it was missing,
          // which is why eBay/Kaufland sales could not be matched 1:1).
          headText: `Marktplatz-Bestellnummer: ${marketplaceOrderRef}`,
          ...(dueDate ? { payDate: toSevdeskDate(dueDate) } : {}),
          ...(userId ? { contactPerson: { id: userId, objectName: 'SevUser' } } : {}),
          mapAll: true,
        },
        invoicePosSave,
        invoicePosDelete: null,
        filename: null,
        discountSave: null,
      };

      const r = await fetch('https://my.sevdesk.de/api/v1/Invoice/Factory/saveInvoice', {
        method: 'POST', headers, body: JSON.stringify(sdPayload),
      });
      if (r.ok) {
        const data = await r.json();
        sevdeskId = data?.objects?.invoice?.id || null;
        // Finalize (sendBy VPDF) to transition from draft→open and trigger sequential number assignment
        if (sevdeskId) {
          const rSend = await fetch(`https://my.sevdesk.de/api/v1/Invoice/${sevdeskId}/sendBy`, {
            method: 'PUT', headers, body: JSON.stringify({ sendType: 'VPDF' }),
          });
          if (rSend.ok) {
            const sd = await rSend.json();
            invoiceNumber = sd?.objects?.invoiceNumber || null;
          }
        }
        console.log(`[invoice-engine] SevDesk invoice created: ${invoiceNumber} (ID ${sevdeskId})`);
      } else {
        const text = await r.text().catch(() => '');
        console.warn(`[invoice-engine] SevDesk invoice creation failed: ${r.status} ${text.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn(`[invoice-engine] SevDesk creation error (non-fatal): ${err.message}`);
    }
  }

  // SevDesk is the single source of truth for the invoice number. If it did not
  // assign one (API down / error), we DEFER instead of inventing a local number.
  // Previously a local "RE-2026-xxxx" was issued and later pushed to SevDesk,
  // creating the non-sequential numbers. Releasing the claim lets a later run
  // (next pick/ship trigger or the cron) retry once SevDesk is healthy again.
  if (!invoiceNumber) {
    await orderRef.set({ invoiceClaimedAt: null }, { merge: true }).catch(() => {});
    throw new Error(`SevDesk hat keine Rechnungsnummer vergeben (order ${orderId}) — Rechnung verschoben statt mit lokaler Ersatznummer ausgestellt.`);
  }

  // Generate PDF with the (SevDesk-assigned) invoice number
  const pdfBuffer = await buildInvoicePdf({
    type: 'invoice',
    number: invoiceNumber,
    date: invoiceDate,
    dueDate,
    company,
    customer: order.customer || {},
    items: invoiceItems,
    totalNetto,
    vatRate,
    vatAmount,
    totalBrutto,
    orderNumber: marketplaceOrderRef,
  });

  // Upload to GCS
  let pdfUrl = null;
  try {
    const filePath = `${tenantId}/invoices/${invoiceNumber}.pdf`;
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
    invoiceNumber,
    sevdeskId: sevdeskId || null,
    sevdeskExportedAt: sevdeskId ? new Date().toISOString() : null,
    orderId,
    orderNumber: marketplaceOrderRef,
    marketplaceOrderId: order.marketplaceOrderId || null,
    marketplace: order.marketplace || order.source || null,
    customer: order.customer || null,
    amountNetto: totalNetto,
    amountNet: totalNetto,
    amountBrutto: totalBrutto,
    amountGross: totalBrutto,
    vatRate,
    vatAmount,
    currency: order.currency || 'EUR',
    status: 'offen',
    date: invoiceDate,
    dueDate,
    pdfUrl,
    createdAt: new Date().toISOString(),
    createdBy: actor?.uid || null,
  };

  const ref = await db.collection(INVOICES_COLLECTION).add(invoiceDoc);

  // Link invoice to order and release the generation claim. invoiceId is now
  // the authoritative idempotency marker; if anything threw before this point
  // the claim simply expires after CLAIM_TTL_MS so a later retry can proceed.
  await orderRef.set({
    invoiceId: ref.id,
    invoiceNumber,
    invoiceClaimedAt: null,
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  return { invoiceId: ref.id, invoiceNumber, pdfUrl };
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
  company._logoBuffer = await fetchLogoBuffer(company.logoUrl);

  const pdfBuffer = await buildInvoicePdf({
    type: 'delivery_note',
    number: seq.formatted,
    date: new Date().toISOString().split('T')[0],
    company,
    customer: order.customer || {},
    items: order.items || [],
    orderNumber: order.marketplaceOrderId || order.orderId || order.number || orderId,
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
      const co = data.company;
      const PAGE_WIDTH = 595.28;
      const MARGIN = 50;
      const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

      // ── Header: logo top-left when available, else company name as text. ──
      // When a real logo image is present we do NOT also print the company name
      // + legal form on the right (that text block is only a fallback for
      // tenants without a logo). Avoids the redundant "TrendOcean /
      // einzelunternehmen" next to the logo.
      let logoRendered = false;
      if (co.logoUrl && co._logoBuffer) {
        try {
          doc.image(co._logoBuffer, MARGIN, 35, { width: 120, height: 50, fit: [120, 50] });
          logoRendered = true;
        } catch { /* logo rendering failed — fall back to the text header below */ }
      }
      if (!logoRendered && co.name) {
        doc.fontSize(20).fillColor('#1a1a2e').font('Helvetica-Bold');
        doc.text(co.name, MARGIN, 40, { align: 'right', width: CONTENT_WIDTH });
        if (co.legalForm) {
          doc.fontSize(8).fillColor('#999').font('Helvetica');
          doc.text(co.legalForm, MARGIN, 62, { align: 'right', width: CONTENT_WIDTH });
        }
      }

      // ── Absenderzeile (small, above recipient) ──
      const senderParts = [co.name, co.street, `${co.zip} ${co.city}`.trim()].filter(Boolean);
      if (senderParts.length > 0) {
        doc.fontSize(7).fillColor('#999').font('Helvetica');
        doc.text(senderParts.join(' \u00B7 '), MARGIN, 100);
        doc.moveTo(MARGIN, 112).lineTo(280, 112).strokeColor('#ccc').lineWidth(0.5).stroke();
      }

      // ── Recipient (left) ──
      doc.fontSize(10).fillColor('#333').font('Helvetica');
      const customer = data.customer;
      const recipientLines = [
        customer.name || 'Unbekannt',
        customer.street,
        `${customer.zip || ''} ${customer.city || ''}`.trim(),
        customer.country && customer.country !== 'DE' && customer.country !== 'Deutschland' ? customer.country : null,
      ].filter(Boolean);

      let y = 118;
      for (const line of recipientLines) {
        doc.text(line, MARGIN, y);
        y += 14;
      }

      // ── Invoice details (right block) ──
      const metaX = 350;
      const metaValX = 440;
      const metaW = MARGIN + CONTENT_WIDTH - metaValX;
      let my = 118;
      doc.fontSize(9).fillColor('#666').font('Helvetica');

      const metaRows = [
        [`${title}snummer:`, data.number],
        ['Rechnungsdatum:', formatDate(data.date)],
        ...(isInvoice && data.dueDate ? [['Lieferdatum:', formatDate(data.date)]] : []),
        ...(data.orderNumber ? [['Bestell-Nr.:', data.orderNumber]] : []),
        ...(isInvoice && data.dueDate ? [['Fällig am:', formatDate(data.dueDate)]] : []),
      ];
      for (const [label, val] of metaRows) {
        doc.font('Helvetica').text(label, metaX, my, { width: 85 });
        doc.font('Helvetica-Bold').fillColor('#333').text(val, metaValX, my, { width: metaW });
        doc.fillColor('#666').font('Helvetica');
        my += 15;
      }

      // ── Document title ──
      y = Math.max(y, my) + 20;
      doc.fontSize(16).fillColor('#1a1a2e').font('Helvetica-Bold');
      doc.text(title, MARGIN, y);
      y += 28;

      // ── Items Table ──
      // Table header background
      doc.rect(MARGIN, y - 2, CONTENT_WIDTH, 20).fill('#f0f0f5');
      doc.fontSize(8).fillColor('#555').font('Helvetica-Bold');
      doc.text('Pos.', MARGIN + 5, y + 3, { width: 25 });
      doc.text('Bezeichnung', MARGIN + 32, y + 3, { width: 195 });
      doc.text('Menge', 280, y + 3, { width: 40, align: 'right' });
      if (isInvoice) {
        doc.text('Einzelpreis', 325, y + 3, { width: 65, align: 'right' });
        doc.text('MwSt', 395, y + 3, { width: 35, align: 'right' });
        doc.text('Gesamt', 435, y + 3, { width: 80, align: 'right' });
      }
      y += 22;

      // Items
      doc.font('Helvetica').fillColor('#333');
      const items = data.items || [];
      const vatPct = Math.round((data.vatRate || 0.19) * 100);
      const NAME_W = 195; // Bezeichnung column width (ends before the Menge column at x=280)
      items.forEach((item, idx) => {
        const qty = item.quantity || 1;
        const price = item.priceBrutto || 0;
        const lineTotal = price * qty;

        const name = item.name || 'Artikel';
        const extra = [];
        if (item.sku) extra.push(`SKU: ${item.sku}`);
        if (item.ean) extra.push(`EAN: ${item.ean}`);
        const extraText = extra.join(' \u00B7 ');

        // Measure the real row height UP FRONT \u2014 long product names wrap to
        // multiple lines. The old code assumed a fixed height and drew the
        // SKU/EAN line at y+12, which overlapped the wrapped name. Now we size
        // the row to the actual content. (Fix: invoice position text overlap.)
        doc.font('Helvetica').fontSize(9);
        const nameH = doc.heightOfString(name, { width: NAME_W });
        let extraH = 0;
        if (extraText) {
          doc.fontSize(7);
          extraH = doc.heightOfString(extraText, { width: NAME_W }) + 1;
        }
        const rowH = Math.max(18, nameH + extraH + 6);

        // Page break using the real row height
        if (y + rowH > 700) {
          doc.addPage();
          y = 50;
        }

        // Alternating row background, sized to the real content
        if (idx % 2 === 1) {
          doc.rect(MARGIN, y - 3, CONTENT_WIDTH, rowH).fill('#fafafa');
        }

        doc.font('Helvetica').fontSize(9).fillColor('#333');
        doc.text(String(idx + 1), MARGIN + 5, y, { width: 25 });
        doc.text(name, MARGIN + 32, y, { width: NAME_W });
        if (extraText) {
          doc.fontSize(7).fillColor('#999');
          doc.text(extraText, MARGIN + 32, y + nameH + 1, { width: NAME_W });
          doc.fontSize(9).fillColor('#333');
        }

        doc.text(String(qty), 280, y, { width: 40, align: 'right' });
        if (isInvoice) {
          doc.text(fmtEur(price), 325, y, { width: 65, align: 'right' });
          doc.text(`${vatPct}%`, 395, y, { width: 35, align: 'right' });
          doc.text(fmtEur(lineTotal), 435, y, { width: 80, align: 'right' });
        }

        y += rowH;
      });

      // ── Totals (invoice only) ──
      if (isInvoice) {
        y += 8;
        doc.moveTo(330, y).lineTo(MARGIN + CONTENT_WIDTH, y).strokeColor('#ddd').lineWidth(0.5).stroke();
        y += 10;

        doc.fontSize(9).fillColor('#666').font('Helvetica');
        doc.text('Zwischensumme (Netto):', 310, y, { width: 120, align: 'right' });
        doc.text(fmtEur(data.totalNetto || 0), 435, y, { width: 80, align: 'right' });
        y += 16;

        doc.text(`zzgl. MwSt. ${vatPct}%:`, 310, y, { width: 120, align: 'right' });
        doc.text(fmtEur(data.vatAmount || 0), 435, y, { width: 80, align: 'right' });
        y += 16;

        doc.moveTo(330, y).lineTo(MARGIN + CONTENT_WIDTH, y).strokeColor('#333').lineWidth(0.5).stroke();
        y += 8;

        doc.fontSize(12).fillColor('#1a1a2e').font('Helvetica-Bold');
        doc.text('Gesamtbetrag:', 310, y, { width: 120, align: 'right' });
        doc.text(fmtEur(data.totalBrutto || 0), 435, y, { width: 80, align: 'right' });
        y += 30;
      }

      // ── Payment note ──
      if (isInvoice) {
        y = Math.max(y, 520);
        doc.fontSize(9).fillColor('#333').font('Helvetica');
        // Marketplace orders (eBay/Kaufland) are already paid through the
        // platform — do NOT ask the buyer to transfer money to us. Bank
        // details stay in the footer as company/Impressum info only.
        doc.fillColor('#666');
        doc.text('Zahlung über den Marktplatz – keine Überweisung erforderlich.', MARGIN, y, { width: CONTENT_WIDTH });
        y += 16;
      }

      // ── Footer (4-column, at bottom of page) ──
      const footerY = 740;
      doc.moveTo(MARGIN, footerY).lineTo(MARGIN + CONTENT_WIDTH, footerY).strokeColor('#ddd').lineWidth(0.5).stroke();
      const fy = footerY + 8;
      const colW = CONTENT_WIDTH / 4;
      doc.fontSize(7).fillColor('#999').font('Helvetica');

      // Col 1: Address
      const col1 = [co.name, co.street, `${co.zip} ${co.city}`.trim(), co.country].filter(Boolean);
      col1.forEach((line, i) => doc.text(line, MARGIN, fy + i * 10, { width: colW }));

      // Col 2: Contact
      const col2 = [];
      if (co.phone) col2.push(`Tel.: ${co.phone}`);
      if (co.email) col2.push(`E-Mail: ${co.email}`);
      if (co.website) col2.push(`Web: ${co.website}`);
      col2.forEach((line, i) => doc.text(line, MARGIN + colW, fy + i * 10, { width: colW }));

      // Col 3: Tax info
      const col3 = [];
      if (co.vatId) col3.push(`USt.-ID: ${co.vatId}`);
      if (co.taxId) col3.push(`Steuer-Nr.: ${co.taxId}`);
      if (co.owner) col3.push(`Inhaber: ${co.owner}`);
      col3.forEach((line, i) => doc.text(line, MARGIN + colW * 2, fy + i * 10, { width: colW }));

      // Col 4: Bank
      const col4 = [];
      if (co.bankName) col4.push(co.bankName);
      if (co.iban) col4.push(`IBAN: ${formatIban(co.iban)}`);
      if (co.bic) col4.push(`BIC: ${co.bic}`);
      col4.forEach((line, i) => doc.text(line, MARGIN + colW * 3, fy + i * 10, { width: colW }));

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/** Format EUR amount: "1.234,56 €" */
function fmtEur(n) {
  return `${Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} \u20AC`;
}

/** Format IBAN with spaces every 4 chars */
function formatIban(iban) {
  return (iban || '').replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim();
}

/**
 * Get the SevDesk user ID for the current API token.
 * Cached in memory for the process lifetime.
 */
let _sevdeskUserId = null;
async function getSevdeskUserId(token) {
  if (_sevdeskUserId) return _sevdeskUserId;
  try {
    const r = await fetch('https://my.sevdesk.de/api/v1/SevUser', {
      headers: { Authorization: token },
    });
    if (r.ok) {
      const data = await r.json();
      _sevdeskUserId = data?.objects?.[0]?.id || null;
    }
  } catch {
    // ignore — contactPerson will be omitted
  }
  return _sevdeskUserId;
}

/**
 * Format a YYYY-MM-DD date string to German DD.MM.YYYY format for SevDesk API.
 */
function toSevdeskDate(dateStr) {
  if (!dateStr) return null;
  const parts = String(dateStr).split('T')[0].split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

/**
 * Export an invoice to SevDesk using the Factory/saveInvoice endpoint.
 *
 * @param {{ invoiceId: string }} opts
 * @returns {Promise<{ ok: boolean, sevdeskId?: string, error?: string }>}
 */
async function exportToSevDesk({ invoiceId }) {
  try {
    const db = getDb();
    const snap = await db.collection(INVOICES_COLLECTION).doc(invoiceId).get();
    if (!snap.exists) throw new Error('Rechnung nicht gefunden');
    const invoice = snap.data();

    // Idempotency: never create a SECOND SevDesk invoice for the same record.
    // generateInvoice already creates AND finalizes the invoice in SevDesk, so
    // when sevdeskId is present this export must do nothing. This is the core
    // fix for the duplicate-draft bug: previously this function ran after every
    // generateInvoice and POSTed a fresh saveInvoice (id:null, status 100) —
    // producing a second SevDesk invoice as a permanent draft, carrying the
    // SAME invoiceNumber. See Incident: doubled invoices (paid + draft).
    if (invoice.sevdeskId) {
      return { ok: true, sevdeskId: invoice.sevdeskId, skipped: true };
    }

    const { getSecretValue } = require('../lib/secret-values');
    const token = await getSecretValue('SEVDESK_API_TOKEN');
    if (!token) throw new Error('SevDesk API Token not configured');

    const headers = { Authorization: token, 'Content-Type': 'application/json' };
    const userId = await getSevdeskUserId(token);

    const cust = invoice.customer || {};
    const taxRate = Math.round((invoice.vatRate || 0.19) * 100);
    const vatFactor = 1 + (invoice.vatRate || 0.19);

    // Build address string
    const addressParts = [
      cust.name,
      cust.street,
      `${cust.zip || ''} ${cust.city || ''}`.trim() || null,
    ].filter(Boolean);
    const address = addressParts.join('\n') || null;

    // Build line items from order
    let invoicePosSave = [];
    if (invoice.orderId) {
      try {
        const orderSnap = await db.collection(ORDERS_COLLECTION).doc(invoice.orderId).get();
        const items = orderSnap.exists ? (orderSnap.data()?.items || []) : [];
        invoicePosSave = items.map((item, i) => ({
          id: null,
          objectName: 'InvoicePos',
          mapAll: true,
          name: item.name || item.sku || 'Artikel',
          quantity: Number(item.quantity) || 1,
          price: Math.round((Number(item.priceBrutto || 0) / vatFactor) * 100) / 100,
          unity: { id: 1, objectName: 'Unity' },
          positionNumber: i + 1,
          taxRate,
        }));
      } catch (itemErr) {
        console.warn(`[invoice-engine] Failed to load order items: ${itemErr.message}`);
      }
    }

    // Fallback: single summary line if no items
    if (invoicePosSave.length === 0) {
      const amtNetto = invoice.amountNetto || invoice.amountNet || 0;
      invoicePosSave = [{
        id: null,
        objectName: 'InvoicePos',
        mapAll: true,
        name: `Bestellung ${invoice.orderNumber || invoice.marketplaceOrderId || invoice.orderId || invoiceId}`,
        quantity: 1,
        price: amtNetto,
        unity: { id: 1, objectName: 'Unity' },
        positionNumber: 1,
        taxRate,
      }];
    }

    const payload = {
      invoice: {
        id: null,
        objectName: 'Invoice',
        // Do NOT pass a client-side invoiceNumber. SevDesk assigns the official
        // sequential number on finalize (sendBy). Passing our local fallback
        // number (e.g. RE-2026-0059) is what pushed non-sequential numbers into
        // SevDesk. See Incident: wrong-format invoice numbers.
        invoiceDate: toSevdeskDate(invoice.date),
        deliveryDate: toSevdeskDate(invoice.date),
        deliveryDateUntil: null,
        status: '100',
        invoiceType: 'RE',
        taxRate,
        taxText: `Umsatzsteuer ${taxRate}%`,
        taxType: taxRate === 0 ? 'noteu' : 'default',
        currency: invoice.currency || 'EUR',
        discount: 0,
        smallSettlement: 0,
        address,
        ...(invoice.dueDate ? { payDate: toSevdeskDate(invoice.dueDate) } : {}),
        ...(userId ? { contactPerson: { id: userId, objectName: 'SevUser' } } : {}),
        mapAll: true,
      },
      invoicePosSave,
      invoicePosDelete: null,
      filename: null,
      discountSave: null,
    };

    const r = await fetch('https://my.sevdesk.de/api/v1/Invoice/Factory/saveInvoice', {
      method: 'POST', headers, body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`SevDesk ${r.status} /Invoice/Factory/saveInvoice: ${text.slice(0, 300)}`);
    }
    const data = await r.json();
    const sevdeskId = data?.objects?.invoice?.id || null;

    // Finalize the draft (sendBy VPDF) → transitions 100→200 and lets SevDesk
    // assign the official sequential number. Without this the export would
    // leave a permanent draft (exactly the symptom we are fixing).
    let assignedNumber = invoice.invoiceNumber || null;
    if (sevdeskId) {
      try {
        const rSend = await fetch(`https://my.sevdesk.de/api/v1/Invoice/${sevdeskId}/sendBy`, {
          method: 'PUT', headers, body: JSON.stringify({ sendType: 'VPDF' }),
        });
        if (rSend.ok) {
          const sd = await rSend.json().catch(() => ({}));
          assignedNumber = sd?.objects?.invoiceNumber || assignedNumber;
        } else {
          const t = await rSend.text().catch(() => '');
          console.warn(`[invoice-engine] sendBy finalize failed for ${sevdeskId}: ${rSend.status} ${t.slice(0, 150)}`);
        }
      } catch (sendErr) {
        console.warn(`[invoice-engine] sendBy finalize error for ${sevdeskId}: ${sendErr.message}`);
      }
    }

    // Update invoice with SevDesk ID + official number
    await snap.ref.set({
      sevdeskId,
      invoiceNumber: assignedNumber,
      status: 'offen',
      sevdeskExportedAt: new Date().toISOString(),
    }, { merge: true });

    return { ok: true, sevdeskId, invoiceNumber: assignedNumber };
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

/**
 * Generate invoices for all picked/packed/shipped/delivered/completed orders that don't have one yet.
 * Idempotent — skips orders with an existing invoiceId.
 *
 * @param {{ tenantId?: string }} opts
 * @returns {Promise<{ generated: number, skipped: number, errors: Array }>}
 */
async function bulkGenerateForShippedOrders({ tenantId = 'default' } = {}) {
  const db = getDb();
  const eligibleStatuses = ['picked', 'packed', 'shipped', 'delivered', 'completed'];
  const seen = new Set();
  const allOrders = [];

  for (const status of eligibleStatuses) {
    const snap = await db.collection(ORDERS_COLLECTION)
      .where('tenantId', '==', tenantId)
      .where('omsStatus', '==', status)
      .get();
    for (const doc of snap.docs) {
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      const d = doc.data();
      if (!d.invoiceId) allOrders.push({ id: doc.id, ...d });
    }
  }

  const results = { generated: 0, skipped: 0, errors: [] };

  // Sequential (not parallel) to avoid SevDesk invoice-numbering deadlocks
  for (const order of allOrders) {
    try {
      await generateInvoice({ orderId: order.id, tenantId });
      results.generated++;
    } catch (err) {
      console.warn(`[bulk-invoice] failed for ${order.id}: ${err.message}`);
      results.errors.push({ orderId: order.id, error: err.message });
      results.skipped++;
    }
  }

  return results;
}

/**
 * Import all invoices from SevDesk into Firestore.
 * Matches imported invoices to AvyCloud orders by gross amount (within €1 tolerance).
 * Idempotent — invoices already imported (matched by sevdeskId) are skipped.
 *
 * @param {{ tenantId?: string }} opts
 * @returns {Promise<{ imported: number, matched: number, skipped: number, total: number }>}
 */
async function importFromSevDesk({ tenantId = 'default' } = {}) {
  const { getSecretValue } = require('../lib/secret-values');
  const token = await getSecretValue('SEVDESK_API_TOKEN');
  if (!token) throw new Error('SevDesk API Token not configured');

  const db = getDb();

  // Paginate through all SevDesk invoices (100 per page) until exhausted
  const PAGE_SIZE = 100;
  const sdInvoices = [];
  let offset = 0;
  while (true) {
    const url = `https://my.sevdesk.de/api/v1/Invoice?limit=${PAGE_SIZE}&offset=${offset}&embed=contact&orderBy=invoiceDate%2Cdesc`;
    const res = await fetch(url, {
      headers: { Authorization: token, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`SevDesk API error ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const page = Array.isArray(data?.objects) ? data.objects : [];
    sdInvoices.push(...page);
    if (page.length < PAGE_SIZE) break; // last page
    offset += PAGE_SIZE;
  }
  console.log(`[invoice-engine] importFromSevDesk: fetched ${sdInvoices.length} invoices from SevDesk`);

  // Load all orders that still need an invoice for matching
  const ordersSnap = await db.collection(ORDERS_COLLECTION)
    .where('tenantId', '==', tenantId)
    .get();
  const unmatchedOrders = ordersSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((o) => !o.invoiceId);

  const STATUS_MAP = { '100': 'entwurf', '200': 'offen', '1000': 'bezahlt' };

  let imported = 0, matched = 0, skipped = 0;

  for (const sdInv of sdInvoices) {
    const sevdeskId = String(sdInv.id);

    // Idempotency: skip if already imported
    const existingSnap = await db.collection(INVOICES_COLLECTION)
      .where('tenantId', '==', tenantId)
      .where('sevdeskId', '==', sevdeskId)
      .limit(1)
      .get();
    if (!existingSnap.empty) { skipped++; continue; }

    const grossAmount = parseFloat(sdInv.sumGross) || 0;
    const netAmount = parseFloat(sdInv.sumNet) || 0;

    // Contact name — SevDesk can return name or surename+familyname
    const contactName = sdInv.contact?.name ||
      [sdInv.contact?.surename, sdInv.contact?.familyname].filter(Boolean).join(' ') ||
      null;

    const invDate = sdInv.invoiceDate ? String(sdInv.invoiceDate).split('T')[0] : null;
    const dueDate = sdInv.payDate ? String(sdInv.payDate).split('T')[0] : null;
    const status = STATUS_MAP[String(sdInv.status)] || 'entwurf';

    // Match to order by gross amount (within €1) — consume matched order so we don't double-assign
    let matchedOrderId = null;
    if (grossAmount > 0) {
      for (let i = 0; i < unmatchedOrders.length; i++) {
        const order = unmatchedOrders[i];
        const orderTotal = order.totalAmount || 0;
        if (Math.abs(orderTotal - grossAmount) < 1.0) {
          matchedOrderId = order.id;
          unmatchedOrders.splice(i, 1);
          break;
        }
      }
    }

    const invoiceDoc = {
      tenantId,
      sevdeskId,
      invoiceNumber: sdInv.invoiceNumber || null,
      date: invDate,
      dueDate,
      status,
      amountGross: grossAmount,
      amountNetto: netAmount,
      amountNet: netAmount,
      vatAmount: parseFloat(sdInv.sumTax) || 0,
      currency: sdInv.currency || 'EUR',
      customer: contactName ? { name: contactName } : null,
      orderId: matchedOrderId || null,
      source: 'sevdesk_import',
      pdfUrl: null,
      createdAt: new Date().toISOString(),
      importedAt: new Date().toISOString(),
    };

    const ref = await db.collection(INVOICES_COLLECTION).add(invoiceDoc);
    imported++;

    if (matchedOrderId) {
      await db.collection(ORDERS_COLLECTION).doc(matchedOrderId).update({
        invoiceId: ref.id,
        invoiceNumber: invoiceDoc.invoiceNumber,
        sevdeskInvoiceId: sevdeskId,
        updatedAt: new Date().toISOString(),
      });
      matched++;
    }
  }

  return { imported, matched, skipped, total: sdInvoices.length };
}

/**
 * Create a correction document for an order invoice:
 *   - type 'storno'    → cancels the full invoice in SevDesk (POST /Invoice/{id}/cancelInvoice)
 *   - type 'gutschrift' → creates a partial Stornorechnung (SR) in SevDesk for refundAmount
 *
 * Idempotent: if a correction of the same type already exists for this order, skips.
 *
 * @param {{
 *   orderId: string,
 *   tenantId?: string,
 *   type?: 'storno' | 'gutschrift',
 *   refundAmount?: number,
 *   reason?: string,
 * }} opts
 * @returns {Promise<{ ok: boolean, correctionId?: string, sevdeskId?: string, reason?: string }>}
 */
async function createCorrectionInvoice({ orderId, tenantId = 'default', type = 'storno', refundAmount = null, reason = '' } = {}) {
  const db = getDb();

  // Find the original invoice for this order
  const invQuery = await db.collection(INVOICES_COLLECTION)
    .where('orderId', '==', orderId)
    .where('tenantId', '==', tenantId)
    .limit(1)
    .get();

  if (invQuery.empty) {
    console.warn(`[invoice-engine] createCorrectionInvoice: no invoice found for order ${orderId}`);
    return { ok: false, reason: 'no_invoice' };
  }

  const invDoc = invQuery.docs[0];
  const invoice = { id: invDoc.id, ...invDoc.data() };

  // Idempotency: skip if already corrected with this type
  if (invoice.correctionId && invoice.correctionType === type) {
    return { ok: true, correctionId: invoice.correctionId, skipped: true };
  }

  const { getSecretValue } = require('../lib/secret-values');
  const token = await getSecretValue('SEVDESK_API_TOKEN');
  if (!token) throw new Error('SevDesk API Token not configured');

  const headers = { Authorization: token, 'Content-Type': 'application/json' };
  const correctionAmount = refundAmount || invoice.amountGross || 0;
  const vatRate = Math.round((invoice.vatRate || 0.19) * 100);
  const vatFactor = 1 + (invoice.vatRate || 0.19);
  let correctionSevdeskId = null;

  if (type === 'storno') {
    // Full cancellation: POST /Invoice/{id}/cancelInvoice → SevDesk auto-creates Stornorechnung (SR)
    if (invoice.sevdeskId) {
      try {
        const r = await fetch(`https://my.sevdesk.de/api/v1/Invoice/${invoice.sevdeskId}/cancelInvoice`, {
          method: 'POST', headers,
        });
        if (r.ok) {
          const data = await r.json();
          correctionSevdeskId = data?.objects?.id || null;
        } else {
          const text = await r.text().catch(() => '');
          console.warn(`[invoice-engine] SevDesk cancelInvoice failed: ${r.status} ${text.slice(0, 200)}`);
        }
      } catch (err) {
        console.warn(`[invoice-engine] SevDesk cancelInvoice error: ${err.message}`);
      }
    }
  } else {
    // Partial refund: create Stornorechnung (SR) in SevDesk via factory endpoint
    try {
      const amountNetto = Math.round((correctionAmount / vatFactor) * 100) / 100;
      const today = toSevdeskDate(new Date().toISOString().split('T')[0]);
      const userId = await getSevdeskUserId(token);
      const cust = invoice.customer || {};
      const addressParts = [cust.name, cust.street, `${cust.zip || ''} ${cust.city || ''}`.trim() || null].filter(Boolean);
      const payload = {
        invoice: {
          id: null,
          objectName: 'Invoice',
          invoiceNumber: `SR-${invoice.invoiceNumber || Date.now()}`,
          invoiceDate: today,
          deliveryDate: today,
          deliveryDateUntil: null,
          status: '100',
          invoiceType: 'SR',
          taxRate: vatRate,
          taxText: `Umsatzsteuer ${vatRate}%`,
          taxType: vatRate === 0 ? 'noteu' : 'default',
          currency: invoice.currency || 'EUR',
          discount: 0,
          smallSettlement: 0,
          address: addressParts.join('\n') || null,
          ...(userId ? { contactPerson: { id: userId, objectName: 'SevUser' } } : {}),
          mapAll: true,
        },
        invoicePosSave: [{
          id: null,
          objectName: 'InvoicePos',
          mapAll: true,
          name: reason || `Teilerstattung ${invoice.orderNumber || invoice.marketplaceOrderId || orderId}`,
          quantity: 1,
          price: amountNetto,
          unity: { id: 1, objectName: 'Unity' },
          positionNumber: 1,
          taxRate: vatRate,
        }],
        invoicePosDelete: null,
        filename: null,
        discountSave: null,
      };
      const r = await fetch('https://my.sevdesk.de/api/v1/Invoice/Factory/saveInvoice', {
        method: 'POST', headers, body: JSON.stringify(payload),
      });
      if (r.ok) {
        const data = await r.json();
        correctionSevdeskId = data?.objects?.invoice?.id || null;
      } else {
        const text = await r.text().catch(() => '');
        console.warn(`[invoice-engine] SevDesk SR creation failed: ${r.status} ${text.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn(`[invoice-engine] SevDesk SR error: ${err.message}`);
    }
  }

  // Store correction in Firestore
  const correctionDoc = {
    tenantId,
    type,
    originalInvoiceId: invoice.id,
    originalInvoiceNumber: invoice.invoiceNumber,
    orderId,
    orderNumber: invoice.orderNumber || null,
    marketplaceOrderId: invoice.marketplaceOrderId || null,
    marketplace: invoice.marketplace || null,
    amountGross: correctionAmount,
    amountNetto: Math.round((correctionAmount / vatFactor) * 100) / 100,
    amountNet: Math.round((correctionAmount / vatFactor) * 100) / 100,
    vatRate: invoice.vatRate || 0.19,
    currency: invoice.currency || 'EUR',
    customer: invoice.customer || null,
    sevdeskId: correctionSevdeskId || null,
    reason,
    status: 'storniert',
    date: new Date().toISOString().split('T')[0],
    createdAt: new Date().toISOString(),
  };

  const ref = await db.collection(INVOICES_COLLECTION).add(correctionDoc);

  // Mark original invoice as corrected
  await invDoc.ref.update({
    correctionId: ref.id,
    correctionType: type,
    correctedAt: new Date().toISOString(),
    status: type === 'storno' ? 'storniert' : 'teilkorrigiert',
    updatedAt: new Date().toISOString(),
  });

  console.log(`[invoice-engine] createCorrectionInvoice: ${type} created (${ref.id}) for order ${orderId}`);
  return { ok: true, correctionId: ref.id, sevdeskId: correctionSevdeskId, amount: correctionAmount };
}

module.exports = {
  generateInvoice,
  generateDeliveryNote,
  exportToSevDesk,
  importFromSevDesk,
  bulkGenerateForShippedOrders,
  createCorrectionInvoice,
  getCompanySettings,
  buildInvoicePdf,
};
