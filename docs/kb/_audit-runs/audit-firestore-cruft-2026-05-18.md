# Firestore Cruft Audit — 2026-05-18

Project: `unknown`
Total root collections: 55
Errors: 0

## Collections

| Collection | DocCount | ReferencedInCode | OrphanCount | Classification | OperatorActionNeeded |
|------------|----------|------------------|-------------|----------------|----------------------|
| adminBulkJobs | 98 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| audit_log | 2026 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| auditLogs | 43 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| baselinker_sku_index | 1634 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| baselinkerSyncJobs | 230 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| categoryProfiles | 306 (count-aggregation) | yes | 0 | ACTIVE | No action |
| chatSessions | 500 (count-aggregation) | yes | 0 | ACTIVE | No action |
| company_settings | 1 (count-aggregation) | yes | 0 | ACTIVE | No action |
| ebayListingGaps | 1404 (count-aggregation) | yes | 0 | ACTIVE | No action |
| ebayListingLinks | 583 (count-aggregation) | yes | 0 | ACTIVE | No action |
| ebayListingReports | 120 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| ebayListingsLive | 591 (count-aggregation) | yes | 0 | ACTIVE | No action |
| ebayPublishLog | 962 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| external_api_calls | 927 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| gpsrManufacturers | 838 (count-aggregation) | yes | 0 | ACTIVE | No action |
| identificationJobs | 177 (count-aggregation) | yes | 0 — orphan-count failed: 9 FAILED_PRECONDITION: The query requires an index. You can  | ACTIVE | No action |
| improveJobs | 4026 (count-aggregation) | yes | 0 — orphan-count failed: 9 FAILED_PRECONDITION: The query requires an index. You can  | ACTIVE | No action |
| integration_settings | 3 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| integrations | 1 (count-aggregation) | yes | 0 | ACTIVE | No action |
| inventories | 9 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| inventory_ledger | 260 (count-aggregation) | yes | 0 | ACTIVE | No action |
| inventorySyncLogs | 16557 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| invoices | 1343 (count-aggregation) | yes | 0 | ACTIVE | No action |
| kauflandUnitsLive | 643 (count-aggregation) | yes | 0 | ACTIVE | No action |
| llmScopes | 15 (count-aggregation) | yes | 0 | ACTIVE | No action |
| metaCounters | 1 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| number_sequences | 3 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| oauthStates | 10 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| ops | 1 (count-aggregation) | yes | 0 | ACTIVE | No action |
| order_events | 1997 (count-aggregation) | yes | 0 | ACTIVE | No action |
| order_settings | 1 (count-aggregation) | yes | 0 | ACTIVE | No action |
| orders | 893 (count-aggregation) | yes | 0 | ACTIVE | No action |
| products | 663 (count-aggregation) | yes | 0 | ACTIVE | No action |
| products_v2 | 1386 (count-aggregation) | yes | 0 — ghost-like in first 500 docs (title=SKU-* / UUID / ==barcode) | ACTIVE | No action |
| qualityJobs | 10930 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| returns | 86 (count-aggregation) | yes | 0 | ACTIVE | No action |
| roles | 4 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| rulebookApplyJobs | 14 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| rulebookConfigs | 1 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| shipments | 759 (count-aggregation) | yes | 0 | ACTIVE | No action |
| shipping_methods | 146 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| sku_index | 734 (count-aggregation) | yes | 0 | ACTIVE | No action |
| stock_locks | 1 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| stock_operation_failures | 10 (count-aggregation) | yes | 0 — status == abandoned | ACTIVE | No action |
| stock_reconciliation_log | 4699 (count-aggregation) | yes | 0 | ACTIVE | No action |
| stock_reservations | 821 (count-aggregation) | yes | 0 | ACTIVE | No action |
| stock_sync_failures | 51380 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| stock_sync_log | 183149 (count-aggregation) | yes | 0 | ACTIVE | No action |
| trendocean | 1 (count-aggregation) | yes | 0 | ACTIVE | No action |
| user_profiles | 1 (count-aggregation) | yes | 0 | ACTIVE | No action |
| users | 7 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| userSessions | 1251 (count-aggregation) | no | 0 | POTENTIALLY_DEAD | Investigate: collection not referenced in backend code |
| warehouseBins | 219 (count-aggregation) | yes | 0 | ACTIVE | No action |
| warehouseEvents | 2792 (count-aggregation) | yes | 0 | ACTIVE | No action |
| warehouseZones | 6 (count-aggregation) | yes | 0 | ACTIVE | No action |

