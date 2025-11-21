const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const LABEL_WIDTH_MM = 57;
const LABEL_HEIGHT_MM = 25;
const QR_SIZE_MM = 20;
const LABEL_PADDING_MM = 3;
const LABEL_GAP_MM = 3;
const TEXT_AREA_WIDTH_MM = LABEL_WIDTH_MM - QR_SIZE_MM - LABEL_GAP_MM - LABEL_PADDING_MM * 2;
const MIN_FONT_SIZE_MM = 3.2;
const MAX_FONT_SIZE_MM = 6.3;

const mmToPoints = (mm) => (mm / 25.4) * 72;

function getBinFontMetrics(code = '') {
  const clean = String(code || '').trim();
  const length = Math.max(clean.length, 1);
  const charWidth = TEXT_AREA_WIDTH_MM / length;
  const fontSize = Math.max(
    Math.min(MAX_FONT_SIZE_MM, Number((charWidth * 0.92).toFixed(2))),
    MIN_FONT_SIZE_MM
  );
  const letterSpacing = Math.max(Number((fontSize * 0.12).toFixed(3)), 0.05);
  return { fontSize, letterSpacing };
}

async function buildProductLabelsHtml(items) {
  if (!items || !items.length) {
    throw new Error('Keine Produkte für Etiketten angegeben.');
  }
  const labels = await Promise.all(
    items.map(async (item) => {
      const qrDataUrl = await QRCode.toDataURL(item.code, {
        errorCorrectionLevel: 'H',
        margin: 0,
        scale: 8,
      });
      const skuLine = escapeHtml(item.skuLine || item.code);
      const description = escapeHtml(item.description || '');
      return `
        <div class="label">
          <div class="label-inner">
            <div class="qr">
              <img src="${qrDataUrl}" alt="${skuLine}" />
            </div>
            <div class="text-block">
              <div class="sku">${skuLine}</div>
              ${description ? `<div class="desc">${description}</div>` : ''}
            </div>
          </div>
        </div>
      `;
    })
  );

  return `<!DOCTYPE html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <title>Produktetiketten</title>
    <style>
      @page {
        size: ${LABEL_WIDTH_MM}mm ${LABEL_HEIGHT_MM}mm;
        margin: 0;
      }
      body {
        margin: 0;
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
        -webkit-print-color-adjust: exact;
        background: #ffffff;
      }
      .label {
        width: ${LABEL_WIDTH_MM}mm;
        height: ${LABEL_HEIGHT_MM}mm;
        box-sizing: border-box;
        padding: 2mm 3mm;
        page-break-after: always;
      }
      .label:last-child {
        page-break-after: auto;
      }
      .label-inner {
        display: flex;
        width: 100%;
        height: 100%;
        align-items: center;
        justify-content: flex-start;
        gap: 2.5mm;
      }
      .qr {
        flex: 0 0 20mm;
        height: 20mm;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .qr img {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }
      .text-block {
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 0.6mm;
        overflow: hidden;
        height: 100%;
      }
      .sku {
        font-size: 4.6mm;
        font-weight: 700;
        line-height: 1.05;
        white-space: normal;
        word-break: break-all;
      }
      .desc {
        font-size: 2.6mm;
        line-height: 1.1;
        color: #111;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        word-break: break-word;
      }
    </style>
    <script>
      window.addEventListener('load', () => {
        setTimeout(() => {
          window.print();
          window.onafterprint = () => window.close();
        }, 300);
      });
    </script>
  </head>
  <body>
    ${labels.join('')}
  </body>
</html>`;
}

async function renderSingleBinLabel(code) {
  const raw = String(code || '').trim();
  if (!raw) {
    throw new Error('BIN-Code darf nicht leer sein.');
  }
  const normalized = escapeHtml(raw);
  const { fontSize, letterSpacing } = getBinFontMetrics(raw);
  const qrDataUrl = await QRCode.toDataURL(code, {
    errorCorrectionLevel: 'H',
    margin: 0,
    scale: 8,
  });
  return `
    <div class="label">
      <div class="qr"><img src="${qrDataUrl}" alt="${normalized}" /></div>
      <div class="text" data-length="${raw.length}" style="font-size:${fontSize}mm;letter-spacing:${letterSpacing}mm;">${normalized}</div>
    </div>
  `;
}

