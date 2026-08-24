'use strict';
const { ZONE_1, ZONE_2, FORBIDDEN, PRODUCTS, TRACKED_ONLY_FROM_EUR_DEFAULT, premiumRequired } = require('../config/shipping-catalog');

// Zielland → Versand-Scope. DE = national; Zone 1/2 = international ohne Warnung;
// alles andere = international MIT Warnung (Fremdland, Teamlead fragen — kein Block).
function classifyDestination(rawCountry) {
  const country = String(rawCountry || 'DE').trim().toUpperCase().slice(0, 2) || 'DE';
  if (country === 'DE') return { country, scope: 'national', warn: false };
  const inZone = ZONE_1.includes(country) || ZONE_2.includes(country);
  return { country, scope: 'international', warn: !inZone };
}

function optionWeightFits(o, weightKg) {
  if (weightKg == null) return true;
  const min = Number(o?.weight?.min?.value ?? 0) || 0;
  const max = Number(o?.weight?.max?.value ?? 0) || Infinity;
  return weightKg >= min && weightKg <= max;
}

// Anzahl Zusatz-Modifier hinter dem Basis-Produkt. Trenner ist "/" ODER ","
// (carrier:product/mod1,mod2 → 2; carrier:product,mod → 1). Das Komma MUSS mitzählen,
// sonst gilt z. B. "dhl_de:weltpaket,flex_delivery" fälschlich als schlichtes Produkt
// und verdrängt das echte "dhl_de:weltpaket" (gefunden am Portugal-Fall 2026-07-22).
function modifierCount(code) {
  const s = String(code || '');
  const afterColon = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
  const sepIdx = afterColon.search(/[/,]/);
  if (sepIdx === -1) return 0;
  return afterColon.slice(sepIdx + 1).split(/[/,]/).filter(Boolean).length;
}

// ── Tracking-Pflicht ab 10 € Bestellwert (Betreiber-Anweisung 2026-08-21) ──────

// Schwelle in EUR; ENV SHIPPING_TRACKED_ONLY_FROM_EUR überschreibt (Zahl > 0),
// 'off' schaltet die Regel ab (Schwelle unendlich). Müll fällt auf den Default.
function trackedOnlyThresholdEur() {
  const raw = String(process.env.SHIPPING_TRACKED_ONLY_FROM_EUR ?? '').trim();
  if (!raw) return TRACKED_ONLY_FROM_EUR_DEFAULT;
  if (raw.toLowerCase() === 'off') return Infinity;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : TRACKED_ONLY_FROM_EUR_DEFAULT;
}

// Gilt für diesen Bestellwert die Tracking-Pflicht? 'off' (Schwelle Infinity)
// schaltet die Regel KOMPLETT ab — auch für unbekannte Werte. Das ist
// Notbremsen-Semantik: der wahrscheinlichste Grund, die Bremse zu ziehen, ist
// eine kaputte Wert-Ermittlung (alle Orders „unbekannt"); dann darf die Regel
// nicht weiter blocken. Bei aktiver Regel gilt: unbekannter/0-Wert → Pflicht
// (fail-safe Richtung Tracking).
function trackedOnlyObligation(orderValueEur) {
  const threshold = trackedOnlyThresholdEur();
  if (!Number.isFinite(threshold)) return false;
  const value = Number(orderValueEur);
  return !(Number.isFinite(value) && value > 0 && value < threshold);
}

// Bestellwert (EUR brutto) aus dem Order-Doc: kanonisch order.totalAmount
// (eBay: Marktplatz-Total inkl. Versand; Kaufland: Positionssumme), Fallback
// Positionssumme items[].priceBrutto × quantity. 0/fehlend → null = UNBEKANNT —
// der Aufrufer entscheidet dann fail-safe Richtung Tracking-Pflicht.
function resolveOrderValueEur(order) {
  const total = Number(order?.totalAmount);
  if (Number.isFinite(total) && total > 0) return total;
  const items = Array.isArray(order?.items) ? order.items : [];
  let sum = 0;
  let any = false;
  for (const it of items) {
    const price = Number(it?.priceBrutto);
    const qty = Number(it?.quantity) || 1;
    if (Number.isFinite(price) && price > 0) { sum += price * qty; any = true; }
  }
  return any ? sum : null;
}

