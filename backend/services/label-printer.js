const QRCode = require('qrcode');

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function buildLabelHtml({ sku, title }) {
  if (!sku) {
    throw new Error('SKU is required for label generation');
  }
  const sanitizedTitle = escapeHtml(title || '');
  const qrDataUrl = await QRCode.toDataURL(sku, {
    errorCorrectionLevel: 'H',
    margin: 0,
    scale: 8,
  });

  return `<!DOCTYPE html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(sku)} Label</title>
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
        object-fit: contain;
      }
      .info {
        flex: 1;
        padding-right: 4mm;
        display: flex;
        flex-direction: column;
        justify-content: center;
      }
      .sku-label {
        font-size: 3mm;
        letter-spacing: 0.3mm;
        text-transform: uppercase;
      }
      .sku-value {
        font-size: 6.2mm;
        font-weight: 700;
        margin: 1mm 0 2mm;
      }
      .title {
        font-size: 3mm;
        line-height: 1.2;
        max-height: 7.5mm;
        overflow: hidden;
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
      <div class="info">
        <div class="sku-label">SKU</div>
        <div class="sku-value">${escapeHtml(sku)}</div>
        <div class="title">${sanitizedTitle}</div>
      </div>
      <div class="qr">
        <img src="${qrDataUrl}" alt="${escapeHtml(sku)} QR Code" />
      </div>
    </div>
  </body>
</html>`;
}

module.exports = {
  buildLabelHtml,
};

