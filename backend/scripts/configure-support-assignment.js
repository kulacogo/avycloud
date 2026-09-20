'use strict';

// Operator-confirmed sole responsibility, separate from user roles/permissions.
// Default is read-only. Existing conflicting assignments are never overwritten.
async function configureSupportAssignment({ db, tenantId, uid, apply = false, now = new Date() }) {
  if (!tenantId || tenantId.includes('/') || !uid || uid.includes('/')) throw Error('Valid tenant and UID required');
  const user = await db.collection('users').doc(uid).get();
  if (!user.exists || user.data()?.tenantId !== tenantId || user.data()?.disabled === true) throw Error('Active user in this tenant required');
  const ref = db.collection('support_assignments').doc(tenantId);
  const existing = await ref.get();
  if (existing.exists) {
    const current = existing.data();
    if (current.tenantId !== tenantId || current.responsibleUid !== uid || current.exclusive !== true) throw Error('Existing assignment differs; no overwrite performed');
    return { status: 'unchanged', tenantId, uid };
  }
  const data = { tenantId, responsibleUid: uid, exclusive: true, channels: ['kaufland', 'ebay'], confirmation: 'explicit_owner_instruction', confirmedAt: now.toISOString() };
  if (apply) await ref.create(data);
  return { status: apply ? 'created' : 'dry-run', data };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = (key) => args[args.indexOf(key) + 1];
  if (!args.includes('--tenant') || !args.includes('--uid')) {
    console.error('Usage: node scripts/configure-support-assignment.js --tenant <tenant> --uid <uid> [--apply]');
    process.exitCode = 1;
  } else {
    const { Firestore } = require('@google-cloud/firestore');
    const db = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud' });
    configureSupportAssignment({ db, tenantId: value('--tenant'), uid: value('--uid'), apply: args.includes('--apply') })
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error) => { console.error(error.message); process.exitCode = 1; })
      .finally(() => db.terminate());
  }
}
module.exports = { configureSupportAssignment };
