require('./api/_patchGcp');
require('./api/_patchLocalModules');
const {mapProductToEbayItem,validatePublishReadiness}=require('../lib/ebay-direct');
const base=()=>({id:'p-zero',tenantId:'default',ops:{readiness:'ready'},identification:{sku:'SKU-TEST',name:'Test product'},details:{categoryId:'33564',identifiers:{ean:'4006633144780'},pricing:{sellPrice:29},images:[{url:'https://example.com/a.jpg'}]},inventory:{quantity:0},storageBins:[]});
describe('marketplace zero-stock invariant',()=>{
 it('never invents one unit from the eBay fallback',()=>expect(mapProductToEbayItem(base()).quantity).toBe(0));
 it('ignores old marketplace quantity and stale BINs when inventory is zero',()=>{const p=base();p.marketplace={ebay:{quantity:5}};p.storageBins=[{quantity:2}];expect(mapProductToEbayItem(p).quantity).toBe(0)});
 it('cannot override zero physical stock into a sale',()=>expect(mapProductToEbayItem(base(),{quantity:5}).quantity).toBe(0));
 it('respects all units being reserved',()=>{const p=base();p.inventory={quantity:1,availableQuantity:0};expect(mapProductToEbayItem(p).quantity).toBe(0)});
 it('blocks publishing with zero stock regardless of readiness override',()=>{const r=validatePublishReadiness(base(),{allowNonReady:true,quantity:1});expect(r.canPublish).toBe(false);expect(r.blockers.some(x=>/bestand/i.test(x))).toBe(true)});
 it('blocks relocation stock without a BIN',()=>{const p=base();p.inventory={quantity:2};p.ops.relocation={unassignedQuantity:2};expect(mapProductToEbayItem(p).quantity).toBe(0)});
 it('never sends quantity during a content-only revise',()=>{const fs=require('fs');const src=fs.readFileSync(require.resolve('../lib/ebay-direct'),'utf8');const fn=src.slice(src.indexOf('async function reviseListingFromProduct('));expect(fn.slice(0,fn.indexOf('console.info'))).not.toMatch(/quantity:\s*item.quantity/)});
});
