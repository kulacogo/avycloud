# KB Coverage Audit — 2026-05-18

Total items checked: 107
Documented: 87
Missing: 20
Errors: 0

## env-flag (0/53 missing)

| Item | Type | Documented? | Suggested-File |
|------|------|-------------|----------------|
| ATOMIC_TOOLS_TIMEOUT_MS | env-flag | yes | docs/kb/03-development/feature-flags.md |
| BACKGROUND_JOB_TENANTS | env-flag | yes | docs/kb/03-development/feature-flags.md |
| CATEGORY_RESOLVER_DYNAMIC_CONFIDENCE | env-flag | yes | docs/kb/03-development/feature-flags.md |
| CATEGORY_RESOLVER_V2 | env-flag | yes | docs/kb/03-development/feature-flags.md |
| CHAT_GROUNDING | env-flag | yes | docs/kb/03-development/feature-flags.md |
| CHAT_LEGACY_ENHANCED | env-flag | yes | docs/kb/03-development/feature-flags.md |
| CHAT_MODEL | env-flag | yes | docs/kb/03-development/feature-flags.md |
| CHAT_V2_ENHANCED | env-flag | yes | docs/kb/03-development/feature-flags.md |
| CHAT_V3 | env-flag | yes | docs/kb/03-development/feature-flags.md |
| EXTERNAL_API_TRACKER_SAMPLE_RATE | env-flag | yes | docs/kb/03-development/feature-flags.md |
| GEMINI_CHAT_MODEL | env-flag | yes | docs/kb/03-development/feature-flags.md |
| GEMINI_PROMPT_CACHE | env-flag | yes | docs/kb/03-development/feature-flags.md |
| IDENTIFY_GROUNDING | env-flag | yes | docs/kb/03-development/feature-flags.md |
| IDENTIFY_GROUNDING_TIMEOUT_MS | env-flag | yes | docs/kb/03-development/feature-flags.md |
| IDENTIFY_TOTAL_TIMEOUT_MS | env-flag | yes | docs/kb/03-development/feature-flags.md |
| IDENTIFY_V3 | env-flag | yes | docs/kb/03-development/feature-flags.md |
| IDENTIFY_V3_GPSR_CONSENSUS | env-flag | yes | docs/kb/03-development/feature-flags.md |
| IDENTIFY_V4 | env-flag | yes | docs/kb/03-development/feature-flags.md |
| IDENTIFY_V4_AUTOSAVE | env-flag | yes | docs/kb/03-development/feature-flags.md |
| IDENTIFY_V4_CANARY_RATE | env-flag | yes | docs/kb/03-development/feature-flags.md |
| IDENTIFY_V4_CANARY_TENANTS | env-flag | yes | docs/kb/03-development/feature-flags.md |
| IDENTIFY_V4_CRITIC_FLASH | env-flag | yes | docs/kb/03-development/feature-flags.md |
| IDENTIFY_V4_CRITIC_HINTS | env-flag | yes | docs/kb/03-development/feature-flags.md |
| IDENTIFY_V4_CRITIC_HINTS_VERIFIED | env-flag | yes | docs/kb/03-development/feature-flags.md |
| IDENTIFY_V4_IMAGE_ANGLE_CLASSIFY | env-flag | yes | docs/kb/03-development/feature-flags.md |
| IDENTIFY_V4_IMAGE_ENHANCE | env-flag | yes | docs/kb/03-development/feature-flags.md |
| IDENTIFY_V4_MAX_ITERATIONS | env-flag | yes | docs/kb/03-development/feature-flags.md |
| IDENTIFY_V4_PRICING_SOLD | env-flag | yes | docs/kb/03-development/feature-flags.md |
| IDENTIFY_V4_TIMEOUT_MS | env-flag | yes | docs/kb/03-development/feature-flags.md |
| INTENT_MODEL | env-flag | yes | docs/kb/03-development/feature-flags.md |
| LLM_SCHEMA_STRICT | env-flag | yes | docs/kb/03-development/feature-flags.md |
| LLM_SCHEMA_VALIDATE_RATE | env-flag | yes | docs/kb/03-development/feature-flags.md |
| LLM_TELEMETRY_SAMPLE | env-flag | yes | docs/kb/03-development/feature-flags.md |
| QUALITY_GATE_ENABLED | env-flag | yes | docs/kb/03-development/feature-flags.md |
| SLACK_ALERTS_URL | env-flag | yes | docs/kb/03-development/feature-flags.md |
| STAGE1_IMAGE_QUALITY_GATE | env-flag | yes | docs/kb/03-development/feature-flags.md |
| STAGE1_SKIP_FOCUSED_GROUNDING | env-flag | yes | docs/kb/03-development/feature-flags.md |
| STAGE1_SKIP_V2_FALLBACK | env-flag | yes | docs/kb/03-development/feature-flags.md |
| STAGE2_GPSR_WEB_FALLBACK | env-flag | yes | docs/kb/03-development/feature-flags.md |
| STAGE2_WEIGHT_WEB_FALLBACK | env-flag | yes | docs/kb/03-development/feature-flags.md |
| STAGE3_AGENTIC | env-flag | yes | docs/kb/03-development/feature-flags.md |
| STAGE3_AGENTIC_MAX_IMAGES | env-flag | yes | docs/kb/03-development/feature-flags.md |
| STAGE3_AGENTIC_MAX_ITERATIONS | env-flag | yes | docs/kb/03-development/feature-flags.md |
| STAGE3_AGENTIC_MAX_TOKENS | env-flag | yes | docs/kb/03-development/feature-flags.md |
| STAGE3_AGENTIC_SAMPLE | env-flag | yes | docs/kb/03-development/feature-flags.md |
| STAGE3_AGENTIC_SOFT_RESEARCH_LIMIT | env-flag | yes | docs/kb/03-development/feature-flags.md |
| STAGE3_AGENTIC_TEMPERATURE | env-flag | yes | docs/kb/03-development/feature-flags.md |
| STAGE3_AGENTIC_TIMEOUT_MS | env-flag | yes | docs/kb/03-development/feature-flags.md |
| STAGE3_ASPECT_ENFORCEMENT | env-flag | yes | docs/kb/03-development/feature-flags.md |
| STAGE3_ASPECT_REPAIR | env-flag | yes | docs/kb/03-development/feature-flags.md |
| STOCK_FAILURE_DRAIN_TENANTS | env-flag | yes | docs/kb/03-development/feature-flags.md |
| STOCK_LOCK_BACKEND | env-flag | yes | docs/kb/03-development/feature-flags.md |
| TENANT_ID | env-flag | yes | docs/kb/03-development/feature-flags.md |

