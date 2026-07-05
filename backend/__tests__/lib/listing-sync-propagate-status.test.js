'use strict';

/**
 * Regression (2026-07-05, letzte Meile des eBay-Token-Incidents):
 *
 * Der Spiegel (ebayListingsLive) war nach der bestätigten Massen-Deaktivierung
 * korrekt auf active:false — aber propagateEbayStatusToProducts wertete Docs
 * per OR (`active || listingStatus === 'active'`) weiter als aktiv, weil der
 * listingStatus-STRING noch vom letzten Fetch VOR der Deaktivierung stammte
 * ("Active" vom 30.06.). Ergebnis: 615 Produkte behielten "aktiv bei eBay"
 * samt frischem lastSyncAt, obwohl real 0 Angebote online waren.
 *
 * Neu: ein EXPLIZITES active:false gewinnt immer. Die Deaktivierung läuft
 * heute nur noch über die Zwei-Ingest-Bestätigung und heilt sich beim
 * nächsten erfolgreichen Sync selbst (Upsert setzt active:true) — der
 * String-Fallback bleibt nur für Alt-Docs ohne boolean.
 */

require('../api/_patchGcp');
require('../api/_patchLocalModules');

const { propagateEbayStatusToProducts } = require('../../services/listing-sync-runner');
const firestoreModule = require('../../lib/firestore');

function installFakeFirestore({ links, listings, existingProducts, staleActiveProducts }) {
  const updates = [];

  const asDocs = (obj) => Object.entries(obj).map(([id, data]) => ({ id, data: () => data }));

  firestoreModule.firestore.collection = (name) => {
    if (name === 'ebayListingLinks') {
      return { get: async () => ({ empty: Object.keys(links).length === 0, docs: asDocs(links) }) };
    }
    if (name === 'ebayListingsLive') {
      return { get: async () => ({ docs: asDocs(listings) }) };
    }
    if (name === 'products_v2') {
      return {
        doc: (id) => ({ __id: id }),
        where: () => ({
          get: async () => ({
            docs: staleActiveProducts.map((id) => ({
              id,
              ref: { __id: id },
            })),
          }),
        }),
      };
    }
    throw new Error(`unexpected collection ${name}`);
  };
  firestoreModule.firestore.getAll = async (...refs) =>
    refs.map((r) => ({ id: r.__id, exists: existingProducts.includes(r.__id) }));
  firestoreModule.firestore.batch = () => ({
    update: (ref, patch) => updates.push({ id: ref.__id, patch }),
    commit: async () => [],
  });

  return updates;
}

describe('propagateEbayStatusToProducts — explizites active:false gewinnt', () => {
  it('deaktivierter Spiegel-Eintrag mit veraltetem listingStatus-String → Produkt wird inactive', async () => {
    const updates = installFakeFirestore({
      links: { item1: { productId: 'prodA' }, item2: { productId: 'prodB' } },
      listings: {
        // Der Incident-Fall: bestätigt deaktiviert, aber String noch "Active" vom 30.06.
        item1: { active: false, listingStatus: 'Active' },
        // Wirklich aktiv:
        item2: { active: true, listingStatus: 'Active' },
      },
      existingProducts: ['prodA', 'prodB'],
      staleActiveProducts: [],
    });

    await propagateEbayStatusToProducts();

    const byId = Object.fromEntries(updates.map((u) => [u.id, u.patch['ops.listingStatus.ebay']]));
    expect(byId.prodA).toBe('inactive');
    expect(byId.prodB).toBe('active');
  });

  it('Alt-Doc ohne boolean: listingStatus-String zählt weiterhin (Fallback bleibt)', async () => {
    const updates = installFakeFirestore({
      links: { item3: { productId: 'prodC' } },
      listings: { item3: { listingStatus: 'Active' } }, // kein active-Feld
      existingProducts: ['prodC'],
      staleActiveProducts: [],
    });

    await propagateEbayStatusToProducts();

    const byId = Object.fromEntries(updates.map((u) => [u.id, u.patch['ops.listingStatus.ebay']]));
    expect(byId.prodC).toBe('active');
  });

  it('Stale-Cleanup setzt Produkte ohne aktives Listing auf not_listed', async () => {
    const updates = installFakeFirestore({
      links: { item1: { productId: 'prodA' } },
      listings: { item1: { active: false, listingStatus: 'Active' } },
      existingProducts: ['prodA'],
      staleActiveProducts: ['prodGhost'], // hängt auf 'active', hat aber kein aktives Listing
    });

    await propagateEbayStatusToProducts();

    const ghost = updates.find((u) => u.id === 'prodGhost');
    expect(ghost.patch['ops.listingStatus.ebay']).toBe('not_listed');
  });
});
