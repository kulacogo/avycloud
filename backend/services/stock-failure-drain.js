/**
 * Stock-Failure-Drain — periodischer Retry von fehlgeschlagenen Marketplace-Syncs.
 *
 * Kontext: _onOrderShipped() in order-state-machine.js persistiert bei Phase-B-Failure
 * ein Dokument in `stock_operation_failures`. Ohne Drain bleibt diese Collection nur
 * "Write-Only" und erzeugt Oversell-Regressionen (Incident SKU-9871561937, 2026-04-23).
 *
 * Dieser Worker liest pro Tenant pending Failures und retried jede `step: 'marketplaceSync'`-
 * Position via syncStockWithRetry. Dabei wird die Channel-Logik (EndItem bei qty=0 eBay,
 * ONHOLD bei qty=0 Kaufland) vom bestehenden Dispatcher wiederverwendet — keine Duplikation.
 *
 * Sicherheits-Entscheidung: `step: 'decrement'` wird NICHT retried. Grund: ein erneutes
 * `decrementProductByIdOrSku` koennte bei partiellem Initial-Erfolg Items doppelt
 * dekrementieren. Solche Failures werden als `needs_manual` markiert und via Alerting
 * eskaliert (P4.3).
 *
 * Siehe CLAUDE.md Punkt 10 (Oversell-Verbot) und Plan P2.1.
 */

'use strict';

const { computeNextRetryAt } = require('../lib/retry-backoff');

const MAX_ATTEMPTS = 5;

// ── Quota-aware Retries (2026-08-26, gehaertet nach 8-Winkel-Review) ─────────
// Waehrend das eBay-Tageskontingent erschoepft ist ("exceeded usage limit"),
// kann KEIN Retry gelingen. Vorher verbrannte der Drain alle 5 Versuche
// (~18 min Abstand ≈ 90 min) innerhalb der stundenlangen Sperre und gab
// endgueltig auf — gemessen 378 abandoned Docs, darunter Zero-Stock-ENDs
// (naechtliches Oversell-Fenster). Ein Versuch, dessen Fehlschlag quota-artig
// ist, zaehlt deshalb NICHT als Versuch, sondern wird verschoben: erst kurz
// (1h/3h — deckt Stunden-Limits), danach bis zum naechsten Quota-Reset
// (Mitternacht US-Pazifik). MAX_QUOTA_DEFERRALS begrenzt das je Sperr-Phase —
// ein gezaehlter Versuch setzt den Zaehler zurueck (kein Zombie-Doc, aber
// volle Deckung in der naechsten Quota-Nacht).
const QUOTA_DEFERRAL_STEPS_MS = [60 * 60 * 1000, 3 * 60 * 60 * 1000];
const QUOTA_DEFERRAL_JITTER_MS = 15 * 60 * 1000;
const MAX_QUOTA_DEFERRALS = 8;

// Quota-artige eBay-Fehlertexte: echte eBay-Antwort ("exceeded usage limit")
// plus die Fail-fast-Skips des Breakers ("quota cooldown"/"quota breaker").
// Bewusst ENG — Auth-, Validierungs- oder dup_guard-Fehler zaehlen normal
// weiter, sonst verspaetet sich der Abandoned-Alarm fuer unheilbare Fehler.
const QUOTA_ERROR_PATTERN = /exceeded usage limit|quota cooldown|quota breaker/i;
function isQuotaLikeError(text) {
  return QUOTA_ERROR_PATTERN.test(String(text || ''));
}

// Notbremse: nur der exakte Wert 'off' (getrimmt, case-egal — gleiche Lesart
// wie AUTO_INVOICE/LABEL_EXACT_SIZE) schaltet zurueck aufs alte Verhalten.
function quotaAwareDrainEnabled() {
  return String(process.env.DRAIN_QUOTA_AWARE || '').trim().toLowerCase() !== 'off';
}

