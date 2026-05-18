# `_assets/` — Knowledge-Base Asset Folder (Placeholder)

> Static assets referenced from the AvyCloud Knowledge Base live here.

## Purpose

This folder is a **placeholder** for binary or static files that KB pages embed:

- Architecture diagrams (`.svg`, `.png`)
- Sequence diagrams exported from draw.io / mermaid render snapshots
- Screenshots for `docs/kb/05-pages/*.md` walkthroughs
- Sample CSV / JSON fixtures referenced in `docs/kb/10-data/schemas/*`
- Wireframes / mockups for `docs/kb/06-features/*`

## Naming Convention

Use a `<area>-<topic>-<version>.<ext>` pattern so files are self-describing:

```
arch-system-overview-v1.svg
seq-order-lifecycle-shipped-v2.png
page-inventory-bulk-edit-2026-05.png
schema-product-v2-er-diagram.svg
```

## Rules

1. **Read-only by convention.** Files here are never imported by application code at runtime — they are pure documentation aids.
2. **No secrets, no PII.** Screenshots must be scrubbed of customer data, tokens, and internal SKUs that map to real tenants.
3. **Prefer SVG for diagrams**, PNG only for raster screenshots. Keep individual files < 1 MB.
4. **Link, don't inline.** KB pages should reference assets with a relative link, e.g. `![Order lifecycle](../_assets/seq-order-lifecycle-shipped-v2.png)`.
5. **Versioned overwrites are fine** — bump the `-vN` suffix or date suffix instead of overwriting in place.

## Adding an Asset

1. Drop the file in this folder following the naming convention.
2. Reference it from the relevant KB page.
3. If the asset replaces an older version, mark the old one as `*-deprecated.<ext>` rather than deleting (so external links in old PRs / Slack threads stay valid for one release cycle).

## Currently empty

This folder ships empty by design; assets are added on demand as KB pages need them. See [`docs/kb/00-INDEX.md`](../00-INDEX.md) for the master index.
