---
title: Settings (Einstellungen)
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

## Zweck

Sammelbegriff für alle Tenant-/User-Konfigurationsseiten. Aufgeteilt in fünf Sub-Views:

- **Order-Settings** (`orders-settings`) — Default-Versand-Methoden, Repricing-Batch, SendCloud-Shipping-Methods-Sync.
- **Profile-Settings** (`settings-profile`) — User-Profil (Name, Avatar, Email).
- **Company-Settings** (`settings-company` — implizit über Profile-Bereich erreichbar in App.tsx) — Firma, Adresse, Rechnungs-Defaults.
- **API-Settings** (`settings-api`) — API-Keys + Webhooks für externe Integrations-Builds.
- **Billing-Settings** (`settings-billing`) — Plan, Usage, Limits.

`orders-settings` ist Teil des Order-Bereichs und teilt sich Routing-Patterns mit den anderen Order-Views.

## Komponente(n)

- [components/orders/OrderSettingsView.tsx](../../../components/orders/OrderSettingsView.tsx) — Order-Settings.
- [components/settings/CompanySettings.tsx](../../../components/settings/CompanySettings.tsx) — Company-Daten.
- [components/settings/ProfileSettings.tsx](../../../components/settings/ProfileSettings.tsx) — Profil.
- [components/settings/ApiSettings.tsx](../../../components/settings/ApiSettings.tsx) — API-Keys + Webhooks.
- [components/settings/BillingSettings.tsx](../../../components/settings/BillingSettings.tsx) — Billing.

## API-Calls

OrderSettingsView:
- `fetchOrderSettings()` / `saveOrderSettings(payload)` — `/api/orders/settings`.
- `runRepricingBatch(payload)` — Batch-Repricing trigger.
- `fetchPricingRules()` — aktive Rules.
- `syncSendCloudParcels()` — Parcel-Status-Pull.
- `syncShippingMethods()` / `fetchShippingMethods()` — Versandmethoden-Sync und -Liste.

CompanySettings:
- `fetchCompanySettings()` / `saveCompanySettings(payload)` — `/api/settings/company`.

ProfileSettings:
- `fetchProfile()` / `saveProfile(payload)` — `/api/settings/profile`.

ApiSettings:
- `fetchApiKeys()` / `createApiKey(payload)` / `revokeApiKey(id)` — `/api/settings/api-keys`.
- `fetchWebhooks()` / `createWebhook(payload)` / `deleteWebhook(id)` — `/api/settings/webhooks`.

BillingSettings:
- `fetchBillingUsage()` — `/api/settings/billing/usage`, liefert `BillingUsageData`.

Pro-Endpunkt-Doku: `docs/kb/09-api/settings.md` (TBD).

## Datenquellen

- Jede View hält ihren eigenen `useState`-Cache + `useEffect`-Load. **Kein** React-Query.
- `useToast` für UX-Feedback (`save successful` / `save failed`).
- Skeleton/ProgressBar in BillingSettings für Usage-Visualisierung.

## Wichtige Edge-Cases

- **Empty-State**: noch keine Daten → Default-Form-Werte aus Schema; bei Profil/Company-Erststart fehlende Felder zeigen Placeholder.
- **Loading**: Skeleton oder Inline-Spinner pro Section.
- **Error**: Toast (`useToast.error`).
- **API-Key-Generierung**: Plain-Secret wird **nur einmal** angezeigt (post-create) — Copy-Modal mit `CopyIcon`; Backend speichert nur Hash.
- **Webhook-Test**: kein dezidierter Test-Button im Frontend (Stand 2026-05-18); Webhooks werden bei Events real getriggert.
- **Billing-Plan-Wechsel**: Stand 2026-05-18 keine self-service Plan-Änderung im UI; nur Read-only Usage.
- **Avatar-Upload**: ProfileSettings nutzt `useRef`-File-Picker; Validation (Größe/Format) im Backend.
- **SendCloud-Sync**: Falls SendCloud-Token fehlt → Backend antwortet 401, Frontend zeigt CTA für IntegrationsHub-Setup.
- **Mobile**: alle Settings-Views responsiv (Single-Column-Layout).

## Bekannte Issues

Keine settings-spezifischen offenen Bugs in [TASKS.md](../../../TASKS.md) (Stand 2026-05-18).
