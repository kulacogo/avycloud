const stock=require('../lib/marketplace-stock-quantity');
const product={id:'p1',tenantId:'default',identification:{sku:'SKU-A'},inventory:{quantity:5}};
const deps=(p,reserved=0)=>({firestore:{collection:()=>({doc:()=>({get:async()=>({exists:!!p,id:'p1',data:()=>p})})})},getReservedQuantity:async()=>reserved});
it('reads current stock rather than stale publish input',async()=>expect(await stock.readMarketplaceQuantity(product,undefined,deps({...product,inventory:{quantity:0}}))).toBe(0));
it('deducts order reservations before publishing',async()=>expect(await stock.readMarketplaceQuantity(product,undefined,deps(product,5))).toBe(0));
it('clamps explicit overrides to fresh availability',async()=>expect(await stock.readMarketplaceQuantity(product,99,deps(product,3))).toBe(2));
it('fails closed if the product disappears',async()=>await expect(stock.readMarketplaceQuantity(product,undefined,deps(null))).rejects.toThrow());
it('rejects cross-tenant reads',async()=>await expect(stock.readMarketplaceQuantity(product,undefined,deps({...product,tenantId:'foreign'}))).rejects.toThrow());
it('does not assume unreserved stock on read failure',async()=>await expect(stock.readMarketplaceQuantity(product,undefined,{...deps(product),getReservedQuantity:async()=>{throw Error('unavailable')}})).rejects.toThrow('unavailable'));
