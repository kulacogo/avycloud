'use strict';
const { keepGpsrRolesCoherent } = require('../lib/capture-gpsr-coherence');

it('never splices a Japanese manufacturer address into a German registry entity', () => {
  const registry = { manufacturer_name: 'Example Europe GmbH', country_code: 'DE' };
  const researched = { manufacturer_name: 'Example Japan Ltd.', entity_country: 'Japan', manufacturer_city: 'Tokyo', manufacturer_address: '1 Test Road', manufacturer_postalcode: '100-0001', email: 'info@example.jp' };
  const result = keepGpsrRolesCoherent({ ...researched, ...registry }, [registry, researched]);
  expect(result).toMatchObject({ ...researched, country_code: 'JP' });
  expect(result.manufacturer_name).not.toBe(registry.manufacturer_name);
});

it('preserves separately supplied EU representative fields and same-entity additions', () => {
  const registry = { manufacturer_name: 'Example GmbH', entity_country: 'Deutschland', eu_responsible_name: 'Separate EU GmbH' };
  const researched = { manufacturer_name: 'Example GmbH', manufacturer_city: 'Berlin', email: 'contact@example.de', eu_responsible_address: 'Other Street 2' };
  expect(keepGpsrRolesCoherent({ ...registry, ...researched }, [registry, researched])).toMatchObject({ ...registry, ...researched, country_code: 'DE' });
});

it('also resolves conflicting EU representative records as complete entities', () => {
  const partial = { eu_responsible_name: 'Old GmbH', eu_responsible_country_code: 'DE' };
  const current = { eu_responsible_name: 'New BV', eu_responsible_country: 'Niederlande', eu_responsible_city: 'Amsterdam', eu_responsible_address: 'Street 4', eu_responsible_email: 'contact@example.nl' };
  expect(keepGpsrRolesCoherent({ ...current, ...partial }, [partial, current])).toMatchObject({ ...current, eu_responsible_country_code: 'NL' });
});
