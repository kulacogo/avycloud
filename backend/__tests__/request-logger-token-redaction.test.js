'use strict';

/**
 * SECURITY-Guard: SSE-JWT darf nie im Klartext ins Log.
 *
 * SSE authentifiziert per ?token=<jwt> (EventSource kann keinen Header setzen);
 * index.js kopiert den Token in den Authorization-Header. Ohne Redaction landet
 * beides in Cloud Logging → bis 1h gültige Impersonation für jeden mit
 * Log-Leserecht. reqSerializer maskiert URL-Query-Token + Auth/Cookie-Header.
 */

const { redactUrlToken, reqSerializer } = require('../lib/request-logger');

describe('redactUrlToken', () => {
  it('maskiert token in der Query, lässt den Rest intakt', () => {
    expect(redactUrlToken('/api/events?token=eyJabc.def.ghi'))
      .toBe('/api/events?token=[REDACTED]');
  });

  it('maskiert token auch mitten in der Query (& davor)', () => {
    expect(redactUrlToken('/api/events?foo=1&token=SECRETJWT&bar=2'))
      .toBe('/api/events?foo=1&token=[REDACTED]&bar=2');
  });

  it('lässt URLs ohne token unverändert', () => {
    expect(redactUrlToken('/api/products?limit=50')).toBe('/api/products?limit=50');
  });

  it('robust gegen non-string', () => {
    expect(redactUrlToken(undefined)).toBe(undefined);
    expect(redactUrlToken(null)).toBe(null);
  });
});

describe('reqSerializer', () => {
  it('maskiert Query-Token UND Authorization/Cookie-Header', () => {
    const out = reqSerializer({
      method: 'GET',
      url: '/api/events?token=eyJsecret',
      headers: {
        authorization: 'Bearer eyJsecret',
        cookie: 'session=abc',
        'user-agent': 'test',
      },
      connection: {},
    });
    expect(out.url).toBe('/api/events?token=[REDACTED]');
    expect(out.headers.authorization).toBe('[REDACTED]');
    expect(out.headers.cookie).toBe('[REDACTED]');
    expect(out.headers['user-agent']).toBe('test'); // harmlose Header bleiben
  });
});
