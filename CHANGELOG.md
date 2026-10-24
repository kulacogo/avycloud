# Changelog

Product changelog for AvyCloud: what changed, when, and why.
Newest entries first. `main` deploys straight to production, so entries are grouped by date instead of version.

Each entry: category (Added / Changed / Fixed / Removed), one-line headline, the reason, and the reference (bug ID, PR).
Keep entries short — longer write-ups go to `docs/incidents/` or `docs/features/` and are linked from here.

Not to be confused with `docs/kb/16-changelog.md`, which only tracks changes to the knowledge base itself.

## 2026-10-23

### Added
- **Language selector (EN/DE/TR)** next to the theme toggle, on desktop and on the mobile/scanner header. Sidebar, topbar page titles, breadcrumbs and the alert dropdown are translated. (#39)
  Why: not everyone on the team works best in German. The choice is stored per device; German labels are unchanged and pinned by a test. Page content below the frame is not translated yet.

### Fixed
- **Stowing: stray scans could book huge quantities** — a digits-only scan counts as a quantity only once SKU and BIN are set, and only 1–999. The number pad and desktop field ignore anything above 999. (BUG-096, #41)
  Why: every digits-only scan was taken as a quantity, even before SKU/BIN. A scanned EAN (e.g. 4006381333931) landed in the quantity field with no upper limit.
- **Stowing: an unconfirmed item was silently lost** — with SKU and BIN set, scanning the next item is now blocked with a hint ("Erst Menge bestätigen oder Zurücksetzen."), vibration and a pulsing confirm button. (BUG-097, #41)
  Why: the scan was dropped without a trace, so the operator assumed the item was booked.
- **Stowing: strict scan order SKU → BIN → quantity** — a BIN in the SKU slot (or the other way round) is rejected and the expected box pulses; the active step is highlighted. (#41)
  Why: wrong-order scans were the other way to book the wrong thing. Product labels always start with `SKU-`, no BIN does, so the order can be enforced reliably.
  Verified on a handheld scanner. Follow-up: check the BIN live right after scanning (WH-003).
- **CI: hosting deploy pinned to Firebase CLI 15.34.0.** (#40)
  Why: the Hosting action pulled the latest CLI, which failed on a Service Usage IAM permission. 15.34.0 is the version from the last successful deploy; the IAM issue is handled separately.
