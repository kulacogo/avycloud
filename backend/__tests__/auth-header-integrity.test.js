'use strict';

/**
 * DEPLOY-GATE-GUARD gegen Total-Auth-Ausfall (Incident 2026-07-08).
 *
 * Ursache damals: der Request-Logger-Serializer mutierte req.headers PER
 * REFERENZ und überschrieb den echten Authorization-Header auf '[REDACTED]',
 * sodass extractBearerToken() ihn nicht mehr fand → JEDE authentifizierte
 * Anfrage 401 "Missing Authorization bearer token". 2867 Unit-Tests waren
 * grün — kein Test prüfte die ECHTE Middleware-Kette mit einem echten
 * Bearer-Header.
 *
 * Invariante, die dieser Test für IMMER festnagelt: KEINE Middleware in der
 * Anfrage-Kette (insbesondere kein Logger-Serializer) darf den
 * Authorization-Header verändern, den nachgelagerte Auth-Middleware liest.
 * Dieser Test läuft im `npm test`-Deploy-Gate — bricht der Header, bricht der
 * Build, und der Fehler geht NIE wieder live.
 */

const request = require('supertest');
const express = require('express');

// Der ECHTE Request-Logger (die Stelle, die den Header zerstört hatte).
const requestLogger = require('../lib/request-logger');

function buildAppWithRealLogger() {
  const app = express();
  app.use(requestLogger);
  // Repliziert exakt, was die echte Auth-Middleware liest (auth.js
  // extractBearerToken: req.header('authorization')).
  app.get('/echo-auth', (req, res) => {
    res.json({
      authorization: req.header('authorization') || null,
      cookie: req.header('cookie') || null,
      isBearer: /^Bearer\s+\S+$/i.test(req.header('authorization') || ''),
    });
  });
  return app;
}

describe('Auth-Header-Integrität durch die echte Middleware-Kette', () => {
  it('Bearer-Token überlebt den Request-Logger UNVERÄNDERT (Kern-Regression 2026-07-08)', async () => {
    const app = buildAppWithRealLogger();
    const token = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.PAYLOAD.SIGNATURE';

    const res = await request(app)
      .get('/echo-auth')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    // Der Header, den die Auth-Middleware liest, MUSS unversehrt sein:
    expect(res.body.authorization).toBe(`Bearer ${token}`);
    expect(res.body.authorization).not.toBe('[REDACTED]');
    expect(res.body.isBearer).toBe(true);
  });

  it('auch der Cookie-Header bleibt für nachgelagerte Middleware intakt', async () => {
    const app = buildAppWithRealLogger();
    const res = await request(app)
      .get('/echo-auth')
      .set('Authorization', 'Bearer abc.def.ghi')
      .set('Cookie', 'session=supersecret');

    expect(res.body.cookie).toContain('session=supersecret');
    expect(res.body.cookie).not.toBe('[REDACTED]');
  });

  it('mehrere aufeinanderfolgende Anfragen korrumpieren den Header nicht (keine geteilte Mutation)', async () => {
    const app = buildAppWithRealLogger();
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .get('/echo-auth')
        .set('Authorization', `Bearer token-${i}`);
      expect(res.body.authorization).toBe(`Bearer token-${i}`);
    }
  });
});