## feature (15/15 missing)

| Item | Type | Documented? | Suggested-File |
|------|------|-------------|----------------|
| docs/features/AI-001-ai-listing-pipeline/spec.md | feature | NO | docs/kb/06-features/AI-001-ai-listing-pipeline.md |
| docs/features/BULK-001-bulk-editing/spec.md | feature | NO | docs/kb/06-features/BULK-001-bulk-editing.md |
| docs/features/chat-assistant-v3/spec.md | feature | NO | docs/kb/06-features/chat-assistant-v3.md |
| docs/features/DASH-001-analytics-dashboard/spec.md | feature | NO | docs/kb/06-features/DASH-001-analytics-dashboard.md |
| docs/features/ERR-001-error-dashboard/spec.md | feature | NO | docs/kb/06-features/ERR-001-error-dashboard.md |
| docs/features/identify-v4/spec.md | feature | NO | docs/kb/06-features/identify-v4.md |
| docs/features/IMG-001-image-enhancement/spec.md | feature | NO | docs/kb/06-features/IMG-001-image-enhancement.md |
| docs/features/MP-001-amazon-integration/spec.md | feature | NO | docs/kb/06-features/MP-001-amazon-integration.md |
| docs/features/MP-002-otto-integration/spec.md | feature | NO | docs/kb/06-features/MP-002-otto-integration.md |
| docs/features/PRICE-001-pricing-engine-ui/spec.md | feature | NO | docs/kb/06-features/PRICE-001-pricing-engine-ui.md |
| docs/features/RULE-001-rule-engine/spec.md | feature | NO | docs/kb/06-features/RULE-001-rule-engine.md |
| docs/features/UX-001-onboarding-wizard/spec.md | feature | NO | docs/kb/06-features/UX-001-onboarding-wizard.md |
| docs/features/VAL-001-pre-listing-validation/spec.md | feature | NO | docs/kb/06-features/VAL-001-pre-listing-validation.md |
| docs/features/VAR-001-variant-model/spec.md | feature | NO | docs/kb/06-features/VAR-001-variant-model.md |
| docs/features/weight-reliability/spec.md | feature | NO | docs/kb/06-features/weight-reliability.md |

