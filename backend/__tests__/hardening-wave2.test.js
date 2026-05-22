/**
 * Hardening Wave 2 — Eventing + Recovery
 *
 * Verifies:
 *  - sync-bus debounce is per-tenant (not global anymore)
 *  - pollDeliveryStatus uses transitionOrder + emits order:status_changed
 *  - stock-failure-drain emits terminal-state alerts
 *
 * Source-contract tests: robust under CommonJS test isolation.
 */

'use strict';

const fs = require('fs');
const path = require('path');

describe('HARDEN Wave 2: sync-bus per-tenant debounce', () => {
  it('sync-event-bus uses Map<tenantId, Timer> instead of single global timer', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', 'services', 'sync-event-bus.js'),
      'utf8'
    );

    // Old pattern: `let _marketplaceSyncTimer = null;` — gone.
    expect(source).not.toMatch(/let\s+_marketplaceSyncTimer\s*=\s*null/);
    expect(source).not.toMatch(/let\s+_returnSyncTimer\s*=\s*null/);
    expect(source).not.toMatch(/let\s+_sendCloudSyncTimer\s*=\s*null/);

    // New pattern: per-tenant Map.
    expect(source).toMatch(/const\s+_marketplaceSyncTimers\s*=\s*new\s+Map/);
    expect(source).toMatch(/const\s+_returnSyncTimers\s*=\s*new\s+Map/);
    expect(source).toMatch(/const\s+_sendCloudSyncTimers\s*=\s*new\s+Map/);

    // Must reference `tenantId` in the timer logic (sanity).
    expect(source).toMatch(/tenant=\$\{tenant\}/);
  });
});

describe('HARDEN Wave 2: pollDeliveryStatus via transitionOrder', () => {
  it('shipping-engine.pollDeliveryStatus calls transitionOrder + emits order:status_changed', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', 'services', 'shipping-engine.js'),
      'utf8'
    );

    // Locate the pollDeliveryStatus function body.
    const pollMatch = source.match(/async function pollDeliveryStatus[\s\S]+?\n\}\n/);
    expect(pollMatch).not.toBeNull();
    const pollBody = pollMatch[0];

    // Must use transitionOrder for shipped -> delivered.
    expect(pollBody).toMatch(/transitionOrder\s*\(/);
    expect(pollBody).toMatch(/toStatus:\s*['"]delivered['"]/);

    // Must emit sync event so downstream listeners react.
    expect(pollBody).toMatch(/emitSyncEvent\s*\(\s*['"]order:status_changed['"]/);

    // Fallback direct-set path must include audit log (no silent state).
    expect(pollBody).toMatch(/fallback direct-set/i);
  });
});

describe('HARDEN Wave 2: stock-failure-drain terminal alerts', () => {
  it('drain calls _emitTerminalAlert on needs_manual + abandoned', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', 'services', 'stock-failure-drain.js'),
      'utf8'
    );

    // Function exists.
    expect(source).toMatch(/async function _emitTerminalAlert/);
    // Called on needs_manual path.
    expect(source).toMatch(/needsManual\s*\+=\s*1[\s\S]{0,400}_emitTerminalAlert/);
    // Called on abandoned path.
    expect(source).toMatch(/abandoned\s*\+=\s*1[\s\S]{0,400}_emitTerminalAlert/);
    // Writes audit doc to stock_failure_alerts.
    expect(source).toMatch(/stock_failure_alerts/);
    // Uses SLACK_ALERTS_URL env var.
    expect(source).toMatch(/SLACK_ALERTS_URL/);
  });
});
