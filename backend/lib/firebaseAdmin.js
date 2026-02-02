const admin = require('firebase-admin');

let initialized = false;

function getProjectId() {
  return (
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.FIREBASE_PROJECT_ID ||
    'avycloud'
  )
    .toString()
    .trim();
}

function initIfNeeded() {
  if (initialized) return;
  if (admin.apps && admin.apps.length) {
    initialized = true;
    return;
  }
  // Uses Application Default Credentials (recommended for Cloud Run).
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: getProjectId(),
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

