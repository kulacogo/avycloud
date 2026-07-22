'use strict';
// Read-only: dumpt echte SendCloud-v3-Optionen für repräsentative Lanes, damit
// der kuratierte Katalog gegen die Realität geprüft werden kann (v. a. die noch
// unbestätigten Codes: dp:grossbrief, dp:warensendung, DHL Paket International).
// KEIN Firestore-/SendCloud-Write. Braucht SendCloud-Creds (Prod/Secret Manager
// oder exportierte SENDCLOUD_PUBLIC_KEY/SENDCLOUD_SECRET_KEY).
//
// Nutzung:  node backend/scripts/probe-shipping-options.js
const engine = require('../services/shipping-engine');
const { getSendCloudAuthHeader } = require('../lib/sendcloud-auth');

const LANES = [
  { label: 'DE Brief 0,3kg', toCountry: 'DE', toPostal: '10115', weightKg: 0.3 },
  { label: 'DE Paket 2kg',   toCountry: 'DE', toPostal: '10115', weightKg: 2 },
  { label: 'DE Paket 15kg',  toCountry: 'DE', toPostal: '10115', weightKg: 15 },
  { label: 'FR Paket 2kg',   toCountry: 'FR', toPostal: '75001', weightKg: 2 },
  { label: 'IT Paket 5kg',   toCountry: 'IT', toPostal: '00100', weightKg: 5 },
  { label: 'GR Paket 3kg',   toCountry: 'GR', toPostal: '10431', weightKg: 3 },
  { label: 'AT Klein 0,5kg', toCountry: 'AT', toPostal: '1010',  weightKg: 0.5 },
];

(async () => {
  const auth = await getSendCloudAuthHeader();
  const fromAddress = await engine._getV3FromAddress();
  for (const lane of LANES) {
    try {
      const options = await engine._listV3ShippingOptions({ fromAddress, toCountry: lane.toCountry, toPostal: lane.toPostal, weightKg: lane.weightKg, auth });
      console.log(`\n=== ${lane.label} (${options.length} Optionen) ===`);
      for (const o of options) {
        const min = o?.weight?.min?.value;
        const max = o?.weight?.max?.value;
        console.log(`  ${o.code}  [${min ?? '?'}-${max ?? '?'}]`);
      }
    } catch (e) {
      console.log(`\n=== ${lane.label} FEHLER: ${e.message} ===`);
    }
  }
  process.exit(0);
})();
