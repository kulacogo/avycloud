const QRCode = require('qrcode');

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

function getBinFontMetrics(code = '') {
  const length = String(code || '').trim().length;
  if (length <= 6) return { fontSize: 6.2, letterSpacing: 0.35 };
  if (length <= 8) return { fontSize: 5.4, letterSpacing: 0.28 };
  if (length <= 10) return { fontSize: 4.8, letterSpacing: 0.22 };
  if (length <= 12) return { fontSize: 4.2, letterSpacing: 0.18 };
  return { fontSize: 3.8, letterSpacing: 0.14 };
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
        width: 20mm;
        height: 20mm;
      }
      .qr img {
        width: 100%;
        height: 100%;
      }
      .text {
        flex: 1;
        font-size: 6mm;
        font-weight: 700;
        text-align: left;
        line-height: 1.05;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
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

module.exports = {
  buildProductLabelsHtml,
  buildBinLabelHtml,
  buildBinLabelsHtml,
};

