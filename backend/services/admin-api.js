const { getAdminAuth } = require('../lib/firebaseAdmin');
const { sendMail } = require('../lib/mailer');
const { isAllowedEmail } = require('../lib/auth');
const {
  listUsers,
  setUserRoles,
  setUserGroups,
  setUserOverrides,
  listRoles,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  updateRole,
  upsertUserProfile,
} = require('../lib/rbac');
const { FieldValue } = require('@google-cloud/firestore');

const DEFAULT_CONTINUE_URL = 'https://avycloud.web.app/#/dashboard';

const getContinueUrl = () => process.env.AUTH_ACTION_CONTINUE_URL || DEFAULT_CONTINUE_URL;

const buildActionCodeSettings = () => ({
  url: getContinueUrl(),
  handleCodeInApp: false,
});

async function inviteUser({ actorUid, email, roles }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!isAllowedEmail(normalizedEmail)) {
    const err = new Error('Only @trendocean.de emails are allowed');
    err.statusCode = 400;
    throw err;
  }

  const auth = getAdminAuth();

  // Create (or fetch) firebase user
  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(normalizedEmail);
  } catch (e) {
    userRecord = null;
  }
  if (!userRecord) {
    userRecord = await auth.createUser({
      email: normalizedEmail,
      emailVerified: false,
      disabled: false,
    });
  }

  // Persist user profile + roles in Firestore
  await upsertUserProfile(userRecord.uid, {
    uid: userRecord.uid,
    email: normalizedEmail,
    disabled: false,
    roles: Array.isArray(roles) && roles.length ? roles : [],
    createdAt: FieldValue.serverTimestamp(),
    lastLoginAt: null,
  });

  if (Array.isArray(roles) && roles.length) {
    await setUserRoles({ actorUid, targetUid: userRecord.uid, roles });
  }

  const actionCodeSettings = buildActionCodeSettings();
  const resetLink = await auth.generatePasswordResetLink(normalizedEmail, actionCodeSettings);
  const verifyLink = await auth.generateEmailVerificationLink(normalizedEmail, actionCodeSettings);

  await sendMail({
    to: normalizedEmail,
    subject: 'AvyCloud Zugang – Passwort setzen & E-Mail bestätigen',
    text:
      `Hallo,\n\n` +
      `du wurdest für AvyCloud freigeschaltet.\n\n` +
      `1) Passwort setzen:\n${resetLink}\n\n` +
      `2) E-Mail bestätigen (Pflicht):\n${verifyLink}\n\n` +
      `Danach kannst du dich mit deiner @trendocean.de Adresse anmelden.\n`,
    html:
      `<p>Hallo,</p>` +
      `<p>du wurdest für <strong>AvyCloud</strong> freigeschaltet.</p>` +
      `<ol>` +
      `<li><p><strong>Passwort setzen</strong>:<br/><a href="${resetLink}">${resetLink}</a></p></li>` +
      `<li><p><strong>E-Mail bestätigen (Pflicht)</strong>:<br/><a href="${verifyLink}">${verifyLink}</a></p></li>` +
      `</ol>` +
      `<p>Danach kannst du dich mit deiner <code>@trendocean.de</code> Adresse anmelden.</p>`,
  });

  return { uid: userRecord.uid, email: normalizedEmail, resetLink, verifyLink };
}

module.exports = {
  inviteUser,
  listUsers,
  setUserRoles,
  setUserGroups,
  setUserOverrides,
  listRoles,
  updateRole,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
};