// Trägt dieser v3-Code KEINE Sendungsnummer? Gemessen 2026-08-21 am Live-Konto:
// Deutsche-Post-Briefprodukte (maxibrief/grossbrief/warensendung/…) sind untracked,
// außer Einschreiben (`registered`) und `tracked`-Varianten (dp:global_mail/tracked).
// Warenpost International trackt NUR als Premium. `sendcloud:letter` nie.
// Paketprodukte (DHL/DPD/…) tragen immer eine Sendungsnummer → fail-open.
function isUntrackedOptionCode(code) {
  const s = String(code || '').trim();
  if (!s) return false;
  if (/^sendcloud:letter/i.test(s)) return true;
  if (/^dp:/i.test(s)) return !/registered|tracked/i.test(s);
  if (/^dhl_de:warenpostinternational/i.test(s)) return !/[/,]premium(\b|,|$)/i.test(s);
  return false;
}

// PREMIUM-PFLICHT (Betreiber-Anweisung 2026-08-21, WERTUNABHÄNGIG): Warenpost
// International und DHL Paket International "müssen IMMER als Premium versendet
// werden" — nur Premium trägt eine verlässliche Sendungsverfolgung. true =
// dieser Code ist eine DHL-International-Variante OHNE Premium-Modifier und
// darf nie zum Announce kommen (der kuratierte Katalog bietet sie gar nicht
// erst an; das hier fängt Alt-Flow/manuell übergebene Codes).
function requiresPremiumVariant(code) {
  if (!premiumRequired()) return false; // Notbremse SHIPPING_PREMIUM_REQUIRED='off'
  const s = String(code || '').trim();
  if (!s) return false;
  if (!/^dhl_de:(warenpostinternational|weltpaket|paket_international|dhl_paket_international)(\b|\/|,|$)/i.test(s)) return false;
  return !/[/,]premium(\b|,|$)/i.test(s);
}

// Premium-Schwester eines plain-Codes auf derselben Lane: gleiches Basisprodukt,
// Premium-Modifier, gewichtspassend, KEINE weiteren verbotenen Zusatzleistungen
// (premium wird vor dem FORBIDDEN-Test entfernt — flex_delivery & Co. bleiben
// verboten). Plainste Variante gewinnt, deterministisch (modifierCount +
// localeCompare — Lehre aus dem europaket-Münzwurf 2026-08-07). null = keine.
// Genutzt vom Alt-Flow-Auto-Upgrade in createParcel: der Fuzzy-Resolver MEIDET
// Premium bewusst (+4-Penalty, Fix 2026-07-20) — ohne Upgrade liefe jeder
// internationale Alt-Flow-/Bulk-Versand in den Premium-Pflicht-Guard.
function findPremiumSibling(liveOptions, baseCode, weightKg) {
  const base = String(baseCode || '').split(/[/,]/)[0];
  if (!base) return null;
  const candidates = (Array.isArray(liveOptions) ? liveOptions : [])
    .filter((o) => typeof o?.code === 'string')
    .filter((o) => o.code.split(/[/,]/)[0].toLowerCase() === base.toLowerCase())
    .filter((o) => /[/,]premium(\b|,|$)/i.test(o.code))
    .filter((o) => !FORBIDDEN.test(o.code.replace(/premium/gi, '')))
    .filter((o) => optionWeightFits(o, weightKg));
  if (!candidates.length) return null;
  candidates.sort((a, b) => modifierCount(a.code) - modifierCount(b.code) || a.code.localeCompare(b.code));
  return candidates[0].code;
}

