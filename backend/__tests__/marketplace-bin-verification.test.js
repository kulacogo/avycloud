const { readLocatedQuantity } = require('../lib/marketplace-stock-quantity');
const product={id:'p1',tenantId:'default',identification:{sku:'SKU-1'},storageBins:[{code:'A-01',quantity:3}]};
const db=bins=>({collection:()=>({doc:id=>({get:async()=>({exists:!!bins[id],data:()=>bins[id]})})})});
it('rejects a stale product location whose BIN no longer contains the article',async()=>expect(await readLocatedQuantity(product,db({'A-01':{products:[{productId:'other',quantity:3}]}}))).toBe(0));
it('caps projection quantities by actual BIN contents',async()=>expect(await readLocatedQuantity(product,db({'A-01':{products:[{productId:'p1',quantity:1}]}}))).toBe(1));
it('does not multiply duplicate product-location rows',async()=>expect(await readLocatedQuantity({...product,storageBins:[...product.storageBins,...product.storageBins]},db({'A-01':{products:[{sku:'SKU-1',quantity:2}]}}))).toBe(2));
it('treats a missing BIN as no assigned stock',async()=>expect(await readLocatedQuantity(product,db({}))).toBe(0));
it('rejects a foreign BIN rather than closing offers on an ownership error',async()=>await expect(readLocatedQuantity(product,db({'A-01':{tenantId:'foreign',products:[]}}))).rejects.toThrow('tenant'));
it('propagates unavailable BIN reads for retry without marketplace mutation',async()=>await expect(readLocatedQuantity(product,{collection:()=>({doc:()=>({get:async()=>{throw Error('unavailable')}})})})).rejects.toThrow('unavailable'));
