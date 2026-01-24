const admin = require('firebase-admin');

let initialized = false;

function initIfNeeded() {
  if (initialized) return;
  if (admin.apps && admin.apps.length) {
    initialized = true;
    return;
  }
  // Uses Application Default Credentials (recommended for Cloud Run).
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
  initialized = true;
}

function getAdminAuth() {
  initIfNeeded();
  return admin.auth();
}

module.exports = {
  admin,
  getAdminAuth,
};

