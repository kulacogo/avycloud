// globals: true in vitest.config.js — describe/it/expect are global
//
// Guards the eBay call-volume fix: stock-sync must NEVER resolve an itemId from
// an ended/inactive live listing. Falling back to an inactive row (the old
// `find(active) || docs[0]`) made it re-push to dead listings every cycle —
// production logs showed 600+ wasted "already ended" eBay calls/day from 14
// dead listings (one hit 234×/day).

require("./_patchGcp"); // mock GCP so lib/firestore can load without credentials
const { pickActiveListing, isRateLimited } = require("../../services/stock-sync-dispatcher");

describe("pickActiveListing", () => {
  it("returns the active listing", () => {
    const docs = [{ itemId: "A", active: true }];
    expect(pickActiveListing(docs)).toEqual({ itemId: "A", active: true });
  });

  it("treats missing `active` as active (legacy rows)", () => {
    expect(pickActiveListing([{ itemId: "A" }])).toEqual({ itemId: "A" });
  });

  it("returns null when ALL listings are inactive (the regression guard)", () => {
    const docs = [{ itemId: "DEAD1", active: false }, { itemId: "DEAD2", active: false }];
    expect(pickActiveListing(docs)).toBeNull(); // must NOT fall back to a dead listing
  });

  it("prefers an active row over inactive ones", () => {
    const docs = [{ itemId: "DEAD", active: false }, { itemId: "LIVE", active: true }];
    expect(pickActiveListing(docs)).toEqual({ itemId: "LIVE", active: true });
  });

  it("is defensive against empty / non-array input", () => {
    expect(pickActiveListing([])).toBeNull();
    expect(pickActiveListing(null)).toBeNull();
    expect(pickActiveListing(undefined)).toBeNull();
  });
});

describe("isRateLimited", () => {
  it("detects eBay daily-call-limit errors (must defer, not fail-safe-end)", () => {
    expect(isRateLimited("Your application has exceeded usage limit on this call, please make call to GetAPIAccessRules to check your call usage.")).toBe(true);
    expect(isRateLimited("Exceeded Usage Limit")).toBe(true);
  });

  it("does not misclassify other errors as rate limits", () => {
    expect(isRateLimited("Auction ended")).toBe(false);
    expect(isRateLimited("")).toBe(false);
    expect(isRateLimited(null)).toBe(false);
  });
});
