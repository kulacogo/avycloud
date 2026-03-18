'use strict';
const { importFromSevDesk } = require('../services/invoice-engine');

(async () => {
  console.log('Importing from SevDesk...');
  const result = await importFromSevDesk({ tenantId: 'default' });
  console.log('Result:', JSON.stringify(result, null, 2));
})().catch(console.error);
