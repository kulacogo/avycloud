function patch(p,exports){const id=require.resolve(p);require.cache[id]={id,filename:id,loaded:true,exports}}
const calls=[];let stock=0;
patch('../services/integration-store',{resolveProviderCredentials:async()=>({clientKey:'test',secretKey:'test'})});
patch('node-fetch',async(url,opts)=>{calls.push({url,method:opts.method,body:opts.body&&JSON.parse(opts.body)});return {ok:true,status:200,text:async()=>JSON.stringify({data:{id_offer:'SKU-TEST',amount:99}}),headers:{get:()=>null}}});
const query={where:()=>query,limit:()=>query,get:async()=>({docs:[{id:'p1',data:()=>({tenantId:'default',identification:{sku:'SKU-TEST'}})}]})};
patch('../lib/firestore',{firestore:{collection:()=>query}});
patch('../lib/marketplace-stock-quantity',{readMarketplaceQuantity:async()=>stock});
const {setUnitStatus}=require('../lib/kaufland-api');
beforeEach(()=>{calls.length=0;stock=0});
it('blocks direct activation without BIN-backed available stock',async()=>{await expect(setUnitStatus('1234','AVAILABLE')).rejects.toThrow(/Lagerplatz/);expect(calls.filter(c=>c.method==='PATCH')).toHaveLength(0)});
it('sets the verified quantity on activation rather than reviving an old amount',async()=>{stock=2;await setUnitStatus('1234','AVAILABLE');expect(calls.find(c=>c.method==='PATCH').body).toEqual({status:'AVAILABLE',amount:2})});
it('zero-stock shutdown never depends on a successful stock lookup',async()=>{await setUnitStatus('1234','ONHOLD');expect(calls).toHaveLength(1);expect(calls[0].body).toEqual({status:'ONHOLD',amount:0})});
