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
        gap: 3mm;
      }
      .qr {
        flex: 0 0 19mm;
        height: 19mm;
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
        overflow: hidden;
      }
      .sku {
        font-size: 5.2mm;
        font-weight: 700;
        line-height: 1.05;
        margin-bottom: 1.5mm;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .desc {
        font-size: 3.2mm;
        line-height: 1.1;
        max-height: 12mm;
        overflow: hidden;
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

async function buildBinLabelHtml({ code, title }) {
  if (!code) throw new Error('Code is required for label generation');
  const qrDataUrl = await QRCode.toDataURL(code, {
    errorCorrectionLevel: 'H',
    margin: 0,
    scale: 8,
  });
  return `<!DOCTYPE html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(code)} Label</title>
    <style>
      @page {
        size: ${LABEL_WIDTH_MM}mm ${LABEL_HEIGHT_MM}mm;
        margin: 0;
      }
      body {
        margin: 0;
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
        -webkit-print-color-adjust: exact;
      }
      .label {
        width: ${LABEL_WIDTH_MM}mm;
        height: ${LABEL_HEIGHT_MM}mm;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 2mm 3mm;
        box-sizing: border-box;
      }
      .qr {
        width: 19mm;
        height: 19mm;
      }
      .qr img {
        width: 100%;
        height: 100%;
      }
      .text {
        font-size: 5.2mm;
        font-weight: 600;
        text-align: right;
        line-height: 1.1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .text .sub {
        font-size: 3.1mm;
        font-weight: 500;
      }
    </style>
    <script>
      window.addEventListener('load', () => {
        window.print();
        window.onafterprint = () => window.close();
      });
    </script>
  </head>
  <body>
    <div class="label">
      <div class="qr"><img src="${qrDataUrl}" alt="${escapeHtml(code)}" /></div>
      <div class="text">
        <div>${escapeHtml(code)}</div>
        ${title ? `<div class="sub">${escapeHtml(title)}</div>` : ''}
      </div>
    </div>
  </body>
</html>`;
}

module.exports = {
  buildProductLabelsHtml,
  buildBinLabelHtml,
};

