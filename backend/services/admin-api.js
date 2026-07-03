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
  setUserProfileFields,
  deleteUserProfile,
  canDeleteUserAccount,
  countAdmins,
  getUserProfile,
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

/** Set a user's display name (Vorname/Nachname/Benutzername) — admin action. */
async function setUserProfile({ actorUid, targetUid, firstName, lastName, username }) {
  if (!targetUid) {
    const err = new Error('Kein Konto angegeben');
    err.statusCode = 400;
    throw err;
  }
  const patch = await setUserProfileFields({ actorUid, targetUid, firstName, lastName, username });
  return { uid: String(targetUid), ...patch };
}

/**
 * Delete a user account (Firebase Auth + Firestore profile). Refuses to delete
 * yourself or the last admin.
 */
async function deleteUserAccount({ actorUid, targetUid }) {
  const target = await getUserProfile(String(targetUid));
  const targetIsAdmin = Array.isArray(target?.roles)
    && target.roles.map((r) => String(r).toLowerCase()).includes('admin');
  const adminCount = await countAdmins();

  const check = canDeleteUserAccount({ actorUid, targetUid, targetIsAdmin, adminCount });
  if (!check.ok) {
    const messages = {
      self: 'Du kannst dein eigenes Konto nicht löschen',
      last_admin: 'Der letzte Administrator kann nicht gelöscht werden',
      missing_target: 'Kein Konto angegeben',
    };
    const err = new Error(messages[check.reason] || 'Löschen nicht erlaubt');
    err.statusCode = 400;
    throw err;
  }

  // Firebase Auth deletion (best-effort — the profile may exist without an auth user).
  try {
    await getAdminAuth().deleteUser(String(targetUid));
  } catch (e) {
    if (e?.code !== 'auth/user-not-found') throw e;
  }
  await deleteUserProfile(String(targetUid));
  return { uid: String(targetUid), deleted: true };
}

module.exports = {
  inviteUser,
  listUsers,
  setUserRoles,
  setUserGroups,
  setUserOverrides,
  setUserProfile,
  deleteUserAccount,
  listRoles,
  updateRole,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
};