## Sample Docs

### `adminBulkJobs`

| Doc ID | Key Fields |
|--------|------------|
| 05o40KkGFv1GWD9jycOE | createdAt, payload, requestedBy, action, startedAt, attempts |
| 0vBboIKzJMrouqIX75lA | createdAt, payload, requestedBy, action, attempts, startedAt |
| 1kDs41q42826R3Rw3BEI | createdAt, payload, requestedBy, action, startedAt, attempts |

### `auditLogs`

| Doc ID | Key Fields |
|--------|------------|
| 1lUm7ZH600oUkTg2ZYXe | actorUid, action, targetUid, diff, at |
| 2JhV3RlMDAvgnFn1QwZr | actorUid, action, targetUid, diff, at |
| 4kGYBA3AnnTwbhFwwEVf | actorUid, action, targetUid, diff, at |

### `audit_log`

| Doc ID | Key Fields |
|--------|------------|
| 0035vbAWuvZkRnkDjzFz | action, userId, userEmail, tenantId, resourceType, resourceId |
| 00IzBI38kITnIp1GpIDE | action, userId, userEmail, tenantId, resourceType, resourceId |
| 044VRktJgKUBd7TnUZ5A | action, userId, userEmail, tenantId, resourceType, resourceId |

### `baselinkerSyncJobs`

| Doc ID | Key Fields |
|--------|------------|
| 0BgcPlvlnes5bKFbKadr | createdAt, error, payload, requestedBy, startedAt, attempts |
| 0WBWgLqe16AlED22sWzi | createdAt, error, payload, requestedBy, startedAt, attempts |
| 0bLVXxxLMh0U9R1rrotU | createdAt, error, payload, requestedBy, startedAt, attempts |

### `baselinker_sku_index`

| Doc ID | Key Fields |
|--------|------------|
| ean:000992237279 | ean, productId, baseProductId, sku, updated_at |
| ean:00155403040304 | ean, productId, updated_at, baseProductId, sku |
| ean:0017158413901780 | ean, productId, updated_at, baseProductId, sku |

### `categoryProfiles`

| Doc ID | Key Fields |
|--------|------------|
| 101428 | attributeAliases, notes, canonicalAttributes, id, enabled, updatedAtIso |
| 103428 | attributeAliases, notes, canonicalAttributes, id, enabled, updatedAtIso |
| 1059 | attributeAliases, notes, canonicalAttributes, id, enabled, updatedAtIso |

### `chatSessions`

| Doc ID | Key Fields |
|--------|------------|
| BTiU8QjGmWUf0mfX8LJsHSYpyGY2__0024062741710 | id, userId, productId, messages, createdAt, updatedAt |
| T2mOTT0me6YLFfxPIEF9aJRHH6X2__0000000000000 | id, userId, productId, createdAt, messages, updatedAt |
| T2mOTT0me6YLFfxPIEF9aJRHH6X2__0024062741710 | id, userId, productId, createdAt, messages, updatedAt |

### `company_settings`

| Doc ID | Key Fields |
|--------|------------|
| default | website, updatedBy, strasse, firmenname, ustIdNr, ort |

### `ebayListingGaps`

| Doc ID | Key Fields |
|--------|------------|
| 389323406448 | linkStatus, itemId, productId, listingSku, actor, runId |
| 389323411122 | linkStatus, itemId, productId, listingSku, actor, runId |
| 389323411754 | linkStatus, itemId, productId, listingSku, actor, runId |

### `ebayListingLinks`

| Doc ID | Key Fields |
|--------|------------|
| 389862434704 | itemId, method, productId, evidence, confidence, listingSku |
| 389862434791 | actor, itemId, method, productId, evidence, confidence |
| 389862435109 | itemId, method, productId, evidence, confidence, listingSku |

