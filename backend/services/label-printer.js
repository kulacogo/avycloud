const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const LABEL_WIDTH_MM = 57;
const LABEL_HEIGHT_MM = 25;
const MM_TO_PT = 72 / 25.4;
const LABEL_WIDTH_PT = LABEL_WIDTH_MM * MM_TO_PT;
const LABEL_HEIGHT_PT = LABEL_HEIGHT_MM * MM_TO_PT;

function mmToPt(mm) {
  return mm * MM_TO_PT;
}

async function generateSkuLabel({ sku, title }) {
  if (!sku) {
    throw new Error('SKU is required for label generation');
  }

  const doc = new PDFDocument({
    size: [LABEL_WIDTH_PT, LABEL_HEIGHT_PT],
    margins: { top: mmToPt(2), bottom: mmToPt(2), left: mmToPt(4), right: mmToPt(4) },
    info: {
      Title: `Label ${sku}`,
    },
  });

  const chunks = [];
  return new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.rect(0, 0, LABEL_WIDTH_PT, LABEL_HEIGHT_PT).strokeOpacity(0.2).stroke();

    doc.fontSize(8).font('Helvetica-Bold').text('SKU', mmToPt(2), mmToPt(2));
    doc.fontSize(14).font('Helvetica-Bold').text(sku, mmToPt(2), mmToPt(6), {
      width: LABEL_WIDTH_PT - mmToPt(26),
    });

    if (title) {
      doc.fontSize(7).font('Helvetica').text(title, mmToPt(2), mmToPt(14), {
        width: LABEL_WIDTH_PT - mmToPt(26),
        height: mmToPt(10),
      });
    }

    const qrSizePt = mmToPt(20);
    QRCode.toBuffer(
      sku,
      {
        errorCorrectionLevel: 'H',
        margin: 0,
        width: Math.round(qrSizePt),
      },
      (err, buffer) => {
        if (err) {
          doc.end();
          return reject(err);
        }
        doc.image(buffer, LABEL_WIDTH_PT - qrSizePt - mmToPt(2), mmToPt(2), {
          width: qrSizePt,
          height: qrSizePt,
        });
        doc.end();
      }
    );
  });
}

module.exports = {
  generateSkuLabel,
};