/**
 * Entscheidet nach einem fehlgeschlagenen Retry, ob der Fehlschlag der
 * eBay-Quota-Sperre zuzurechnen ist. Wenn ja: Deferral-Payload (Versuch bleibt
 * unverbraucht), sonst null (normales Attempt-Zaehlen).
 *
 * Kriterium ist die FEHLERMELDUNG des gescheiterten Kanals (quotaBlocked aus
 * dem Retry-Mapping), NICHT der shared Breaker-Zustand: der haengt an
 * EBAY_QUOTA_BREAKER_SHARED (Default aus) und wird fire-and-forget geschrieben
 * (Race beim ersten Quota-Treffer). Deferral NUR, wenn JEDER Fehlschlag ein
 * reiner eBay-Kanalfehler ist — Lookup-Fehler (product-not-found) oder ein
 * Kaufland-Leg (ONHOLD-Oversell-Guard, CLAUDE.md Punkt 10) duerfen nie
 * mitverschoben werden.
 */
function _maybeQuotaDeferral({ data, retryResults, now }) {
  if (!quotaAwareDrainEnabled()) return null;
  const failed = (retryResults || []).filter((r) => r && !r.ok);
  if (!failed.length) return null;
  const allEbayOnly = failed.every(
    (r) => Array.isArray(r.channels) && r.channels.length > 0 && r.channels.every((c) => c === 'ebay')
  );
  if (!allEbayOnly) return null;
  if (!failed.some((r) => r.quotaBlocked === true)) return null;
  const deferrals = Number(data?.quotaDeferrals || 0);
  if (deferrals >= MAX_QUOTA_DEFERRALS) return null;
  let waitMs;
  if (deferrals < QUOTA_DEFERRAL_STEPS_MS.length) {
    waitMs = QUOTA_DEFERRAL_STEPS_MS[deferrals];
  } else {
    try {
      waitMs = require('../lib/ebay-quota-breaker').msUntilNextEbayQuotaReset(now);
    } catch (_) {
      waitMs = QUOTA_DEFERRAL_STEPS_MS[QUOTA_DEFERRAL_STEPS_MS.length - 1];
    }
  }
  const waitTotalMs = waitMs + Math.floor(Math.random() * QUOTA_DEFERRAL_JITTER_MS);
  return {
    deferrals: deferrals + 1,
    waitTotalMs,
    nextRetryAt: new Date(now + waitTotalMs).toISOString(),
  };
}

// WP1 Kill-Switch (Teil E, Task 5). Spiegelt das Flag im Dispatcher.
// OFF → heutiges Verhalten (alle pending Docs jeden Lauf retrien, kein Backoff).
// ON → nur fällige Docs (nextRetryAt <= now), Backoff-Stempel bei Fehlschlag.
function durableDrainEnabled() {
  return String(process.env.SYNC_DURABLE_DRAIN || '').toLowerCase() === 'true';
}

// Ein Failure-Doc ist fällig, wenn es keinen (Legacy/unstamped) oder einen
// vergangenen nextRetryAt hat. Legacy-Docs ohne Feld → SOFORT fällig, damit der
// Backoff-Rollout keine bestehenden pending Failures stranden lässt.
function isDue(data, now) {
  const nra = data && data.nextRetryAt;
  if (!nra) return true;
  const ms = Date.parse(nra);
  if (!Number.isFinite(ms)) return true;
  return ms <= now;
}

async function loadPendingFailureDocs({ firestore, tenantId, limit }) {
  try {
    return await firestore.collection('stock_operation_failures')
      .where('tenantId', '==', tenantId)
      .where('status', '==', 'pending')
      .orderBy('createdAt', 'asc')
      .limit(limit * 4)
      .get();
  } catch (err) {
    // Backward-compatible fallback for environments where the composite index
    // was not created yet.
    const msg = String(err?.message || '').toLowerCase();
    const isIndexIssue = msg.includes('index') || msg.includes('failed precondition');
    if (!isIndexIssue) throw err;
    console.warn('[stock-failure-drain] pending-index missing, falling back to tenant-only query');
    return firestore.collection('stock_operation_failures')
      .where('tenantId', '==', tenantId)
      .orderBy('createdAt', 'asc')
      .limit(limit * 4)
      .get();
  }
}