// FORBIDDEN-Prüfung mit Pro-Produkt-Ausnahme: `product.allow` (Regex) wird vor dem
// Test aus dem Code entfernt — so bleibt z. B. `premium` für DHL International
// erlaubt, während `weltpaket/premium,flex_delivery` weiter am flex_delivery scheitert.
function isForbiddenForProduct(code, product) {
  const effective = product?.allow ? String(code).replace(product.allow, '') : String(code);
  return FORBIDDEN.test(effective);
}

// Mappt die LIVE-v3-Optionen von SendCloud auf die kuratierten Produkt-Slots.
// Selbst-korrigierend: zeigt nur, was SendCloud für die Lane wirklich anbietet.
// `orderValueEur`: Bestellwert für die Tracking-Pflicht — ab Schwelle (und bei
// null/unbekannt, fail-safe) werden tracking:false-Produkte NICHT angeboten.
function resolveCuratedOptions(liveOptions, { country, weightKg, flags = {}, orderValueEur = null } = {}) {
  const dest = classifyDestination(country);
  const options = (Array.isArray(liveOptions) ? liveOptions : []).filter((o) => typeof o?.code === 'string');
  const threshold = trackedOnlyThresholdEur();
  const value = Number(orderValueEur);
  const trackedOnly = trackedOnlyObligation(orderValueEur);
  const products = [];
  for (const product of PRODUCTS) {
    if (product.scope !== dest.scope) continue;
    if (product.requiresFlag && !flags[product.requiresFlag]) continue;
    if (product.allowedCountries && !product.allowedCountries.includes(dest.country)) continue;
    if (weightKg != null && product.maxWeightKg != null && weightKg > product.maxWeightKg) continue;
    // Tracking-Pflicht: ab Schwelle (oder unbekanntem Bestellwert) keine
    // Versandarten ohne Sendungsverfolgung anbieten.
    if (trackedOnly && product.tracking === false) continue;

    const candidates = options
      .filter((o) => !isForbiddenForProduct(o.code, product))
      .filter((o) => product.match(o.code))
      .filter((o) => optionWeightFits(o, weightKg));
    if (!candidates.length) continue;

    // Zweitkriterium ist Pflicht, nicht Kosmetik: bei gleichem modifierCount
    // war der Vergleich ein Gleichstand, und Array.sort ist stabil — die Wahl
    // fiel damit auf die Reihenfolge der SendCloud-Antwort zurück. Die ist
    // NICHT deterministisch (an der Live-API gemessen: 4 identische Aufrufe,
    // beim vierten kippte die Reihenfolge). So wurde aus zwei verschiedenen
    // DHL-Produkten ein Münzwurf (Vorfall 2026-08-07, europaket/weltpaket).
    // Alphabetisch ist willkürlich, aber REPRODUZIERBAR — und das ist der Punkt:
    // dasselbe Angebot muss immer dasselbe Label ergeben.
    candidates.sort((a, b) => modifierCount(a.code) - modifierCount(b.code) || a.code.localeCompare(b.code));
    products.push({
      key: product.key,
      displayName: product.displayName,
      carrier: product.carrier,
      tracking: product.tracking,
      shippingOptionCode: candidates[0].code,
      rank: product.rank,
    });
  }
  products.sort((a, b) => a.rank - b.rank);
  return {
    scope: dest.scope,
    country: dest.country,
    warn: dest.warn,
    trackedOnly,
    // Für die UI: echte Schwelle (JSON-sicher — Infinity würde zu null serialisiert,
    // also explizit null bei 'off') + ob der Bestellwert überhaupt bekannt war
    // (bei false ist der Grund der Pflicht „Wert unbekannt", nicht „über Schwelle").
    trackedOnlyThresholdEur: Number.isFinite(threshold) ? threshold : null,
    orderValueKnown: Number.isFinite(value) && value > 0,
    products,
  };
}

module.exports = {
  classifyDestination,
  resolveCuratedOptions,
  optionWeightFits,
  modifierCount,
  trackedOnlyThresholdEur,
  trackedOnlyObligation,
  resolveOrderValueEur,
  isUntrackedOptionCode,
  requiresPremiumVariant,
  findPremiumSibling,
};