### `ebayListingReports`

| Doc ID | Key Fields |
|--------|------------|
| api-1771099786817 | actor, createdAt, detailErrors, generatedAt, upsert, links |
| api-1771104208915 | actor, createdAt, detailErrors, generatedAt, upsert, links |
| api-1771109499242 | actor, createdAt, detailErrors, generatedAt, upsert, links |

### `ebayListingsLive`

| Doc ID | Key Fields |
|--------|------------|
| 389862434704 | lastSeenAt, quantityTotal, viewItemUrl, listingType, title, firstSeenAt |
| 389862434791 | lastSeenAt, viewItemUrl, currentPrice, listingType, title, firstSeenAt |
| 389862435109 | lastSeenAt, quantityTotal, active, currentPrice, listingType, snapshotHashSummary |

### `ebayPublishLog`

| Doc ID | Key Fields |
|--------|------------|
| 03PLW0S1mQZYWvDLF4vk | productId, itemId, sku, title, ack, fees |
| 046B6SJyMcqHvyArJ7mo | productId, itemId, sku, title, ack, fees |
| 06Zcn4VK3VY1uzDzg4ak | productId, itemId, sku, title, ack, fees |

### `external_api_calls`

| Doc ID | Key Fields |
|--------|------------|
| 04GpkL4XI7M5M4TEzKP5 | tenantId, timestamp, service, endpoint, success, latencyMs |
| 06hD1Nfdb9XJM7EZbcks | tenantId, timestamp, service, endpoint, success, latencyMs |
| 09sxD9BYXP8OKn0dp1q8 | tenantId, timestamp, service, endpoint, success, latencyMs |

### `gpsrManufacturers`

| Doc ID | Key Fields |
|--------|------------|
| 3m-deutschland-gmbh | manufacturer_name, gpsr, confidence, sources, last_product_id, score |
| 3s-gmbh-and-co-kg | confidence, sources, score, last_product_id, gpsr, manufacturer_name |
| 7-oclock-gmbh | manufacturer_name, gpsr, confidence, last_product_id, score, updated_at_iso |

### `identificationJobs`

| Doc ID | Key Fields |
|--------|------------|
| 00e2a8bb-4d8f-4071-8eab-4fa06368db13 | createdAt, payload, startedAt, attempts, result, serpTrace |
| 0317ca69-42dc-4668-9e9a-1f1ce246c472 | createdAt, payload, startedAt, attempts, modelUsed, status |
| 043f3f3b-204b-47fa-a130-167666d5930d | createdAt, payload, startedAt, attempts, result, serpTrace |

### `improveJobs`

| Doc ID | Key Fields |
|--------|------------|
| 0003f51f-0f75-4636-8f0a-b43befba0f23 | createdAt, payload, productId, productName, attempts, startedAt |
| 0007ae09-9591-4495-b95f-00630540bb38 | productId, productName, payload, createdAt, attempts, startedAt |
| 000844f4-b2b1-49c4-94d0-4d412fc21586 | createdAt, payload, productId, productName, attempts, startedAt |

### `integration_settings`

| Doc ID | Key Fields |
|--------|------------|
| default__ebay | integration, tenantId, updatedBy, defaults, updatedAt, cachedData |
| default__kaufland | integration, tenantId, updatedBy, defaults, updatedAt, cachedData |
| default__sendcloud | cachedData, lastSyncedAt, integration, tenantId, updatedBy, defaults |

### `integrations`

| Doc ID | Key Fields |
|--------|------------|
| ebay | provider, connectedBy, env, tokenType, scopes, refreshTokenExpiresAt |

### `inventories`

| Doc ID | Key Fields |
|--------|------------|
| 78659 | defaultWarehouse, isExternal, description, isActive, type, defaultPriceGroup |
| 84529 | defaultWarehouse, isExternal, description, isActive, type, defaultPriceGroup |
| 84535 | defaultWarehouse, isExternal, description, isActive, type, defaultPriceGroup |

### `inventorySyncLogs`

