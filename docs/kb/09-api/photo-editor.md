---
title: API — Photo editor persistence capability
for: [dev, agent, admin]
lastReviewed: 2026-09-27
---

# Photo editor capability

`GET /api/images/editor-capabilities` is mounted by
[backend/routes/products.js](../../../backend/routes/products.js).

- Authentication and permission: existing Firebase auth plus
  `requirePermission('products', 'write')`, matching product save.
- Request: no body or query parameters.
- Response: `200 {"ok":true,"data":{"version":1}}` with
  `Cache-Control: no-store`.
- No database queries, uploads or product writes. The response only advertises
  the deployed save handler's ability to persist editor assets safely.
- Failure: normal authentication/permission errors, or structured `500`.

Before saving a product containing `details.images[].photoEditor`, the frontend
requires version 1 from this endpoint. Missing/unsupported capability or a
network failure prevents that save. This protects the independently deployed
Firebase frontend from submitting inline original/mask metadata to an older
Cloud Run save handler. Unedited legacy products retain their normal save path.

The capability must not be cached across saves: a backend rollback can remove
support. Deployment and rollback should still keep web traffic on one compatible
backend revision; a preflight check is not an atomic protocol negotiation across
two separate HTTP requests.

Asset contract and limits:
[Photo editor persistence](../../features/IMG-001-image-enhancement/persistence.md).
Coverage:
[API regression](../../../backend/__tests__/api/products-photo-editor.test.js).
