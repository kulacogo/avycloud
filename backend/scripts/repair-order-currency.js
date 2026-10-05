#!/usr/bin/env node
'use strict';

/**
 * repair-order-currency.js — Kaufland-Auftraege in Fremdwaehrung (kaufland.cz = CZK,
 * kaufland.pl = PLN) nachziehen, die vor dem 05.10.2026 mit `currency: 'EUR'` und dem
 * CZK/PLN-Betrag als Euro gespeichert wurden (Vorfall M53KUW5: 534,14 CZK → "534,14 €").
 *
 * Storefront und Waehrung stehen NUR in der Kaufland-API (`raw` wird nicht gespeichert).
 * Das Script holt deshalb jeden Kandidaten erneut ab (GET /orders/{id}, lesend), rechnet
 * mit dem EZB-Kurs des Bestelltages um (lib/fx-rates.js) und schreibt DENSELBEN Heil-Patch
 * wie der 30-Tage-Abgleich des Intakes (lib/order-currency.js buildCurrencyHealPatch) —
 * ein Weg, keine zweite Rechnung.
 *
 * DRY-RUN IST DEFAULT. Schreiben nur mit `--apply --confirm CURRENCY_REPAIR_V1`.
 *
 *   node backend/scripts/repair-order-currency.js                        # Trockenlauf
 *   node backend/scripts/repair-order-currency.js --order M53KUW5        # ein Auftrag
 *   node backend/scripts/repair-order-currency.js --all                  # jeden Kaufland-Auftrag pruefen (viele API-Aufrufe)
 *   node backend/scripts/repair-order-currency.js --apply --confirm CURRENCY_REPAIR_V1
 *
 * Kandidaten ohne --all/--order: Kaufland-Auftraege des Mandanten (--tenant, Default
 * 'default') der letzten --days Tage (Default 400), die noch kein `originalCurrency`
 * tragen oder `exchangeRatePending` sind, und deren Storefront bzw. Kunden-/Rechnungsland
 * auf eine Nicht-Euro-Waehrung deutet (CZ, PL). Das haelt die API-Aufrufe klein.
 *
 * Druckt Projekt + Mandant VOR jedem Schreibzugriff (lokale gcloud-Konfiguration zeigt
 * auf ein fremdes Projekt — deshalb wird GOOGLE_CLOUD_PROJECT hier selbst gesetzt).
 */

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'avycloud';
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;

const CONFIRM_TOKEN = 'CURRENCY_REPAIR_V1';
const NON_EUR_COUNTRIES = new Set(['CZ', 'PL']);

function parseArgs(argv) {
  const args = { apply: false, confirm: null, tenant: 'default', days: 400, orders: [], all: false, limit: 0 };
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = String(list[i]);
    const next = () => { i += 1; return list[i] == null ? '' : String(list[i]); };
    if (a === '--apply') args.apply = true;
    else if (a === '--all') args.all = true;
    else if (a === '--confirm') args.confirm = next();
    else if (a === '--tenant') args.tenant = next() || 'default';
    else if (a === '--days') args.days = Math.max(1, parseInt(next(), 10) || 400);
    else if (a === '--limit') args.limit = Math.max(0, parseInt(next(), 10) || 0);
    else if (a === '--order') args.orders.push(next().trim().toUpperCase());
    else if (a.startsWith('--order=')) args.orders.push(a.slice('--order='.length).trim().toUpperCase());
  }
  args.orders = args.orders.filter(Boolean);
  return args;
}

/** Schreiben nur mit ausdruecklicher Bestaetigung — ein Tippfehler darf keine Betraege aendern. */
function assertConfirm(args) {
  if (!args.apply) return;
  if (args.confirm !== CONFIRM_TOKEN) {
    throw new Error(`--apply verlangt --confirm ${CONFIRM_TOKEN}`);
  }
}

/**
 * Ist dieses Auftragsdokument ein Kandidat fuer die Nachpruefung?
 * Bereits umgerechnete (originalCurrency gesetzt, nicht pending) nie — Betraege bleiben stabil.
 */
function isCandidate(doc, { all = false, orderIds = null, storefrontCurrency = null } = {}) {
  if (!doc || typeof doc !== 'object') return false;
  if (String(doc.marketplace || doc.source || '').toLowerCase() !== 'kaufland') return false;
  const ids = orderIds instanceof Set ? orderIds : (Array.isArray(orderIds) ? new Set(orderIds) : null);
  if (ids && ids.size) return ids.has(String(doc.marketplaceOrderId || '').toUpperCase());

  const converted = Boolean(doc.originalCurrency) && doc.exchangeRatePending !== true;
  if (converted) return false;
  if (doc.exchangeRatePending === true) return true;
  if (all) return true;

  const sf = String(doc.storefront || '').trim().toLowerCase();
  if (sf) {
    const map = storefrontCurrency || require('../lib/order-currency').STOREFRONT_CURRENCY;
    const ccy = map[sf];
    return ccy ? ccy !== 'EUR' : true; // unbekannte Storefront → lieber nachsehen
  }
  const country = String(doc.customer?.country || doc.billingAddress?.country || '').trim().toUpperCase();
  return NON_EUR_COUNTRIES.has(country);
}

