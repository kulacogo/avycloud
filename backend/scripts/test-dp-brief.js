'use strict';
// Probe SendCloud: list DP methods, create a fresh test parcel with the exact
// customer data that fails, and capture the verbose carrier error.
const { getSecretValue } = require('../lib/secret-values');

const BASE = 'https://panel.sendcloud.sc/api/v2';

(async () => {
  const pub = await getSecretValue('SENDCLOUD_PUBLIC_KEY');
  const sec = await getSecretValue('SENDCLOUD_SECRET_KEY');
  const auth = 'Basic ' + Buffer.from(`${pub}:${sec}`).toString('base64');

  console.log('=== DEUTSCHE POST METHODS ===');
  const mRes = await fetch(`${BASE}/shipping_methods`, { headers: { Authorization: auth } });
  const mBody = await mRes.json();
  const all = mBody.shipping_methods || [];
  const dp = all.filter(m => /deutsche_post|dpag|^dp$/i.test(m.carrier || '') || /\bbrief\b|warenpost|internetmarke/i.test(m.name || ''));
  console.log('DP methods found:', dp.length);
  for (const m of dp) {
    console.log(`  id=${m.id} carrier=${m.carrier} name="${m.name}" weight=${m.min_weight}..${m.max_weight}kg price=${m.price}`);
  }

  console.log('\n=== PORTO BALANCE ===');
  // DP Internetmarke balance endpoint (if configured)
  const bRes = await fetch(`${BASE}/services/dp_de/balance`, { headers: { Authorization: auth } });
  console.log('balance endpoint status:', bRes.status);
  if (bRes.ok) {
    console.log('balance body:', await bRes.text());
  } else {
    console.log('body:', (await bRes.text()).slice(0, 300));
  }

  console.log('\n=== FRESH TEST PARCEL (verbose carrier error) ===');
  // Use the exact data from order 16-14525-45108, with method 1224 (DP Warenpost)
  const payload = {
    parcel: {
      name: 'Rene Pohland',
      address: 'Karl-Liebknecht-Str.',
      house_number: '13',
      city: 'Jena',
      postal_code: '07749',
      country: 'DE',
      email: 'noreply@trendocean.de',
      telephone: '',
      order_number: 'DIAGNOSTIC-' + Date.now(),
      weight: '0.6',
      request_label: true,
      external_reference: 'diagnostic-test',
      shipment: { id: 1224 },
    },
  };
  const pRes = await fetch(`${BASE}/parcels?errors=verbose-carrier`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  console.log('POST /parcels status:', pRes.status);
  const pBody = await pRes.text();
  console.log('BODY:', pBody.slice(0, 2000));

  // If parcel was created, immediately cancel it so we don't orphan a test parcel
  try {
    const pJson = JSON.parse(pBody);
    if (pJson?.parcel?.id) {
      const cRes = await fetch(`${BASE}/parcels/${pJson.parcel.id}/cancel`, {
        method: 'POST',
        headers: { Authorization: auth },
      });
      console.log(`Cancelled test parcel ${pJson.parcel.id}, status: ${cRes.status}`);
    }
  } catch (_) {}
})().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
