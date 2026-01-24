const nodemailer = require('nodemailer');
const { getSecretValue } = require('./secret-values');

let transporter = null;

async function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST || 'smtp.strato.de';
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const secure = String(process.env.SMTP_SECURE || 'true') === 'true';
  const user = process.env.SMTP_FROM || 'admin@trendocean.de';
  const pass = await getSecretValue('Admin_Mail_Secret');

  if (!pass) {
    throw new Error('SMTP password missing (Secret Manager: Admin_Mail_Secret)');
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure, // true for 465
    auth: { user, pass },
  });

  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const from = process.env.SMTP_FROM || 'admin@trendocean.de';
  const t = await getTransporter();
  return await t.sendMail({
    from,
    to,
    subject,
    text,
    html,
  });
}

module.exports = {
  sendMail,
};

