const { getAdminAuth } = require('../lib/firebaseAdmin');
const { sendMail } = require('../lib/mailer');
const { renderEmail } = require('../lib/email-templates');
const { isAllowedEmail } = require('../lib/auth');
const { rewriteActionLinkApiKey } = require('../lib/firebase-web-api-key');
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

// Avoid hash-based routes here; some Firebase configurations reject URLs with fragments.
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
  const resetLink = await rewriteActionLinkApiKey(
    await auth.generatePasswordResetLink(normalizedEmail, actionCodeSettings)
  );
  const verifyLink = await rewriteActionLinkApiKey(
    await auth.generateEmailVerificationLink(normalizedEmail, actionCodeSettings)
  );

  const appResetLink = buildAppPasswordResetUrl(resetLink);

  const inviteEmail = renderEmail('user-invitation', { resetLink: appResetLink, verifyLink });
  await sendMail({ to: normalizedEmail, ...inviteEmail });

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