async function loadProductForFailure({ firestore, tenantId, failure }) {
  const sku = String(failure?.sku || '').trim();
  if (sku) {
    let productSnap = await firestore.collection('products_v2')
      .where('identification.sku', '==', sku)
      .where('tenantId', '==', tenantId)
      .limit(1)
      .get();
    if (productSnap.empty) {
      productSnap = await firestore.collection('products_v2')
        .where('details.identifiers.sku', '==', sku)
        .where('tenantId', '==', tenantId)
        .limit(1)
        .get();
    }
    if (!productSnap.empty) {
      const pDoc = productSnap.docs[0];
      return { product: { id: pDoc.id, ...pDoc.data() }, lookupError: null };
    }
  }

  const productId = String(failure?.productId || '').trim();
  if (!productId) {
    return { product: null, lookupError: sku ? 'product-not-found' : 'no-sku-and-no-productId' };
  }

  const productDoc = await firestore.collection('products_v2').doc(productId).get();
  if (!productDoc.exists) {
    return { product: null, lookupError: 'product-not-found' };
  }

  const productData = productDoc.data() || {};
  if (productData.tenantId && String(productData.tenantId) !== String(tenantId)) {
    return { product: null, lookupError: 'tenant-mismatch' };
  }
  return { product: { id: productDoc.id, ...productData }, lookupError: null };
}

