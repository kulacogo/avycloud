'use strict';
const { ZONE_1, ZONE_2, FORBIDDEN, PRODUCTS } = require('../config/shipping-catalog');

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

// Anzahl Zusatz-Modifier nach dem Slash (carrier:product/mod1,mod2 → 2).
function modifierCount(code) {
  const s = String(code || '');
  const afterColon = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
  const after = afterColon.includes('/') ? afterColon.slice(afterColon.indexOf('/') + 1) : '';
  return after ? after.split(/[/,]/).filter(Boolean).length : 0;
}

// Mappt die LIVE-v3-Optionen von SendCloud auf die kuratierten Produkt-Slots.
// Selbst-korrigierend: zeigt nur, was SendCloud für die Lane wirklich anbietet.
function resolveCuratedOptions(liveOptions, { country, weightKg, flags = {} } = {}) {
  const dest = classifyDestination(country);
  const options = (Array.isArray(liveOptions) ? liveOptions : []).filter((o) => typeof o?.code === 'string');
  const products = [];
  for (const product of PRODUCTS) {
    if (product.scope !== dest.scope) continue;
    if (product.requiresFlag && !flags[product.requiresFlag]) continue;
    if (product.allowedCountries && !product.allowedCountries.includes(dest.country)) continue;
    if (weightKg != null && product.maxWeightKg != null && weightKg > product.maxWeightKg) continue;

    const candidates = options
      .filter((o) => !FORBIDDEN.test(o.code))
      .filter((o) => product.match(o.code))
      .filter((o) => optionWeightFits(o, weightKg));
    if (!candidates.length) continue;

    candidates.sort((a, b) => modifierCount(a.code) - modifierCount(b.code));
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
  return { scope: dest.scope, country: dest.country, warn: dest.warn, products };
}

module.exports = { classifyDestination, resolveCuratedOptions, optionWeightFits, modifierCount };
