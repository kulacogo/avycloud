function patch(p,exports){const id=require.resolve(p);require.cache[id]={id,filename:id,loaded:true,exports}}
const calls=[];
patch('../services/integration-store',{resolveProviderCredentials:async()=>({clientKey:'test',secretKey:'test'})});
patch('node-fetch',async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return {ok:true,status:200,text:async()=>JSON.stringify({data:{}}),headers:{get:()=>null}}});
patch('../lib/firestore',{firestore:{collection:()=>({add:async()=>{}})}});
const {syncPriceToAllChannels}=require('../services/stock-sync-dispatcher');
const {pickUnitData}=require('../lib/kaufland-api');
const product=()=>({id:'p1',tenantId:'default',identification:{sku:'SKU-TEST'},inventory:{quantity:1},ops:{kaufland:{unitId:'1234'}},details:{identifiers:{ean:'4006633144780'},pricing:{sellPrice:29}}});
it('price sync cannot reopen a sold Kaufland unit',async()=>{calls.length=0;await syncPriceToAllChannels({tenantId:'default',product:product(),prices:{kaufland:29}});expect(calls).toHaveLength(1);expect(calls[0].body).not.toHaveProperty('amount');expect(calls[0].body).not.toHaveProperty('status');expect(calls[0].body.listing_price).toBe(2900)});
it('stale availableQuantity cannot overrule zero stock',()=>{const p=product();p.inventory={quantity:0,availableQuantity:7};expect(pickUnitData(p,{mode:'update'}).patchData.amount).toBe(0)});

it('rechecks location availability immediately before a stock update',async()=>{calls.length=0;const spy=vi.spyOn(require('../lib/marketplace-stock-quantity'),'readMarketplaceQuantity').mockResolvedValue(0);try{const p=product();p.storageBins=[{code:'A-01',quantity:1}];await require('../lib/kaufland-api').updateUnit('1234',p);expect(spy).toHaveBeenCalled();expect(calls[0].body).toMatchObject({amount:0,status:'ONHOLD'})}finally{spy.mockRestore()}});
it('does not publish a stock update when fresh verification fails',async()=>{calls.length=0;const spy=vi.spyOn(require('../lib/marketplace-stock-quantity'),'readMarketplaceQuantity').mockRejectedValue(new Error('stock unavailable'));try{const p=product();p.storageBins=[{code:'A-01',quantity:1}];await expect(require('../lib/kaufland-api').updateUnit('1234',p)).rejects.toThrow('stock unavailable');expect(calls).toHaveLength(0)}finally{spy.mockRestore()}});
