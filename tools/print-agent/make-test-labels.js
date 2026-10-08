'use strict';
// Build-time only. Runtime fixtures contain no order/customer data or postage.
const fs = require('node:fs/promises');
const path = require('node:path');
const { PDFDocument, StandardFonts, rgb } = require('../../backend/node_modules/pdf-lib');
const QRCode = require('../../backend/node_modules/qrcode');
const mm = (value) => value * 72 / 25.4;

async function main() {
  const target = path.join(__dirname, 'fixtures');
  await fs.mkdir(target, { recursive: true });
  for (const [role, width, height] of [['parcel', 103, 164], ['letter', 62, 100]]) {
    const doc = await PDFDocument.create();
    doc.setTitle(`AvyCloud Drucktest ${width}x${height} mm`);
    doc.setCreationDate(new Date('2026-10-08T00:00:00Z'));
    doc.setModificationDate(new Date('2026-10-08T00:00:00Z'));
    const page = doc.addPage([mm(width), mm(height)]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    page.drawRectangle({ x: mm(3), y: mm(3), width: mm(width - 6), height: mm(height - 6), borderWidth: 0.5, borderColor: rgb(0, 0, 0) });
    page.drawText('AVYCLOUD', { x: mm(7), y: mm(height - 13), size: 15, font: bold });
    page.drawText('TEST - KEIN PORTO', { x: mm(7), y: mm(height - 22), size: 10, font: bold });
    page.drawText(`${role === 'parcel' ? 'PAKET' : 'BRIEF'}  ${width} x ${height} mm`, { x: mm(7), y: mm(height - 29), size: 10, font });
    const value = `AVYCLOUD-DRUCKTEST-${role.toUpperCase()}`;
    const image = await doc.embedPng(await QRCode.toBuffer(value, { width: 600, margin: 4, errorCorrectionLevel: 'M' }));
    page.drawImage(image, { x: mm(7), y: mm(height - 65), width: mm(30), height: mm(30) });
    page.drawText('Rahmen vollstaendig?', { x: mm(7), y: mm(25), size: 9, font });
    page.drawText('QR-Code scannen.', { x: mm(7), y: mm(20), size: 9, font });
    page.drawLine({ start: { x: mm(7), y: mm(12) }, end: { x: mm(47), y: mm(12) }, thickness: 1 });
    for (let i = 0; i <= 4; i++) page.drawLine({ start: { x: mm(7 + i * 10), y: mm(11) }, end: { x: mm(7 + i * 10), y: mm(14) }, thickness: 0.7 });
    page.drawText('40 mm Referenz', { x: mm(7), y: mm(7), size: 8, font });
    await fs.writeFile(path.join(target, `${role}.pdf`), await doc.save());
  }
}
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { main };