/**
 * Entscheidung fuer EIN Dokument: frische Zuordnung aus dem Kaufland-Payload, Umrechnung,
 * dann derselbe Heil-Pfad wie im Intake.
 *
 * @param {{ existing: object, klOrder: object, fx?: object, now?: Function, deps?: object }} opts
 * @returns {Promise<{ action: 'heal'|'skip', reason?: string, patch?: object, fresh: object }>}
 */
async function planRepair({ existing, klOrder, fx = null, now = () => new Date(), deps = null }) {
  const d = deps || {
    ...require('../services/order-intake-kaufland'),
    ...require('../lib/order-currency'),
  };
  const mapped = d.mapKauflandOrder(klOrder);
  const fresh = await d.convertOrderCurrency(mapped, { fx });

  if (String(mapped.currency || 'EUR').toUpperCase() === 'EUR') {
    return { action: 'skip', reason: 'euro', fresh };
  }
  if (String(fresh.currency || '').toUpperCase() !== 'EUR') {
    return { action: 'skip', reason: 'kein_kurs', fresh };
  }
  if (!d.needsCurrencyHeal(existing, fresh)) {
    return { action: 'skip', reason: 'bereits_umgerechnet', fresh };
  }
  return { action: 'heal', patch: d.buildCurrencyHealPatch(existing, fresh, { now }), fresh };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertConfirm(args);

  const { Firestore } = require('@google-cloud/firestore');
  const { kauflandRequest } = require('../lib/kaufland-api');
  const db = new Firestore({ projectId: PROJECT_ID });

  console.log(`Projekt: ${PROJECT_ID} · Mandant: ${args.tenant} · Modus: ${args.apply ? 'APPLY (schreibt)' : 'TROCKENLAUF (schreibt nichts)'}`);
  if (args.orders.length) console.log(`Auftraege: ${args.orders.join(', ')}`);
  else console.log(`Zeitraum: letzte ${args.days} Tage · Vorauswahl: ${args.all ? 'ALLE Kaufland-Auftraege' : 'Storefront/Land deutet auf CZK/PLN'}`);

  const snap = await db.collection('orders')
    .where('tenantId', '==', args.tenant)
    .where('marketplace', '==', 'kaufland')
    .get();

  const cutoff = Date.now() - args.days * 86400000;
  const orderIds = args.orders.length ? new Set(args.orders) : null;
  const candidates = [];
  snap.forEach((doc) => {
    const data = doc.data() || {};
    const created = Date.parse(data.createdAt || '');
    if (!orderIds && Number.isFinite(created) && created < cutoff) return;
    if (!isCandidate(data, { all: args.all, orderIds })) return;
    candidates.push({ id: doc.id, ref: doc.ref, data });
  });
  console.log(`Kaufland-Auftraege gesamt: ${snap.size} · Kandidaten: ${candidates.length}`);

  const summary = { geprueft: 0, geheilt: 0, euro: 0, bereitsUmgerechnet: 0, keinKurs: 0, fehler: 0 };
  const limited = args.limit > 0 ? candidates.slice(0, args.limit) : candidates;
  for (const cand of limited) {
    summary.geprueft += 1;
    const nr = String(cand.data.marketplaceOrderId || cand.id.replace(/^kaufland__/, ''));
    try {
      const res = await kauflandRequest('GET', `/orders/${encodeURIComponent(nr)}`);
      const klOrder = res?.data?.data || res?.data || null;
      if (!klOrder || !klOrder.id_order) {
        summary.fehler += 1;
        console.log(`  ${nr}: Kaufland lieferte keinen Auftrag`);
        continue;
      }
      const plan = await planRepair({ existing: cand.data, klOrder });
      if (plan.action === 'skip') {
        if (plan.reason === 'euro') summary.euro += 1;
        else if (plan.reason === 'kein_kurs') summary.keinKurs += 1;
        else summary.bereitsUmgerechnet += 1;
        console.log(`  ${nr}: uebersprungen (${plan.reason}, Storefront ${plan.fresh.storefront || '?'})`);
        continue;
      }
      const p = plan.patch;
      console.log(
        `  ${nr}: ${cand.data.totalAmount} ${cand.data.currency || '?'} → ${p.totalAmount} EUR `
        + `(${p.originalTotalAmount} ${p.originalCurrency}, Kurs ${p.exchangeRate} ${p.exchangeRateSource} ${p.exchangeRateDate || ''}, ${p['ops.currencyHeal'].reason})`
      );
      if (args.apply) {
        await cand.ref.update(p);
        summary.geheilt += 1;
        console.log(`  ${nr}: GESCHRIEBEN`);
      }
    } catch (err) {
      summary.fehler += 1;
      console.log(`  ${nr}: FEHLER ${err.message}`);
    }
  }

  console.log('');
  console.log(`Ergebnis: geprueft=${summary.geprueft} ${args.apply ? 'geheilt' : 'wuerde heilen'}=${args.apply ? summary.geheilt : limited.length - summary.euro - summary.bereitsUmgerechnet - summary.keinKurs - summary.fehler} euro=${summary.euro} bereitsUmgerechnet=${summary.bereitsUmgerechnet} keinKurs=${summary.keinKurs} fehler=${summary.fehler}`);
  if (!args.apply) console.log(`Trockenlauf — zum Schreiben: --apply --confirm ${CONFIRM_TOKEN}`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error(`FEHLER: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, assertConfirm, isCandidate, planRepair, CONFIRM_TOKEN, NON_EUR_COUNTRIES };