| Doc ID | Key Fields |
|--------|------------|
| 001sddylmjh49rPjkqmk | productId, inventoryId, status, message, createdAt |
| 002zoa7309BOcABaK3wZ | productId, inventoryId, status, message, createdAt |
| 00aczRrcM1VQoGDZ9T0U | productId, inventoryId, status, message, createdAt |

### `inventory_ledger`

| Doc ID | Key Fields |
|--------|------------|
| 04ZpLMhjEnRzZXXuzEKI | tenantId, productId, sku, before, after, delta |
| 0Afui4HKHaRtiggGfJaa | tenantId, productId, sku, before, after, delta |
| 0rpq1GMu1kl1xwW4UIl2 | tenantId, productId, sku, before, after, delta |

### `invoices`

| Doc ID | Key Fields |
|--------|------------|
| 00osUzif04a0CCxn7IR8 | tenantId, sevdeskId, invoiceNumber, date, dueDate, status |
| 01cp2Cjnlg2f31VjP2gK | tenantId, sevdeskId, invoiceNumber, date, dueDate, status |
| 04ajGr5r79I1qXfR4Tn5 | tenantId, sevdeskId, invoiceNumber, date, dueDate, amountGross |

### `kauflandUnitsLive`

| Doc ID | Key Fields |
|--------|------------|
| 391066477716 | id_offer_normalized, amount, active, id_offer, id_unit, storefront |
| 391066477801 | id_offer_normalized, amount, active, id_offer, id_unit, storefront |
| 391066477859 | id_offer_normalized, amount, active, id_offer, id_unit, storefront |

### `llmScopes`

| Doc ID | Key Fields |
|--------|------------|
| chat.product | createdAt, scopeId, defaultModelEnvKey, activatedByUid, activeVersionId, purpose |
| chat.update_datasheet | createdAt, scopeId, purpose, activeVersionId, defaultModelEnvKey, name |
| identify.attributes | createdAt, scopeId, purpose, activeVersionId, defaultModelEnvKey, name |

### `metaCounters`

| Doc ID | Key Fields |
|--------|------------|
| sku10 | next, updated_at |

### `number_sequences`

| Doc ID | Key Fields |
|--------|------------|
| default__delivery_note | year, prefix, tenantId, currentNumber, type, padLength |
| default__invoice | year, prefix, tenantId, type, padLength, currentNumber |
| default__order | year, prefix, tenantId, type, padLength, currentNumber |

### `oauthStates`

| Doc ID | Key Fields |
|--------|------------|
| 06b1d5b8-fad6-49c9-a27d-43facc7aedc4 | provider, actor, createdAt |
| 1fba1a93-50bb-4090-93f9-e58a8295a8cb | provider, actor, createdAt |
| 34985be6-4f69-4708-afda-d22a693bf96b | provider, actor, createdAt |

### `ops`

| Doc ID | Key Fields |
|--------|------------|
| ebayLightSync | updatedAt, runningActor, runningRunId, runningAtIso, running, lastCompletedRunId |

### `order_events`

| Doc ID | Key Fields |
|--------|------------|
| 05wjcP7cthpr4D9P4t82 | orderId, tenantId, event, fromStatus, toStatus, fromStatusLabel |
| 06cstJPKZDgqh8jQIksY | orderId, tenantId, event, fromStatus, toStatus, fromStatusLabel |
| 0A2MToKNAwghfkYraAcK | orderId, tenantId, event, fromStatus, toStatus, fromStatusLabel |

### `order_settings`

| Doc ID | Key Fields |
|--------|------------|
| default | templates, tenantId, numberRanges, statuses, rules, carrierRules |

### `orders`

| Doc ID | Key Fields |
|--------|------------|
| 1Fp1nvxoFOMXB5QnK7js | tenantId, orderId, marketplaceKey, marketplaceOrderId, externalOrderId, source |
| 1WYO6i91C7PLNqipzKPP | tenantId, orderId, marketplaceKey, marketplaceOrderId, externalOrderId, source |
| 1dhYt8OFIrWGL5wFFG1s | tenantId, orderId, marketplaceKey, marketplaceOrderId, externalOrderId, source |

### `products`

