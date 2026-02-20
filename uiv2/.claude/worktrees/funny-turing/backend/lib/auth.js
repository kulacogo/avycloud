const { getAdminAuth } = require('./firebaseAdmin');

const DEFAULT_ALLOWED_DOMAIN = 'trendocean.de';
const DEFAULT_BOOTSTRAP_ADMIN_EMAIL = 'admin@trendocean.de';

const getAllowedDomain = () => (process.env.AUTH_ALLOWED_EMAIL_DOMAIN || DEFAULT_ALLOWED_DOMAIN).trim().toLowerCase();
const getBootstrapAdminEmail = () =>
  (process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL || DEFAULT_BOOTSTRAP_ADMIN_EMAIL).trim().toLowerCase();

function extractBearerToken(req) {
  const header = req.header('authorization') || req.header('Authorization') || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function isAllowedEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  const domain = getAllowedDomain();
  return value.endsWith(`@${domain}`);
}

function isBootstrapAdmin(email) {
  const value = String(email || '').trim().toLowerCase();
  return value === getBootstrapAdminEmail();
}

async function verifyRequestUser(req) {
  const idToken = extractBearerToken(req);
  if (!idToken) {
    const err = new Error('Missing Authorization bearer token');
    err.statusCode = 401;
    throw err;
  }

  const auth = getAdminAuth();
  const decoded = await auth.verifyIdToken(idToken, true);

  const email = decoded.email || null;
  if (!email || !isAllowedEmail(email)) {
    const err = new Error('Forbidden: email domain not allowed');
    err.statusCode = 403;
    throw err;
  }

  const admin = isBootstrapAdmin(email);
  const emailVerified = Boolean(decoded.email_verified);

  if (!admin && !emailVerified) {
    const err = new Error('Forbidden: email not verified');
    err.statusCode = 403;
    throw err;
  }

  return {
    uid: decoded.uid,
    email,
    isAdmin: admin,
    emailVerified,
    claims: decoded,
  };
}

function requireAuth(req, res, next) {
  // Let CORS preflight through.
  if (req.method === 'OPTIONS') return next();

  verifyRequestUser(req)
    .then((user) => {
      req.user = user;
      next();
    })
    .catch((error) => {
      const code = error?.statusCode || 401;
      res.status(code).json({
        ok: false,
        error: {
          code,
          message: error?.message || 'Unauthorized',
        },
      });
    });
}

module.exports = {
  requireAuth,
  verifyRequestUser,
  isAllowedEmail,
  isBootstrapAdmin,
};

