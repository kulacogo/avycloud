const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Cloud Run erwartet severity-Feld für Log Explorer
  messageKey: 'message',
  formatters: {
    level(label) {
      const severityMap = { trace: 'DEBUG', debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR', fatal: 'CRITICAL' };
      return { severity: severityMap[label] || 'DEFAULT' };
    },
  },
});

module.exports = logger;