| Doc ID | Key Fields |
|--------|------------|
| 00174600185032 | id, notes, inventory, storage, storageBins, completeness |
| 0024062741710 | id, locale, identification, notes, completeness, details |
| 0098931289601 | id, locale, notes, completeness, storage, inventory |

### `products_v2`

| Doc ID | Key Fields |
|--------|------------|
| 0000000000000 | id, locale, identification, notes, details, completeness |
| 0000081667738 | id, locale, identification, details, ops, notes |
| 00017ff0-43af-49fc-b066-778630dea91f | id, locale, identification, notes, storage, inventory |

### `qualityJobs`

| Doc ID | Key Fields |
|--------|------------|
| 00042d3e-5528-4aae-9b0f-feffa555fafc | createdAt, payload, productId, productName, locale, reason |
| 00064756-482f-4a22-9e8b-9f4bdfbfaceb | createdAt, payload, productId, productName, locale, reason |
| 000fea70-1408-47f1-a596-f9ecf33ba6d5 | createdAt, payload, productId, productName, locale, reason |

### `returns`

| Doc ID | Key Fields |
|--------|------------|
| 1fNwzuIVnhS9lDjvehiO | tenantId, marketplace, marketplaceReturnId, marketplaceOrderId, orderId, product |
| 1z4nnBydwcmyTAz8rxim | tenantId, marketplace, marketplaceReturnId, marketplaceOrderId, orderId, product |
| 2o9YRZO5NUtmhFSjWLn6 | tenantId, marketplace, marketplaceReturnId, marketplaceOrderId, orderId, product |

### `roles`

| Doc ID | Key Fields |
|--------|------------|
| admin | createdAt, roleId, name, permissions, updatedAt |
| catalog | createdAt, roleId, name, permissions, updatedAt |
| manager | createdAt, roleId, name, permissions, updatedAt |

### `rulebookApplyJobs`

| Doc ID | Key Fields |
|--------|------------|
| 33KPi0aGkz1GMRzzb5BG | createdAt, error, payload, requestedBy, attempts, startedAt |
| Hm0jFR02Hj84uZI4NzQF | createdAt, error, payload, requestedBy, startedAt, attempts |
| HuPasYz9LgDkKexrH0qT | createdAt, error, payload, requestedBy, startedAt, attempts |

### `rulebookConfigs`

| Doc ID | Key Fields |
|--------|------------|
| active | note, updatedBy, config, versionId, updatedAt |

### `shipments`

| Doc ID | Key Fields |
|--------|------------|
| 018nzNsiLTNldakPOGI3 | tenantId, orderId, orderNumber, marketplaceOrderId, marketplace, sendcloudParcelId |
| 04TQeqcF3fUGrAZVptmJ | tenantId, orderId, orderNumber, marketplaceOrderId, marketplace, sendcloudParcelId |
| 06Z1FonQlbaUHe2s6s2L | tenantId, orderId, orderNumber, sendcloudParcelId, trackingNumber, trackingUrl |

### `shipping_methods`

| Doc ID | Key Fields |
|--------|------------|
| default_111 | carrier, sendcloudId, carrierName, servicePointInput, lastSyncedAt, minWeight |
| default_112 | carrier, sendcloudId, carrierName, servicePointInput, lastSyncedAt, minWeight |
| default_113 | carrier, sendcloudId, carrierName, servicePointInput, lastSyncedAt, minWeight |

### `sku_index`

| Doc ID | Key Fields |
|--------|------------|
| sku:0000001111 | productId, sku, updated_at |
| sku:0000001252 | productId, sku, updated_at |
| sku:0000001759 | productId, sku, updated_at |

### `stock_locks`

| Doc ID | Key Fields |
|--------|------------|
| sync%3A8690885205298 | key, ownerId, acquiredAtMs, expiresAtMs, updatedAt |

### `stock_operation_failures`

| Doc ID | Key Fields |
|--------|------------|
| 3qlZnnDsd170ChHCuVJx | tenantId, operation, status, reason, productId, source |
| 7hmO7jhYDYbsV3xRI2zO | tenantId, operation, status, reason, productId, source |
| N4dYNp2b9JZuyJLAPM2W | tenantId, operation, status, reason, productId, source |

