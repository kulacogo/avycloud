const pinoHttp = require('pino-http');
const pino = require('pino');
const logger = require('./logger');

// SECURITY: SSE authentifiziert sich per ?token=<firebase-jwt> in der URL
// (EventSource kann keinen Authorization-Header setzen), und die Bridge in
// index.js kopiert diesen Token in den Authorization-Header. Ohne Redaction
// landet beides im Klartext in Cloud Logging — bis zu 1h gültige Tokens für
// jeden mit Log-Leserecht (bei jedem SSE-Reconnect erneut). Deshalb: Token in
// URL-Query UND Authorization/Cookie-Header vor dem Logging maskieren.
function redactUrlToken(url) {
  if (typeof url !== 'string') return url;
  return url.replace(/([?&]token=)[^&]*/gi, '$1[REDACTED]');
}

function reqSerializer(req) {
  const s = pino.stdSerializers.req(req);
  if (s && typeof s.url === 'string') s.url = redactUrlToken(s.url);
  if (s && s.headers) {
    if (s.headers.authorization) s.headers.authorization = '[REDACTED]';
    if (s.headers.cookie) s.headers.cookie = '[REDACTED]';
  }
  return s;
}

const requestLogger = pinoHttp({
  logger,
  serializers: { req: reqSerializer },
  autoLogging: {
    ignore: (req) => req.url === '/health' || req.url === '/ready',
  },
  customLogLevel: (req, res, err) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
});

module.exports = requestLogger;
module.exports.redactUrlToken = redactUrlToken;
module.exports.reqSerializer = reqSerializer;
