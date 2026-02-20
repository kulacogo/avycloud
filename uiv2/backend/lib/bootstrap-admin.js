const { getAdminAuth } = require('./firebaseAdmin');
const { upsertUserProfile } = require('./rbac');
const { sendMail } = require('./mailer');
const { rewriteActionLinkApiKey } = require('./firebase-web-api-key');

const DEFAULT_BOOTSTRAP_ADMIN_EMAIL = 'admin@trendocean.de';
// Avoid hash-based routes here; some Firebase configurations reject URLs with fragments.
const DEFAULT_CONTINUE_URL = 'https://avycloud.web.app/';

const getBootstrapEmail = () =>
  (process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL || DEFAULT_BOOTSTRAP_ADMIN_EMAIL).trim().toLowerCase();

const getContinueUrl = () => process.env.AUTH_ACTION_CONTINUE_URL || DEFAULT_CONTINUE_URL;

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

async function ensureBootstrapAdmin() {
  const email = getBootstrapEmail();
  const auth = getAdminAuth();

  let userRecord;
  let created = false;
  try {
    userRecord = await auth.getUserByEmail(email);
  } catch (e) {
    userRecord = null;
  }

  if (!userRecord) {
    userRecord = await auth.createUser({
      email,
      emailVerified: false,
      disabled: false,
    });
    created = true;
  }

  // Ensure RBAC profile exists (roles are stored in Firestore; bootstrap admin also bypasses via email).
  await upsertUserProfile(userRecord.uid, {
    uid: userRecord.uid,
    email,
    roles: ['admin'],
    disabled: false,
  });

  // If we just created the admin user, send a one-time reset + verify email to bootstrap access.
  if (created) {
    const actionCodeSettings = { url: getContinueUrl(), handleCodeInApp: false };
    const resetLink = await rewriteActionLinkApiKey(await auth.generatePasswordResetLink(email, actionCodeSettings));
    const verifyLink = await rewriteActionLinkApiKey(await auth.generateEmailVerificationLink(email, actionCodeSettings));
    const appResetLink = buildAppPasswordResetUrl(resetLink);

    await sendMail({
      to: email,
      subject: 'AvyCloud Admin – initialer Zugang',
      text:
        `Hallo,\n\n` +
        `der initiale AvyCloud Admin wurde angelegt.\n\n` +
        `1) Passwort setzen:\n${appResetLink}\n\n` +
        `2) E-Mail bestätigen (optional für Admin, empfohlen):\n${verifyLink}\n\n`,
      html:
        `<p>Hallo,</p>` +
        `<p>der initiale <strong>AvyCloud Admin</strong> wurde angelegt.</p>` +
        `<ol>` +
        `<li><p><strong>Passwort setzen</strong>:<br/><a href="${appResetLink}">${appResetLink}</a></p></li>` +
        `<li><p><strong>E-Mail bestätigen</strong> (optional für Admin, empfohlen):<br/><a href="${verifyLink}">${verifyLink}</a></p></li>` +
        `</ol>`,
    });
  }

  return { uid: userRecord.uid, email, created };
}

module.exports = {
  ensureBootstrapAdmin,
};

