/**
 * Test-App-Helper für Integration-Tests.
 * Erstellt eine minimale Express-App ohne Background-Runner,
 * mit injiziertem Test-User (bypasses Firebase Auth).
 */
const express = require('express');
const { errorHandler } = require('../../lib/error-handler');

const TEST_USER = {
  uid: 'test-uid-001',
  email: 'admin@trendocean.de',
  isAdmin: true,
  emailVerified: true,
};

/**
 * Erstellt eine Test-Express-App die einen Router unter /api mounted.
 * Auth wird durch einen Test-User ersetzt — kein Firebase-Call.
 */
function createTestApp(router) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => {
    req.user = TEST_USER;
    next();
  });
  app.use('/api', router);
  app.use(errorHandler);
  return app;
}

module.exports = { createTestApp, TEST_USER };