async function drainStockFailures({ tenantId, limit = 50 } = {}) {
  if (process.env.STOCK_FAILURE_DRAIN_ENABLED === 'false') {
    return { skipped: true, reason: 'STOCK_FAILURE_DRAIN_ENABLED=false' };
  }
  if (!tenantId) {
    throw new Error('drainStockFailures: tenantId required');
  }

  const { firestore } = require('../lib/firestore');
  const { syncStockWithRetry } = require('./stock-sync-dispatcher');
  const now = Date.now();
  const durable = durableDrainEnabled();

  // Prefer status-filtered query to avoid starvation by old resolved docs.
  // Falls back automatically if index is not ready yet.
  const snap = await loadPendingFailureDocs({ firestore, tenantId, limit });

  const results = { total: 0, resolved: 0, stillFailing: 0, abandoned: 0, skipped: 0, needsManual: 0, quotaDeferred: 0 };

  for (const doc of snap.docs) {
    if (results.total >= limit) break;
    const data = doc.data() || {};
    if (data.status !== 'pending') continue;
    const attempts = Number(data.attempts || 0);
    if (attempts >= MAX_ATTEMPTS) continue;
    // WP1 Task 5: respect backoff — only retry docs whose nextRetryAt is due.
    // Off by flag → legacy behaviour (every pending doc each run).
    // AUSNAHME (2026-08-26): quota-verschobene Docs (quotaDeferrals > 0)
    // respektieren ihr nextRetryAt IMMER — sonst hinge die Warte-Logik still
    // am fremden WP1-Flag und der 2-min-Cron wuerde das Deferral-Budget in
    // ~16 min aufbrauchen (Review-Befund).
    const quotaDeferredDoc = Number(data.quotaDeferrals || 0) > 0;
    if ((durable || quotaDeferredDoc) && !isDue(data, now)) {
      results.skipped += 1;
      continue;
    }
    results.total += 1;

    const failuresArr = Array.isArray(data.failures) ? data.failures : [];
    const retryable = failuresArr.filter((f) => f && f.step === 'marketplaceSync');
    const manual = failuresArr.filter((f) => f && f.step === 'decrement');

    // Wenn nur decrement-Failures, als needs_manual markieren und nicht retryn.
    if (retryable.length === 0 && manual.length > 0) {
      await doc.ref.update({
        status: 'needs_manual',
        reason: 'decrement-failures-require-manual-intervention',
        updatedAt: new Date().toISOString(),
      });
      results.needsManual += 1;
      console.warn(`[stock-failure-drain] ${doc.id} needs_manual: ${manual.length} decrement failure(s)`);
      // HARDEN-Wave-2 (2026-05-22): Operator-Alert über best-effort Slack.
      await _emitTerminalAlert({
        tenantId,
        failureDocId: doc.id,
        terminalStatus: 'needs_manual',
        reason: `${manual.length} decrement failure(s) — manual intervention required`,
        failures: manual.slice(0, 3),
      });
      continue;
    }

    // Retry marketplaceSync failures once per affected product key.
    const dedupedRetryable = [];
    const seenRetryKeys = new Set();
    for (const failure of retryable) {
      const key = String(failure?.productId || failure?.sku || '').trim();
      const retryKey = key || `raw:${JSON.stringify(failure || {})}`;
      if (seenRetryKeys.has(retryKey)) continue;
      seenRetryKeys.add(retryKey);
      dedupedRetryable.push(failure);
    }

    const retryResults = [];
    let anyHardError = false;
    for (const f of dedupedRetryable) {
      try {
        const { product, lookupError } = await loadProductForFailure({ firestore, tenantId, failure: f });
        const sku = String(f?.sku || product?.identification?.sku || product?.details?.identifiers?.sku || '').trim() || null;
        if (!product) {
          retryResults.push({ sku, ok: false, error: lookupError || 'product-not-found' });
          anyHardError = true;
          continue;
        }
        const r = await syncStockWithRetry({
          tenantId,
          product,
          reason: `drain:${doc.id}`,
          skipPersistentFailureQueue: true,
        });
        const channelErrors = Array.isArray(r?.results)
          ? r.results.filter((c) => c && (c.status === 'error' || c.status === 'failed'))
          : [];
        if (channelErrors.length > 0) {
          retryResults.push({
            sku,
            ok: false,
            error: `channels-failed:${channelErrors.map((c) => c.channel).join(',')}`,
            // Strukturiert fuer die Quota-Entscheidung — NIE aus dem
            // error-String parsen ('ebay' steckt auch in Exception-Prosa).
            channels: channelErrors.map((c) => String(c?.channel || '').toLowerCase()),
            quotaBlocked: channelErrors.some((c) => isQuotaLikeError(c?.error)),
          });
          anyHardError = true;
        } else {
          retryResults.push({ sku, ok: true });
        }
      } catch (err) {
        retryResults.push({ sku: f?.sku || null, ok: false, error: err.message });
        anyHardError = true;
      }
    }

    const nextAttempts = attempts + 1;
    if (!anyHardError) {
      await doc.ref.update({
        status: manual.length > 0 ? 'needs_manual' : 'resolved',
        resolvedAt: new Date().toISOString(),
        attempts: nextAttempts,
        drainResults: retryResults,
      });
      if (manual.length > 0) {
        results.needsManual += 1;
      } else {
        results.resolved += 1;
      }
      console.log(`[stock-failure-drain] ${doc.id} resolved after attempt ${nextAttempts} (${retryable.length} marketplaceSync)`);
    } else {
      // Quota-Sperre? Dann Versuch NICHT verbrauchen, sondern verschieben.
      const deferral = _maybeQuotaDeferral({ data, retryResults, now });
      if (deferral) {
        await doc.ref.update({
          status: 'pending',
          // Parity zum normalen Fehlpfad — sonst blieben quota-wartende
          // Legacy-Docs ohne classification unsichtbar fuer Ops-Abfragen.
          classification: data.classification || 'unknown',
          quotaDeferrals: deferral.deferrals,
          lastAttemptAt: new Date().toISOString(),
          drainResults: retryResults,
          nextRetryAt: deferral.nextRetryAt,
        });
        results.quotaDeferred += 1;
        console.warn(`[stock-failure-drain] QUOTA-DEFERRED ${doc.id}: eBay-Tageslimit erschoepft — Versuch bleibt unverbraucht (Deferral ${deferral.deferrals}/${MAX_QUOTA_DEFERRALS}), naechster Versuch in ~${Math.round(deferral.waitTotalMs / 60000)} min`);
        continue;
      }
      const nextStatus = nextAttempts >= MAX_ATTEMPTS ? 'abandoned' : 'pending';
      const updatePayload = {
        status: nextStatus,
        attempts: nextAttempts,
        lastAttemptAt: new Date().toISOString(),
        drainResults: retryResults,
      };
      // Gezaehlter Versuch beendet die Quota-Sperr-Phase: Deferral-Budget
      // zuruecksetzen, damit die NAECHSTE Quota-Nacht wieder voll gedeckt ist.
      if (Number(data.quotaDeferrals || 0) > 0) {
        updatePayload.quotaDeferrals = 0;
      }
      // WP1 Task 5: stamp the next backoff window so the doc is skipped until due.
      // classification was set at creation (Task 4); default unknown for legacy docs.
      if (durable && nextStatus === 'pending') {
        const classification = data.classification || 'unknown';
        updatePayload.classification = classification;
        updatePayload.nextRetryAt = computeNextRetryAt({ attempts: nextAttempts, now, classification });
      }
      await doc.ref.update(updatePayload);
      if (nextStatus === 'abandoned') {
        results.abandoned += 1;
        console.error(`[stock-failure-drain] ABANDONED after ${MAX_ATTEMPTS} attempts: ${doc.id} — ${JSON.stringify(retryResults)}`);
        // HARDEN-Wave-2 (2026-05-22): Operator-Alert über best-effort Slack.
        await _emitTerminalAlert({
          tenantId,
          failureDocId: doc.id,
          terminalStatus: 'abandoned',
          reason: `After ${MAX_ATTEMPTS} attempts, marketplaceSync still failing`,
          failures: (retryResults || []).slice(0, 3),
        });
      } else {
        results.stillFailing += 1;
      }
    }
  }

  return results;
}

