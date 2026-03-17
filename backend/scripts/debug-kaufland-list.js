#!/usr/bin/env node
'use strict';
const { kauflandRequest } = require('../lib/kaufland-api');

async function main() {
  // Test formats for ts_created_from_iso
  const now = new Date();
  const from14 = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const formats = [
    from14.toISOString(),                          // 2026-03-03T11:36:00.000Z
    from14.toISOString().replace(/\.\d{3}Z$/, 'Z'), // 2026-03-03T11:36:00Z
    from14.toISOString().replace(/\.\d{3}Z$/, '+00:00'), // RFC3339 with offset
    Math.floor(from14.getTime() / 1000).toString(), // Unix timestamp
    from14.toISOString().slice(0, 10),             // 2026-03-03
  ];

  for (const fmt of formats) {
    try {
      const r = await kauflandRequest('GET', '/orders', { query: { limit: 1, ts_created_from_iso: fmt } });
      console.log('OK   fmt:', fmt, '| total:', r?.data?.pagination?.total);
    } catch (err) {
      console.log('FAIL fmt:', fmt, '| error:', err.message);
    }
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
