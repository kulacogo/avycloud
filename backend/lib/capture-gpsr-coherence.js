'use strict';

const { sameCompany, sameCountry } = require('./gpsr-role-merge');
const { normalizeCountryCode } = require('./gpsr-manufacturer-registry');
const { GPSR_FIELDS } = require('./chat-datasheet-contract');

// Keep the established precedence when sources describe the same entity.
// On an entity conflict, choose one coherent record for that role; never
// combine e.g. a Japanese company/address with a German registry country.
function keepGpsrRolesCoherent(merged, sources) {
  const result = { ...merged };
  for (const rep of [false, true]) {
    const keys = GPSR_FIELDS.filter(key => key.startsWith('eu_responsible_') === rep);
    const name = rep ? 'eu_responsible_name' : 'manufacturer_name';
    const country = rep ? 'eu_responsible_country' : 'entity_country';
    const code = rep ? 'eu_responsible_country_code' : 'country_code';
    const named = sources.filter(source => source?.[name]);
    const same = (a, b) => sameCompany(a[name], b[name]) && sameCountry(a[country] || a[code], b[country] || b[code]);
    if (named.some((source, index) => named.slice(index + 1).some(other => !same(source, other)))) {
      const score = source => keys.filter(key => String(source[key] || '').trim()).length;
      const primary = [...named].sort((a, b) => score(b) - score(a))[0];
      const compatible = [primary, ...named.filter(source => source !== primary && same(primary, source))];
      for (const key of keys) {
        delete result[key];
        const value = compatible.map(source => source[key]).find(value => String(value || '').trim());
        if (value) result[key] = value;
      }
    }
    const derived = normalizeCountryCode(result[country]);
    if (derived) result[code] = derived;
  }
  return result;
}

module.exports = { keepGpsrRolesCoherent };