## integration (4/7 missing)

| Item | Type | Documented? | Suggested-File |
|------|------|-------------|----------------|
| credentialToSecretMap | integration | NO | docs/kb/08-integrations/credentialToSecretMap.md |
| dhl | integration | NO | docs/kb/08-integrations/dhl.md |
| ebay | integration | yes | docs/kb/08-integrations/ebay.md |
| kaufland | integration | yes | docs/kb/08-integrations/kaufland.md |
| oauthConfig | integration | NO | docs/kb/08-integrations/oauthConfig.md |
| sendcloud | integration | yes | docs/kb/08-integrations/sendcloud.md |
| sevdesk | integration | NO | docs/kb/08-integrations/sevdesk.md |

## route (1/16 missing)

| Item | Type | Documented? | Suggested-File |
|------|------|-------------|----------------|
| backend/routes/admin.js | route | yes | docs/kb/09-api/admin.md |
| backend/routes/auth.js | route | yes | docs/kb/09-api/auth.md |
| backend/routes/help.js | route | NO | docs/kb/09-api/help.md |
| backend/routes/identify.js | route | yes | docs/kb/09-api/identify.md |
| backend/routes/integrations.js | route | yes | docs/kb/09-api/integrations.md |
| backend/routes/invoices.js | route | yes | docs/kb/09-api/invoices.md |
| backend/routes/marketplace.js | route | yes | docs/kb/09-api/marketplace.md |
| backend/routes/orders.js | route | yes | docs/kb/09-api/orders.md |
| backend/routes/products.js | route | yes | docs/kb/09-api/products.md |
| backend/routes/returns.js | route | yes | docs/kb/09-api/returns.md |
| backend/routes/rules.js | route | yes | docs/kb/09-api/rules.md |
| backend/routes/sessions.js | route | yes | docs/kb/09-api/sessions.md |
| backend/routes/settings.js | route | yes | docs/kb/09-api/settings.md |
| backend/routes/sse.js | route | yes | docs/kb/09-api/sse.md |
| backend/routes/warehouse.js | route | yes | docs/kb/09-api/warehouse.md |
| backend/routes/webhooks.js | route | yes | docs/kb/09-api/webhooks.md |

## view (0/16 missing)

| Item | Type | Documented? | Suggested-File |
|------|------|-------------|----------------|
| components/AuditLogView.tsx | view | yes | docs/kb/05-pages/README.md |
| components/capture/CaptureView.tsx | view | yes | docs/kb/05-pages/README.md |
| components/DeduplicationView.tsx | view | yes | docs/kb/05-pages/README.md |
| components/IdentifyQueueView.tsx | view | yes | docs/kb/05-pages/README.md |
| components/InventoryView.tsx | view | yes | docs/kb/05-pages/README.md |
| components/MarketplaceListingsView.tsx | view | yes | docs/kb/05-pages/README.md |
| components/MobileOperationsView.tsx | view | yes | docs/kb/05-pages/README.md |
| components/MobileSearchView.tsx | view | yes | docs/kb/05-pages/README.md |
| components/OperationsView.tsx | view | yes | docs/kb/05-pages/README.md |
| components/orders/InvoicesView.tsx | view | yes | docs/kb/05-pages/README.md |
| components/orders/OrderSettingsView.tsx | view | yes | docs/kb/05-pages/README.md |
| components/orders/ReturnsView.tsx | view | yes | docs/kb/05-pages/README.md |
| components/orders/ShippingView.tsx | view | yes | docs/kb/05-pages/README.md |
| components/OrdersView.tsx | view | yes | docs/kb/05-pages/README.md |
| components/warehouse/WarehouseSettingsView.tsx | view | yes | docs/kb/05-pages/README.md |
| components/WarehouseView.tsx | view | yes | docs/kb/05-pages/README.md |
