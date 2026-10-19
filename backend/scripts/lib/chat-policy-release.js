'use strict';

// Operator-only release helper. No SDK initialization, network or writes on import.
const { createHash } = require('node:crypto');

function canonical(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.toMillis === 'function' && Number.isInteger(value.seconds)) {
    return { $timestamp: [value.seconds, value.nanoseconds] };
  }
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Buffer.isBuffer(value)) return { $bytes: value.toString('base64') };
  if (Array.isArray(value)) return value.map(canonical);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error('Unsupported configuration value');
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function validatePlan(plan) {
  if (plan?.scopeId !== 'chat.product' || !/^[a-f0-9]{40}$/.test(plan.releaseSha || '')) {
    throw new Error('Exact chat.product release SHA required');
  }
  for (const key of ['versionId', 'parentVersionId']) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(plan[key] || '')) throw new Error(`Invalid ${key}`);
  }
  if (plan.versionId === plan.parentVersionId) throw new Error('Version must be a new child');
  for (const key of ['scopeHash', 'scopeConfigurationHash', 'parentHash']) {
    if (!/^[a-f0-9]{64}$/.test(plan[key] || '')) throw new Error(`Missing ${key}`);
  }
  if (plan.requestPolicyVersion !== 'chat-request-2026-10-11-v1') throw new Error('Wrong request policy');
  if (!Object.keys(plan.sourceFiles || {}).length || Object.values(plan.sourceFiles).some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('Verified source hashes required');
  }
}

function scopeConfiguration(scope) {
  const { activeVersionId, updatedAt, activatedByUid, ...configuration } = scope;
  return configuration;
}

async function applyRelease({ firestore, plan, action, timestamp, actorUid }) {
  validatePlan(plan);
  if (!['register', 'activate', 'rollback'].includes(action)) throw new Error('Unknown release action');
  if (!actorUid || !timestamp) throw new Error('Release actor and timestamp required');
  const scopeRef = firestore.collection('llmScopes').doc(plan.scopeId);
  const parentRef = scopeRef.collection('versions').doc(plan.parentVersionId);
  const childRef = scopeRef.collection('versions').doc(plan.versionId);
  const release = {
    releaseSha: plan.releaseSha,
    requestPolicyVersion: plan.requestPolicyVersion,
    parentVersionId: plan.parentVersionId,
    parentHash: plan.parentHash,
    scopeConfigurationHash: plan.scopeConfigurationHash,
    sourceFiles: plan.sourceFiles,
  };
  return firestore.runTransaction(async (tx) => {
    const [scopeSnap, parentSnap, childSnap] = await Promise.all([tx.get(scopeRef), tx.get(parentRef), tx.get(childRef)]);
    if (!scopeSnap.exists || !parentSnap.exists) throw new Error('Scope or parent missing');
    const scope = scopeSnap.data();
    const parent = parentSnap.data();
    if (digest(parent) !== plan.parentHash) throw new Error('Parent changed');
    if (digest(scopeConfiguration(scope)) !== plan.scopeConfigurationHash) throw new Error('Scope configuration changed');
    if (action === 'register') {
      if (digest(scope) !== plan.scopeHash || scope.activeVersionId !== plan.parentVersionId) throw new Error('Scope changed');
      if (childSnap.exists) throw new Error('Immutable child already exists; inspect instead of overwriting');
      // Preserve every configuration field, including unknown future overrides.
      tx.create(childRef, {
        ...parent,
        note: `UX-36 ${plan.requestPolicyVersion}; release ${plan.releaseSha}; parent ${plan.parentVersionId}`,
        createdAt: timestamp,
        createdByUid: actorUid,
        compiledPolicyRelease: release,
      });
      return { action, versionId: plan.versionId, activeVersionId: scope.activeVersionId };
    }
    if (!childSnap.exists || digest(childSnap.data().compiledPolicyRelease) !== digest(release)) throw new Error('Registered release does not match');
    const child = childSnap.data();
    // The child may differ only in release metadata; admin settings must remain exact.
    const settings = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !['note', 'createdAt', 'createdByUid', 'compiledPolicyRelease'].includes(key)));
    if (digest(settings(child)) !== digest(settings(parent))) throw new Error('Child configuration changed');
    const expected = action === 'activate' ? plan.parentVersionId : plan.versionId;
    const target = action === 'activate' ? plan.versionId : plan.parentVersionId;
    if (scope.activeVersionId !== expected) throw new Error('Active version changed');
    tx.update(scopeRef, { activeVersionId: target, updatedAt: timestamp, activatedByUid: actorUid });
    return { action, versionId: plan.versionId, activeVersionId: target };
  });
}

module.exports = { applyRelease, digest, scopeConfiguration, validatePlan };