async function buildBinLabelsHtml(codes = []) {
  if (!codes || !codes.length) {
    throw new Error('Mindestens ein BIN-Code ist erforderlich.');
  }
  const labels = await Promise.all(codes.map((code) => renderSingleBinLabel(code)));
  return `<!DOCTYPE html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <title>BIN Labels</title>
    <style>
      @page {
        size: ${LABEL_WIDTH_MM}mm ${LABEL_HEIGHT_MM}mm;
        margin: 0;
      }
      body {
        margin: 0;
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
        -webkit-print-color-adjust: exact;
        background: #ffffff;
      }
      .label {
        width: ${LABEL_WIDTH_MM}mm;
        height: ${LABEL_HEIGHT_MM}mm;
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 3mm;
        padding: 2mm 3mm;
        box-sizing: border-box;
        page-break-after: always;
      }
      .label:last-child {
        page-break-after: auto;
      }
      .qr {
        width: ${QR_SIZE_MM}mm;
        height: ${QR_SIZE_MM}mm;
      }
      .qr img {
        width: 100%;
        height: 100%;
      }
      .text {
        flex: 1;
        font-size: 6mm;
        font-weight: 700;
        font-family: 'SFMono-Regular', 'Roboto Mono', 'Fira Mono', 'Menlo', monospace;
        text-align: left;
        line-height: 1.05;
        white-space: nowrap;
        overflow: visible;
      }
    </style>
    <script>
      window.addEventListener('load', () => {
        setTimeout(() => {
          window.print();
          window.onafterprint = () => window.close();
        }, 150);
      });
    </script>
  </head>
  <body>
    ${labels.join('')}
  </body>
</html>`;
}

async function buildBinLabelHtml({ code }) {
  if (!code) throw new Error('Code is required for label generation');
  return buildBinLabelsHtml([code]);
}

async function buildBinLabelsPdf(codes = []) {
  if (!codes || !codes.length) {
    throw new Error('Mindestens ein BIN-Code ist erforderlich.');
  }

  const doc = new PDFDocument({
    size: [mmToPoints(LABEL_WIDTH_MM), mmToPoints(LABEL_HEIGHT_MM)],
    margins: {
      top: mmToPoints(LABEL_PADDING_MM),
      bottom: mmToPoints(LABEL_PADDING_MM),
      left: mmToPoints(LABEL_PADDING_MM),
      right: mmToPoints(LABEL_PADDING_MM),
    },
  });

  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (index > 0) {
      doc.addPage();
    }
    const qrDataUrl = await QRCode.toDataURL(code, {
      errorCorrectionLevel: 'H',
      margin: 0,
      scale: 8,
    });
    const base64 = qrDataUrl.replace(/^data:image\/png;base64,/, '');
    const qrBuffer = Buffer.from(base64, 'base64');

    const { fontSize, letterSpacing } = getBinFontMetrics(code);

    doc.image(qrBuffer, 0, 0, { fit: [mmToPoints(QR_SIZE_MM), mmToPoints(QR_SIZE_MM)] });

    const textX = mmToPoints(QR_SIZE_MM + LABEL_GAP_MM);
    const textY = mmToPoints(6);
    doc
      .font('Helvetica-Bold')
      .fontSize(mmToPoints(fontSize))
      .text(String(code).trim(), textX, textY, {
        width: mmToPoints(TEXT_AREA_WIDTH_MM),
        align: 'left',
        characterSpacing: mmToPoints(letterSpacing),
      });
  }

  doc.end();

  await new Promise((resolve, reject) => {
    doc.once('end', resolve);
    doc.once('error', reject);
  });

  return Buffer.concat(chunks);
}

module.exports = {
  buildProductLabelsHtml,
  buildBinLabelHtml,
  buildBinLabelsHtml,
  buildBinLabelsPdf,
};

