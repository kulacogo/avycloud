'use strict';

/**
 * Shared safety guard for destructive operator scripts.
 *
 * Default behaviour is DRY RUN: the script must explicitly opt in to mutating
 * production data by passing `--apply`. This prevents an accidental invocation
 * (wrong terminal, shell history recall, copy-paste) from deleting or
 * overwriting Firestore / SevDesk data with no confirmation.
 *
 * Usage in a script:
 *   const { parseApplyArgs } = require('./_apply-guard');
 *   const { apply, tenant } = parseApplyArgs();
 *   ...
 *   if (apply) { await ref.delete(); }
 *   else { console.log('[DRY-RUN] would delete', id); }
 *
 * @param {string[]} [argv] - argument list (defaults to process.argv minus node + script).
 * @returns {{ apply: boolean, tenant: string, argv: string[] }}
 */
function parseApplyArgs(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const tIdx = argv.indexOf('--tenant');
  const tenant =
    tIdx >= 0 && argv[tIdx + 1] ? argv[tIdx + 1] : process.env.TENANT_ID || 'default';

  if (!apply) {
    console.log('============================================================');
    console.log(' DRY RUN — no data will be modified or deleted.');
    console.log(' Re-run with --apply to perform the changes for real.');
    console.log(` Tenant: ${tenant}`);
    console.log('============================================================');
  } else {
    console.log('************************************************************');
    console.log(` APPLY MODE — changes WILL be written. Tenant: ${tenant}`);
    console.log('************************************************************');
  }

  return { apply, tenant, argv };
}

module.exports = { parseApplyArgs };