// ───────────────────────────────────────────────────────────────────────────
// Best-effort Terminal-State Alerting (Slack-Webhook).
// HARDEN-Wave-2 (2026-05-22): Drain markiert Failures als `abandoned` oder
// `needs_manual` — vorher passierte da NICHTS außer einem console.error.
// Jetzt: zusätzlich ein Slack-POST an SLACK_ALERTS_URL (wenn gesetzt) und
// ein structured Firestore-Eintrag in `stock_failure_alerts` (queryable).
// Fire-and-forget — NIE blocking, NIE failing.
// ───────────────────────────────────────────────────────────────────────────

async function _emitTerminalAlert({ tenantId, failureDocId, terminalStatus, reason, failures }) {
  try {
    const summary = `🚨 [stock-drain] ${terminalStatus.toUpperCase()} — tenant=${tenantId} doc=${failureDocId}\n${reason}`;
    const detail = (failures || []).map((f) => {
      if (!f) return null;
      return `  • ${f.step || 'unknown'}: sku=${f.sku || f.productKey || '?'} error=${(f.error || f.message || '').toString().slice(0, 200)}`;
    }).filter(Boolean).join('\n');
    const text = detail ? `${summary}\n${detail}` : summary;

    // Best-effort Slack post
    const slackUrl = process.env.SLACK_ALERTS_URL;
    if (slackUrl) {
      // node 20 has global fetch; never await result
      Promise.resolve()
        .then(() => fetch(slackUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        }))
        .catch((err) => console.warn(`[stock-failure-drain] slack alert failed: ${err.message}`));
    }

    // Audit-trail in Firestore (queryable für Ops-Dashboard)
    try {
      const { firestore } = require('../lib/firestore');
      await firestore.collection('stock_failure_alerts').add({
        tenantId: tenantId || 'default',
        failureDocId,
        terminalStatus,
        reason,
        failures: failures || [],
        text,
        createdAt: new Date().toISOString(),
      });
    } catch (writeErr) {
      console.warn(`[stock-failure-drain] alert audit write failed: ${writeErr.message}`);
    }
  } catch (err) {
    // Alerting must NEVER break the drain loop.
    console.warn(`[stock-failure-drain] _emitTerminalAlert failed: ${err.message}`);
  }
}

module.exports = { drainStockFailures, MAX_ATTEMPTS, MAX_QUOTA_DEFERRALS };
