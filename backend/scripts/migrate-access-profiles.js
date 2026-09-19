#!/usr/bin/env node
'use strict';

// Stage BEFORE deploying the new policy. Old code ignores the additive accessRole
// field; original role arrays/docs remain intact for a controlled code rollback.
const { ACCESS_POLICY_VERSION, validateRoleAssignment } = require('../lib/access-profiles');
const MIGRATION_ID = 'default_access_profiles_v1';
const ASSIGNMENTS = [
  ['T2mOTT0me6YLFfxPIEF9aJRHH6X2', 'admin@trendocean.de', 'admin'],
  ['dEO0ABrjyFQe3hPNDk52U8secxv2', 'efe.dak@trendocean.de', 'manager'],
  ['OWFsImqAFcU2Zvix35Ibhg2kDhq1', 'yasemin.kulacoglu@trendocean.de', 'manager'],
  ['Qf1D7xvgpYWRZwQhySHV2DzNTdF3', 'huseyin.kisaoglu@trendocean.de', 'employee'],
  ['hH1sBc9liIbB7J4lLqsluqwrHnq1', 'semih.oekten@trendocean.de', 'employee'],
  ['mNxanMy3LmN9cF7fBkVd7kASVN43', 'fatih.ozsumbul@trendocean.de', 'partner'],
  ['1tpPYAUA4Gd6PfBXMbUZfACTgKC3', 'selahattin.tatma@trendocean.de', 'partner'],
  ['jts1XUNoDvSDkcIZRNDpGO5w24r1', 'operation@trendocean.de', 'developer'],
  ['BTiU8QjGmWUf0mfX8LJsHSYpyGY2', 'support@trendocean.de', 'viewer', true],
];

function buildPlan(profiles) {
  const byId = new Map(profiles.map(profile => [profile.id, profile]));
  const known = new Set(ASSIGNMENTS.map(([id]) => id));
  if (profiles.some(profile => !known.has(profile.id))) throw new Error('Unbekanntes Konto: Zuordnung zuerst prüfen.');
  return ASSIGNMENTS.map(([id, email, accessRole, disable]) => {
    const profile = byId.get(id);
    if (!profile || profile.email?.toLowerCase() !== email) throw new Error(`Identität stimmt nicht: ${id}`);
    if ((profile.tenantId || 'default') !== 'default') throw new Error(`Fremder Tenant: ${id}`);
    validateRoleAssignment([accessRole], email === 'admin@trendocean.de');
    return { id, email, before: profile.accessRole || null, patch: {
      tenantId: 'default', accessRole, accessPolicyVersion: ACCESS_POLICY_VERSION,
      ...(disable ? { disabled: true } : {}),
    } };
  });
}

async function migrate({ db, apply = false }) {
  // Known legacy records are read by verified IDs; no unscoped collection scan.
  const refs = ASSIGNMENTS.map(([id]) => db.collection('users').doc(id));
  const scoped = await db.collection('users').where('tenantId', '==', 'default').get();
  const known = new Set(ASSIGNMENTS.map(([id]) => id));
  if (scoped.docs.some(doc => !known.has(doc.id))) throw new Error('Neues Konto im Tenant: Migrationsplan zuerst ergänzen.');
  const docs = await db.getAll(...refs);
  const profiles = docs.map(doc => ({ ...doc.data(), id: doc.id }));
  const plan = buildPlan(profiles);
  if (!apply) return { mode: 'dry-run', plan };
  const backupRef = db.collection('access_profile_migrations').doc(MIGRATION_ID);
  return db.runTransaction(async tx => {
    const [backup, ...current] = await tx.getAll(backupRef, ...refs);
    if (backup.exists) return { mode: 'already-applied', migrationId: MIGRATION_ID };
    const freshProfiles = current.map(doc => ({ ...doc.data(), id: doc.id }));
    const freshPlan = buildPlan(freshProfiles);
    // Backup and all assignments commit together. No deleted fields/documents.
    tx.create(backupRef, { tenantId: 'default', policyVersion: ACCESS_POLICY_VERSION,
      createdAt: new Date().toISOString(), previousProfiles: freshProfiles, assignments: freshPlan });
    for (const item of freshPlan) tx.set(db.collection('users').doc(item.id), { ...item.patch, updatedAt: new Date().toISOString() }, { merge: true });
    return { mode: 'applied', migrationId: MIGRATION_ID, plan: freshPlan };
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = flag => args[args.indexOf(flag) + 1];
  const projectId = args.includes('--project') ? get('--project') : null;
  const apply = args.includes('--apply');
  if (!projectId || (apply && get('--confirm') !== 'ACCESS_PROFILES_V1')) {
    console.error('Usage: node scripts/migrate-access-profiles.js --project <project> [--apply --confirm ACCESS_PROFILES_V1]');
    process.exitCode = 1;
  } else {
    const { Firestore } = require('@google-cloud/firestore');
    migrate({ db: new Firestore({ projectId }), apply }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
module.exports = { ASSIGNMENTS, buildPlan, migrate };
