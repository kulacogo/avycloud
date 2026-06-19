'use strict';

const { mapListingDetail } = require('../lib/ebay-trading-api');

describe('mapListingDetail — Best-Offer auto-decline threshold (WP2 read path)', () => {
  it('captures the auto-decline threshold (MinimumBestOfferPrice) and auto-accept price', () => {
    const item = {
      ItemID: '123',
      BestOfferDetails: {
        BestOfferEnabled: 'true',
        BestOfferAutoAcceptPrice: { '#text': '25.00', currencyID: 'EUR' },
      },
      ListingDetails: {
        MinimumBestOfferPrice: { '#text': '10.00', currencyID: 'EUR' },
      },
      SellingStatus: { CurrentPrice: { '#text': '30.00', currencyID: 'EUR' } },
    };
    const d = mapListingDetail(item);
    expect(d.minimumBestOfferPrice).toBe(10);      // the auto-DECLINE threshold the guard needs
    expect(d.bestOfferAutoAcceptPrice).toBe(25);
    expect(d.bestOfferEnabled).toBe(true);
  });

  it('reports no threshold when Best Offer is not configured on the listing', () => {
    const d = mapListingDetail({ ItemID: '123', SellingStatus: { CurrentPrice: { '#text': '30.00' } } });
    expect(d.minimumBestOfferPrice).toBeNull();
    expect(d.bestOfferAutoAcceptPrice).toBeNull();
    expect(d.bestOfferEnabled).toBe(false);
  });

  it('parses a bare-string threshold (not currency-wrapped)', () => {
    const d = mapListingDetail({ ItemID: '1', ListingDetails: { MinimumBestOfferPrice: '12.50' } });
    expect(d.minimumBestOfferPrice).toBe(12.5);
  });
});
