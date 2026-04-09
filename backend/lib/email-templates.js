/**
 * Email Template System
 *
 * Provides a base HTML layout and named templates for transactional emails.
 * Templates use simple {{variable}} placeholders replaced at render time.
 *
 * Usage:
 *   const { renderEmail } = require('./email-templates');
 *   const { subject, text, html } = renderEmail('password-reset', { resetLink });
 */

const BRAND_COLOR = '#635BFF';
const BRAND_NAME = 'avycloud';
const BRAND_TAGLINE = 'Product Intelligence Hub';

/**
 * Base HTML email layout with responsive design and brand styling.
 */
function baseLayout(bodyHtml, { preheader = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${BRAND_NAME}</title>
<style>
  body { margin:0; padding:0; background:#f4f5f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  .wrapper { max-width:560px; margin:0 auto; padding:32px 16px; }
  .card { background:#ffffff; border-radius:12px; padding:32px; box-shadow:0 1px 3px rgba(0,0,0,0.08); }
  .header { text-align:center; margin-bottom:24px; }
  .header img { height:32px; }
  .header h1 { font-size:18px; color:#1a1a2e; margin:8px 0 0; font-weight:700; }
  .header .tagline { font-size:12px; color:#8b8fa3; margin-top:2px; }
  .content { font-size:15px; color:#2d2d3a; line-height:1.6; }
  .content p { margin:0 0 16px; }
  .content a { color:${BRAND_COLOR}; text-decoration:none; }
  .btn { display:inline-block; background:${BRAND_COLOR}; color:#ffffff !important; padding:12px 28px; border-radius:8px; font-size:14px; font-weight:600; text-decoration:none; margin:8px 0 16px; }
  .btn:hover { opacity:0.9; }
  .footer { text-align:center; margin-top:24px; font-size:12px; color:#8b8fa3; }
  .footer a { color:#8b8fa3; }
  .divider { border:none; border-top:1px solid #eef0f2; margin:20px 0; }
  .preheader { display:none; max-height:0; overflow:hidden; mso-hide:all; }
</style>
</head>
<body>
${preheader ? `<div class="preheader">${preheader}</div>` : ''}
<div class="wrapper">
  <div class="card">
    <div class="header">
      <h1>${BRAND_NAME}</h1>
      <div class="tagline">${BRAND_TAGLINE}</div>
    </div>
    <div class="content">
      ${bodyHtml}
    </div>
  </div>
  <div class="footer">
    <p>&copy; ${new Date().getFullYear()} ${BRAND_NAME} &middot; <a href="https://avycloud.web.app">avycloud.web.app</a></p>
  </div>
</div>
</body>
</html>`;
}

/**
 * Named email templates.
 * Each returns { subject, text, html }.
 */
const templates = {
  'password-reset': (vars) => ({
    subject: `${BRAND_NAME} – Passwort zurücksetzen`,
    text:
      `Hallo,\n\n` +
      `du hast einen Passwort-Reset für ${BRAND_NAME} angefordert.\n\n` +
      `Passwort zurücksetzen:\n${vars.resetLink}\n\n` +
      `Falls du das nicht warst, ignoriere diese E-Mail.\n`,
    html: baseLayout(
      `<p>Hallo,</p>` +
      `<p>du hast einen Passwort-Reset für <strong>${BRAND_NAME}</strong> angefordert.</p>` +
      `<p><a href="${vars.resetLink}" class="btn">Passwort zurücksetzen</a></p>` +
      `<p style="font-size:13px; color:#8b8fa3;">Falls du das nicht warst, ignoriere diese E-Mail.</p>`,
      { preheader: 'Setze dein Passwort zurück' }
    ),
  }),

  'user-invitation': (vars) => ({
    subject: `${BRAND_NAME} – Zugang einrichten`,
    text:
      `Hallo,\n\n` +
      `du wurdest für ${BRAND_NAME} freigeschaltet.\n\n` +
      `1) Passwort setzen:\n${vars.resetLink}\n\n` +
      `2) E-Mail bestätigen:\n${vars.verifyLink}\n\n` +
      `Danach kannst du dich anmelden.\n`,
    html: baseLayout(
      `<p>Hallo,</p>` +
      `<p>du wurdest für <strong>${BRAND_NAME}</strong> freigeschaltet.</p>` +
      `<p><strong>Schritt 1:</strong> Passwort setzen</p>` +
      `<p><a href="${vars.resetLink}" class="btn">Passwort setzen</a></p>` +
      `<hr class="divider"/>` +
      `<p><strong>Schritt 2:</strong> E-Mail bestätigen (Pflicht)</p>` +
      `<p><a href="${vars.verifyLink}" class="btn" style="background:#22c55e;">E-Mail bestätigen</a></p>` +
      `<p style="font-size:13px; color:#8b8fa3;">Danach kannst du dich mit deiner E-Mail-Adresse anmelden.</p>`,
      { preheader: 'Richte deinen AvyCloud-Zugang ein' }
    ),
  }),

  'order-confirmation': (vars) => ({
    subject: `${BRAND_NAME} – Auftragsbestätigung #${vars.orderNumber || ''}`,
    text:
      `Auftragsbestätigung\n\n` +
      `Auftragsnummer: ${vars.orderNumber || '—'}\n` +
      `Datum: ${vars.date || new Date().toLocaleDateString('de-DE')}\n` +
      `Artikel: ${vars.itemCount || 0}\n` +
      `Gesamtbetrag: ${vars.total || '—'}\n\n` +
      `Vielen Dank für deine Bestellung.\n`,
    html: baseLayout(
      `<p>Auftragsbestätigung</p>` +
      `<table width="100%" style="font-size:14px; border-collapse:collapse; margin:16px 0;">` +
      `<tr><td style="padding:8px 0; border-bottom:1px solid #eef0f2; color:#8b8fa3;">Auftragsnummer</td>` +
      `<td style="padding:8px 0; border-bottom:1px solid #eef0f2; text-align:right; font-weight:600;">${vars.orderNumber || '—'}</td></tr>` +
      `<tr><td style="padding:8px 0; border-bottom:1px solid #eef0f2; color:#8b8fa3;">Datum</td>` +
      `<td style="padding:8px 0; border-bottom:1px solid #eef0f2; text-align:right;">${vars.date || new Date().toLocaleDateString('de-DE')}</td></tr>` +
      `<tr><td style="padding:8px 0; border-bottom:1px solid #eef0f2; color:#8b8fa3;">Artikel</td>` +
      `<td style="padding:8px 0; border-bottom:1px solid #eef0f2; text-align:right;">${vars.itemCount || 0}</td></tr>` +
      `<tr><td style="padding:8px 0; color:#8b8fa3;">Gesamtbetrag</td>` +
      `<td style="padding:8px 0; text-align:right; font-weight:700; font-size:16px; color:${BRAND_COLOR};">${vars.total || '—'}</td></tr>` +
      `</table>` +
      `<p style="font-size:13px; color:#8b8fa3;">Vielen Dank für deine Bestellung.</p>`,
      { preheader: `Auftrag #${vars.orderNumber || ''} bestätigt` }
    ),
  }),

  'shipping-notification': (vars) => ({
    subject: `${BRAND_NAME} – Deine Sendung ist unterwegs`,
    text:
      `Deine Sendung ist unterwegs!\n\n` +
      `Auftragsnummer: ${vars.orderNumber || '—'}\n` +
      `Versanddienstleister: ${vars.carrier || '—'}\n` +
      `Sendungsnummer: ${vars.trackingNumber || '—'}\n` +
      (vars.trackingUrl ? `Sendungsverfolgung: ${vars.trackingUrl}\n` : '') +
      `\n`,
    html: baseLayout(
      `<p>Deine Sendung ist unterwegs!</p>` +
      `<table width="100%" style="font-size:14px; border-collapse:collapse; margin:16px 0;">` +
      `<tr><td style="padding:8px 0; border-bottom:1px solid #eef0f2; color:#8b8fa3;">Auftragsnummer</td>` +
      `<td style="padding:8px 0; border-bottom:1px solid #eef0f2; text-align:right;">${vars.orderNumber || '—'}</td></tr>` +
      `<tr><td style="padding:8px 0; border-bottom:1px solid #eef0f2; color:#8b8fa3;">Versand via</td>` +
      `<td style="padding:8px 0; border-bottom:1px solid #eef0f2; text-align:right;">${vars.carrier || '—'}</td></tr>` +
      `<tr><td style="padding:8px 0; color:#8b8fa3;">Sendungsnummer</td>` +
      `<td style="padding:8px 0; text-align:right; font-family:monospace;">${vars.trackingNumber || '—'}</td></tr>` +
      `</table>` +
      (vars.trackingUrl
        ? `<p><a href="${vars.trackingUrl}" class="btn">Sendung verfolgen</a></p>`
        : '') +
      `<p style="font-size:13px; color:#8b8fa3;">Bei Fragen kontaktiere uns gerne.</p>`,
      { preheader: `Sendung für Auftrag #${vars.orderNumber || ''} unterwegs` }
    ),
  }),

  'low-stock-alert': (vars) => ({
    subject: `${BRAND_NAME} – Niedriger Bestand: ${vars.productName || 'Produkt'}`,
    text:
      `Niedrig-Bestand-Warnung\n\n` +
      `Produkt: ${vars.productName || '—'}\n` +
      `SKU: ${vars.sku || '—'}\n` +
      `Aktueller Bestand: ${vars.currentStock ?? '—'}\n` +
      `Mindestbestand: ${vars.minStock ?? '—'}\n\n` +
      `Bitte Nachbestellung prüfen.\n`,
    html: baseLayout(
      `<p><strong>Niedrig-Bestand-Warnung</strong></p>` +
      `<table width="100%" style="font-size:14px; border-collapse:collapse; margin:16px 0;">` +
      `<tr><td style="padding:8px 0; border-bottom:1px solid #eef0f2; color:#8b8fa3;">Produkt</td>` +
      `<td style="padding:8px 0; border-bottom:1px solid #eef0f2; text-align:right; font-weight:600;">${vars.productName || '—'}</td></tr>` +
      `<tr><td style="padding:8px 0; border-bottom:1px solid #eef0f2; color:#8b8fa3;">SKU</td>` +
      `<td style="padding:8px 0; border-bottom:1px solid #eef0f2; text-align:right; font-family:monospace;">${vars.sku || '—'}</td></tr>` +
      `<tr><td style="padding:8px 0; border-bottom:1px solid #eef0f2; color:#8b8fa3;">Aktueller Bestand</td>` +
      `<td style="padding:8px 0; border-bottom:1px solid #eef0f2; text-align:right; color:#ef4444; font-weight:700;">${vars.currentStock ?? '—'}</td></tr>` +
      `<tr><td style="padding:8px 0; color:#8b8fa3;">Mindestbestand</td>` +
      `<td style="padding:8px 0; text-align:right;">${vars.minStock ?? '—'}</td></tr>` +
      `</table>` +
      `<p style="font-size:13px; color:#8b8fa3;">Bitte prüfe die Nachbestellung für dieses Produkt.</p>`,
      { preheader: `${vars.productName || 'Produkt'}: Bestand niedrig` }
    ),
  }),
};

/**
 * Render a named email template.
 *
 * @param {string} templateName - e.g. 'password-reset', 'user-invitation'
 * @param {Object} vars - Template variables
 * @returns {{ subject: string, text: string, html: string }}
 */
function renderEmail(templateName, vars = {}) {
  const templateFn = templates[templateName];
  if (!templateFn) {
    throw new Error(`Unknown email template: "${templateName}"`);
  }
  return templateFn(vars);
}

/**
 * List all available template names.
 */
function listTemplates() {
  return Object.keys(templates).map((name) => ({
    name,
    subject: templates[name]({}).subject,
  }));
}

module.exports = {
  renderEmail,
  listTemplates,
  baseLayout,
};