### `stock_reconciliation_log`

| Doc ID | Key Fields |
|--------|------------|
| 00Wywzcxlq8rJGtHMN87 | reason, checked, driftsFound, autoFixed, drifts, completedAt |
| 01pj05uMsYNiYaFpESJX | reason, checked, driftsFound, autoFixed, drifts, completedAt |
| 02gblMpAFg4zIAKmAWiO | reason, checked, driftsFound, autoFixed, drifts, completedAt |

### `stock_reservations`

| Doc ID | Key Fields |
|--------|------------|
| 08EQxftsNeTYfbpA6fZl | tenantId, orderId, sku, productId, quantity, createdAt |
| 0CJCd1KQqi8pgSMzZeZM | tenantId, orderId, sku, productId, quantity, createdAt |
| 0F0jXyF2zZgOPIyeXbYn | tenantId, orderId, sku, productId, quantity, createdAt |

### `stock_sync_failures`

| Doc ID | Key Fields |
|--------|------------|
| 000YBbBcKcKORRhsBbEg | tenantId, productId, reason, failedChannels, errors, createdAt |
| 002UadJzz7ZgaaeuuVYu | tenantId, productId, reason, failedChannels, errors, createdAt |
| 0037oH0Pjt2xQXtHhZvS | tenantId, productId, reason, failedChannels, errors, createdAt |

### `stock_sync_log`

| Doc ID | Key Fields |
|--------|------------|
| 000EOHv19asV6m5mYIQj | tenantId, productId, reason, quantity, reservedQty, availableQuantity |
| 000mx1jT2elrDuqG8471 | tenantId, productId, reason, quantity, reservedQty, availableQuantity |
| 000zTWFW2QBkvZGbofE2 | tenantId, productId, reason, quantity, reservedQty, availableQuantity |

### `trendocean`

| Doc ID | Key Fields |
|--------|------------|
| product_images | last_product_id, last_activity |

### `userSessions`

| Doc ID | Key Fields |
|--------|------------|
| 05xEgj578p9Sp1Kp3GH3 | userId, userEmail, tenantId, loginAt, logoutAt, durationSeconds |
| 08snePKbkD9k7s40pdsB | userId, userEmail, tenantId, loginAt, authProvider, ip |
| 0AhHp1oTvkBwKjLAANte | userId, userEmail, tenantId, loginAt, authProvider, ip |

### `user_profiles`

| Doc ID | Key Fields |
|--------|------------|
| T2mOTT0me6YLFfxPIEF9aJRHH6X2 | vorname, tenantId, nachname, theme, notifications, printing |

### `users`

| Doc ID | Key Fields |
|--------|------------|
| BTiU8QjGmWUf0mfX8LJsHSYpyGY2 | uid, lastLoginAt, roles, disabled, email, createdAt |
| T2mOTT0me6YLFfxPIEF9aJRHH6X2 | uid, disabled, email, roles, tenantId, createdAt |
| jts1XUNoDvSDkcIZRNDpGO5w24r1 | uid, lastLoginAt, disabled, email, createdAt, roles |

### `warehouseBins`

| Doc ID | Key Fields |
|--------|------------|
| LEG0101A | createdAt, lastStoredAt, ebene, gang, etage, zone |
| LEG0101B | createdAt, ebene, gang, etage, zone, regal |
| LEG0101C | createdAt, ebene, gang, etage, zone, regal |

### `warehouseEvents`

| Doc ID | Key Fields |
|--------|------------|
| 00F80ZY6B9CLHFHXWnKL | type, binCode, productId, sku, delta, quantityAfter |
| 01Ph60OGTX7k3y47Dc6K | type, binCode, productId, sku, delta, quantityAfter |
| 01kEIsi5jD6k30XSMAN7 | type, binCode, productId, sku, delta, quantityAfter |

### `warehouseZones`

| Doc ID | Key Fields |
|--------|------------|
| L_EG | ebenen, etage, zone, createdAt, binCount, gangs |
| P_EG | ebenen, isPalette, etage, zone, gangs, regale |
| S_EG | createdAt, ebenen, binCount, etage, zone, gangs |
