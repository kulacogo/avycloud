const { getAdminAuth } = require('../lib/firebaseAdmin');
const { sendMail } = require('../lib/mailer');
const { isAllowedEmail } = require('../lib/auth');
const { rewriteActionLinkApiKey } = require('../lib/firebase-web-api-key');

// ActionCodeSettings.url must be an allowed/authorized domain in Firebase Auth settings.
// Avoid hash-based routes here; some configurations reject URLs with fragments.
const DEFAULT_CONTINUE_URL = 'https://avycloud.web.app/';

const getContinueUrl = () => process.env.AUTH_ACTION_CONTINUE_URL || DEFAULT_CONTINUE_URL;

const buildActionCodeSettings = () => ({
  url: getContinueUrl(),
  handleCodeInApp: false,
});

const getWebBaseUrl = () => {
  const raw = String(getContinueUrl() || '').trim();
  const withoutHash = raw.split('#')[0];
  const withoutQuery = withoutHash.split('?')[0];
  return withoutQuery.replace(/\/+$/, '') || 'https://avycloud.web.app';
};

const buildAppPasswordResetUrl = (firebaseResetLink) => {
  try {
    const url = new URL(firebaseResetLink);
    const oobCode = url.searchParams.get('oobCode');
    if (!oobCode) return firebaseResetLink;
    return `${getWebBaseUrl()}/reset-password?oobCode=${encodeURIComponent(oobCode)}`;
  } catch {
    return firebaseResetLink;
  }
};

// Very small in-memory throttle to avoid hammering SMTP / action link generation.
// Note: This is best-effort only (Cloud Run instances are ephemeral).
const lastRequestByEmail = new Map(); // email -> ms
const lastRequestByIp = new Map(); // ip -> ms

const EMAIL_COOLDOWN_MS = 60_000; // 1/min per email
const IP_COOLDOWN_MS = 10_000; // 1/10s per IP

function nowMs() {
  return Date.now();
}

function throttleCheck(map, key, cooldownMs) {
  if (!key) return { ok: true };
  const prev = map.get(key);
  const now = nowMs();
  if (typeof prev === 'number' && now - prev < cooldownMs) {
    return { ok: false, retryAfterMs: cooldownMs - (now - prev) };
  }
  map.set(key, now);
  return { ok: true };
}

async function requestPasswordReset({ email, ip }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    const err = new Error('Email is required');
    err.statusCode = 400;
    throw err;
  }
  if (!isAllowedEmail(normalizedEmail)) {
    const err = new Error('Only @trendocean.de emails are allowed');
    err.statusCode = 400;
    throw err;
  }

  const ipKey = String(ip || '').trim();
  const ipThrottle = throttleCheck(lastRequestByIp, ipKey, IP_COOLDOWN_MS);
  if (!ipThrottle.ok) {
    const err = new Error('Too many requests. Please try again shortly.');
    err.statusCode = 429;
    throw err;
  }
  const emailThrottle = throttleCheck(lastRequestByEmail, normalizedEmail, EMAIL_COOLDOWN_MS);
  if (!emailThrottle.ok) {
    const err = new Error('Password reset already requested recently. Please check your inbox.');
    err.statusCode = 429;
    throw err;
  }

  const auth = getAdminAuth();
  const actionCodeSettings = buildActionCodeSettings();

  // Firebase Admin will throw if user does not exist.
  // For anti-enumeration we always return 200 on user-not-found, but do not send mail.
  let resetLink;
  try {
    resetLink = await auth.generatePasswordResetLink(normalizedEmail, actionCodeSettings);
    resetLink = await rewriteActionLinkApiKey(resetLink);
  } catch (error) {
    const code = String(error?.code || '');
    if (code.includes('auth/user-not-found')) {
      return { ok: true, sent: false };
    }
    // Log details server-side for debugging; do not leak internals to client.
    console.error('Password reset link generation failed:', {
      code: error?.code,
      message: error?.message,
      errorInfo: error?.errorInfo,
    });
    throw error;
  }

  await sendMail({
    to: normalizedEmail,
    subject: 'AvyCloud – Passwort zurücksetzen',
    text:
      `Hallo,\n\n` +
      `du hast einen Passwort-Reset für AvyCloud angefordert.\n\n` +
      `Passwort zurücksetzen:\n${buildAppPasswordResetUrl(resetLink)}\n\n` +
      `Falls du das nicht warst, ignoriere diese E-Mail.\n`,
    html:
      `<p>Hallo,</p>` +
      `<p>du hast einen Passwort-Reset für <strong>AvyCloud</strong> angefordert.</p>` +
      `<p><strong>Passwort zurücksetzen</strong>:<br/><a href="${buildAppPasswordResetUrl(resetLink)}">${buildAppPasswordResetUrl(
        resetLink
      )}</a></p>` +
      `<p>Falls du das nicht warst, ignoriere diese E-Mail.</p>`,
  });

  return { ok: true, sent: true };
}

module.exports = {
  requestPasswordReset,
};

