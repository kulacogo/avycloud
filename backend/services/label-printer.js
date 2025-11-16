const QRCode = require('qrcode');

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function buildProductLabelsHtml(items) {
  if (!items || !items.length) {
    throw new Error('Keine Produkte für Etiketten angegeben.');
  }
  const widthMm = 101;
  const heightMm = 54;
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
        size: ${widthMm}mm ${heightMm}mm;
        margin: 0;
      }
      body {
        margin: 0;
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
        -webkit-print-color-adjust: exact;
        background: #ffffff;
      }
      .label {
        width: ${widthMm}mm;
        height: ${heightMm}mm;
        box-sizing: border-box;
        padding: 6mm 6mm 6mm 6mm;
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
        gap: 6mm;
      }
      .qr {
        flex: 0 0 42mm;
        height: 42mm;
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
      }
      .sku {
        font-size: 9mm;
        font-weight: 700;
        margin-bottom: 4mm;
      }
      .desc {
        font-size: 4mm;
        line-height: 1.2;
        white-space: pre-line;
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
        size: 57mm 25mm;
        margin: 0;
      }
      body {
        margin: 0;
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
        -webkit-print-color-adjust: exact;
      }
      .label {
        width: 57mm;
        height: 25mm;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 2mm 4mm;
        box-sizing: border-box;
      }
      .qr {
        width: 22mm;
        height: 22mm;
      }
      .qr img {
        width: 100%;
        height: 100%;
      }
      .text {
        font-size: 6mm;
        font-weight: 600;
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
      <div class="text">${escapeHtml(code)}</div>
    </div>
  </body>
</html>`;
}

module.exports = {
  buildProductLabelsHtml,
  buildBinLabelHtml,
};

