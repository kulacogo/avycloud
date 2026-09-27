const stock=require('../lib/marketplace-stock-quantity');
const product={id:'p1',tenantId:'default',identification:{sku:'SKU-A'},inventory:{quantity:5},storageBins:[{code:'A-01',quantity:5}]};
const deps=(p,reserved=0)=>({firestore:{collection:name=>({doc:()=>({get:async()=>({exists:!!p,id:'p1',data:()=>name === 'warehouseBins' ? {products:[{productId:'p1',quantity:5}]} : p})})})},getReservedQuantity:async()=>reserved});
it('reads current stock rather than stale publish input',async()=>expect(await stock.readMarketplaceQuantity(product,undefined,deps({...product,inventory:{quantity:0}}))).toBe(0));
it('deducts order reservations before publishing',async()=>expect(await stock.readMarketplaceQuantity(product,undefined,deps(product,5))).toBe(0));
it('clamps explicit overrides to fresh availability',async()=>expect(await stock.readMarketplaceQuantity(product,99,deps(product,3))).toBe(2));
it('fails closed if the product disappears',async()=>await expect(stock.readMarketplaceQuantity(product,undefined,deps(null))).rejects.toThrow());
it('rejects cross-tenant reads',async()=>await expect(stock.readMarketplaceQuantity(product,undefined,deps({...product,tenantId:'foreign'}))).rejects.toThrow());
it('does not assume unreserved stock on read failure',async()=>await expect(stock.readMarketplaceQuantity(product,undefined,{...deps(product),getReservedQuantity:async()=>{throw Error('unavailable')}})).rejects.toThrow('unavailable'));

it('only sells located units, with no relocation exception',async()=>{const p={...product,storageBins:[{code:'A-01',quantity:2}],ops:{relocation:{unassignedQuantity:3}}};expect(await stock.readMarketplaceQuantity(product,undefined,deps(p,1))).toBe(1)});
it('blocks a positive ledger with no warehouse location',async()=>expect(await stock.readMarketplaceQuantity(product,undefined,deps({...product,storageBins:[]}))).toBe(0));
it('does not use a stale primary BIN when the allocation list is empty',()=>expect(stock.resolveMarketplaceQuantity({...product,storageBins:[],storage:{binCode:'A-01',quantity:5}})).toBe(0));
it('does not count quantities without a named location',()=>expect(stock.resolveMarketplaceQuantity({...product,storageBins:[{quantity:5}]})).toBe(0));
it('does not double count duplicate location rows',()=>expect(stock.resolveMarketplaceQuantity({...product,storageBins:[{code:'A-01',quantity:2},{code:'A-01',quantity:2}]})).toBe(2));
