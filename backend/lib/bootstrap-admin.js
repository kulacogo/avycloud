const { getAdminAuth } = require('./firebaseAdmin');
const { upsertUserProfile } = require('./rbac');
const { sendMail } = require('./mailer');

const DEFAULT_BOOTSTRAP_ADMIN_EMAIL = 'admin@trendocean.de';
const DEFAULT_CONTINUE_URL = 'https://avycloud.web.app/#/dashboard';

const getBootstrapEmail = () =>
  (process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL || DEFAULT_BOOTSTRAP_ADMIN_EMAIL).trim().toLowerCase();

const getContinueUrl = () => process.env.AUTH_ACTION_CONTINUE_URL || DEFAULT_CONTINUE_URL;

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
    const resetLink = await auth.generatePasswordResetLink(email, actionCodeSettings);
    const verifyLink = await auth.generateEmailVerificationLink(email, actionCodeSettings);

    await sendMail({
      to: email,
      subject: 'AvyCloud Admin – initialer Zugang',
      text:
        `Hallo,\n\n` +
        `der initiale AvyCloud Admin wurde angelegt.\n\n` +
        `1) Passwort setzen:\n${resetLink}\n\n` +
        `2) E-Mail bestätigen (optional für Admin, empfohlen):\n${verifyLink}\n\n`,
      html:
        `<p>Hallo,</p>` +
        `<p>der initiale <strong>AvyCloud Admin</strong> wurde angelegt.</p>` +
        `<ol>` +
        `<li><p><strong>Passwort setzen</strong>:<br/><a href="${resetLink}">${resetLink}</a></p></li>` +
        `<li><p><strong>E-Mail bestätigen</strong> (optional für Admin, empfohlen):<br/><a href="${verifyLink}">${verifyLink}</a></p></li>` +
        `</ol>`,
    });
  }

  return { uid: userRecord.uid, email, created };
}

module.exports = {
  ensureBootstrapAdmin,
};

