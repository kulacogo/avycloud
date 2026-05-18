---
title: "Integration: SendCloud"
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# SendCloud

> Multi-Carrier Versandplattform (DHL, DPD, GLS, Deutsche Post, Hermes, UPS …).
> Registry-Eintrag: [backend/lib/integration-registry.js](../../../backend/lib/integration-registry.js) (`sendcloud`, authType `api_key`).
> DHL ist in der Registry als `depends_on: 'sendcloud'` modelliert — kein separater Adapter.

## Was integriert ist

- **Parcels-Lifecycle** (Create / Get / Cancel) — [backend/services/shipping-engine.js](../../../backend/services/shipping-engine.js)
- **Label-Polling** (async carriers wie Deutsche Post Internetmarke) — `pollForLabel()`
- **Shipping-Methods** (`GET /shipping_methods`) — Carrier-Rule-Auswahl + Settings-UI
- **Carrier-Rules** (Gewicht → Method-ID) — `DEFAULT_CARRIER_RULES` als Fallback + Firestore-overridable
- **Tracking-Webhook** (`POST /api/webhooks/sendcloud`) → OMS-Status-Transition
- **Tracking-Catchup** (Polling-Cron, Safety-Net)
- **Address-Sanitization** (PLZ-Padding, Straße↔Str.-Varianten, Packstation-Detection, Postnummer)
- **Carrier-Rejection-Detection** (Status-ID `1002` → automatischer Cancel + klare Fehlermeldung)

## Auth + Credentials

- **HTTP Basic Auth** über `Authorization: Basic base64(public_key:secret_key)`.
- Implementiert in [backend/services/shipping-engine.js](../../../backend/services/shipping-engine.js) (`getSendCloudAuth()` mit In-Memory-Cache).
- Beide Keys aus Secret-Manager:
  - `SENDCLOUD_PUBLIC_KEY`
  - `SENDCLOUD_SECRET_KEY`
- Settings-UI verlangt `publicKey` + `secretKey` mit min. 5 Zeichen.
- Base-URL hardcoded: `https://panel.sendcloud.sc/api/v2` (kein Sandbox-Override).

## Hauptendpoints (call sites im Code)

Alle Calls in [backend/services/shipping-engine.js](../../../backend/services/shipping-engine.js) (plus Polling in [backend/services/tracking-poller.js](../../../backend/services/tracking-poller.js) wenn vorhanden).

| Endpoint | Methode | Funktion |
|----------|---------|----------|
| `/shipping_methods` | GET | `getShippingMethods()` |
| `/parcels?errors=verbose-carrier` | POST | `_sendParcelRequest(parcelData, auth)` — Label-Erzeugung |
| `/parcels/{id}` | GET | `pollForLabel({parcelId, …})` |
| `/parcels/{id}/cancel` | POST | inline beim Status-1002-Cleanup |
| `/parcels?order_number=...` | GET | Recovery-Helper für Shipment-Re-Binding |

Retries: bis zu 3 Versuche auf `5xx` + `429` mit exponentiellem Backoff (`BACKOFF_BASE_MS=1000`, Faktor 3).

Label-Polling: max. 10 Versuche im 2-s-Intervall (`pollForLabel({maxAttempts:10, intervalMs:2000})`).

Address-Variants (deutsche Adress-DB-Quirks):

- `Straße` ↔ `Str.`
- Ortsteil-Stripping in Strassennamen (`Lange Str. Hausen` → `Lange Str.`)
- `ß` → `ss`
- PLZ-Padding (DE: 5-stellig, AT: 4-stellig, falls als Number gespeichert)
- Packstation-Detection: `(\d{6,10}\s*[,.]?\s*)?(packstation|postfiliale)\s+(\d+)` → `to_post_number` + Force-Methode `89` (DHL Paket) wenn Default `2830` (DHL Kleinpaket) genutzt würde.

## Webhooks

### Eingehend: `POST /api/webhooks/sendcloud`

- Route in [backend/routes/webhooks.js](../../../backend/routes/webhooks.js).
- **Verifikation:**
  - Basic-Auth-Header decoden + `decoded.includes(SENDCLOUD_SECRET_KEY)` (string-contains, **nicht** equal); ODER
  - Query-Param `?secret=...` `===` `SENDCLOUD_SECRET_KEY`.
- **Status:** **fail-open**, wenn `SENDCLOUD_SECRET_KEY` nicht im Secret-Manager vorhanden ist (`webhookSecret = await getSecretValue(...).catch(()=>null)` — fehlende Secrets ergeben `null`, dann wird der ganze Verifikations-Block übersprungen). Details in [webhook-signing.md](webhook-signing.md).
- Akzeptierte Payload-Felder: `parcel_id`, `status.id`, `status.message`, `tracking_number`, `parcel.tracking_url`.
- Mapping `SENDCLOUD_STATUS_MAP` (siehe Status-IDs unten) → `omsStatus`.
- Forward-Only-Transitionen (`statusOrder`): `pending → confirmed → picking → picked → packing → packed → shipped → delivered → completed → returned`. Terminale Status `cancelled` (99) und `on_hold` (98) haben sehr hohen Rank, damit späte Webhooks sie nicht überschreiben.
- Für `shipped` und `delivered` läuft die Order durch die **State-Machine** ([backend/services/order-state-machine.js](../../../backend/services/order-state-machine.js)):
  - `transitionOrder({ tenantId, orderId, toStatus, force: true, … })`
  - Fallback bei Transition-Fail (`already shipped`): `processShippedOrder()` — triggert Stock-Decrement + Side-Effects.
- Andere Status: direktes `orderRef.set(…, { merge: true })` + `order_events`-Log.
- Webhook quittiert immer mit `200 OK`, damit SendCloud nicht weiter retried (auch im Fehlerfall).

Zusätzlich: `emitSyncEvent('shipment:updated', …)` für die Sync-Cascade.

## Status-IDs

Quelle: [SendCloud Parcel Statuses](https://docs.sendcloud.sc/api/v2/shipping/#parcel-statuses) — gespiegelt in zwei Mappings im Code:

**`SENDCLOUD_STATUS_MAP` (Webhook → omsStatus):**

| ID | omsStatus | Bedeutung |
|----|-----------|-----------|
| 1 | `null` | Announced (parcel created, not yet at carrier) |
| 3 | `shipped` | Handed to carrier / en route |
| 4 | `shipped` | Sorting |
| 5 | `shipped` | Customs |
| 6 | `shipped` | At sorting centre |
| 7 | `shipped` | Being delivered |
| 8 | `shipped` | Delivered attempt |
| 11 | `delivered` | Delivered |
| 12 | `delivered` | Delivered (at neighbour) |
| 15 | `returned` | Return: being delivered back |
| 32 | `returned` | Return: at sender |
| 33 | `returned` | Return: delivered back to sender |
| 62 | `delivered` | Delivered at service point |
| 80 | `null` | Exception |
| 1002 | `null` | Announcement failed (Auto-Cancel in `createParcel`) |
| 1337 | `null` | Ready to send (not yet picked up) |
| 2000 | `null` | Cancelled |

**`mapSendCloudStatus()` (Shipping-Engine → interner Status):**

| Status | Bedeutung |
|--------|-----------|
| `zugestellt` | id 11, 6 |
| `in_zustellung` | id 3, 4, 5, 91 |
| `ausstehend` | id 1, 1000, 1001, 62989 (default) |
| `problem` | id 1002, 8, 80, 999 |
| `storniert` | id 2000 |

## Polling vs Webhook

- **Webhook ist der Primärpfad.** SendCloud pusht jeden Status-Change. Akzeptiert wird er bei `parcel_id`-Match in `shipments` (Lookup `where('sendcloudParcelId', '==', Number(parcelId))`).
- **Polling als Safety-Net.** Cron-Job `tracking-catchup` läuft per Tenant (`BACKGROUND_JOB_TENANTS`, siehe CLAUDE.md §Background-Cron) und fragt offene Parcels über `GET /parcels/{id}` ab. Triggert dieselben State-Transitions wie der Webhook.
- **Label-Polling intern:** Bei `request_label: true` füllt SendCloud `parcel.label` async. `pollForLabel()` re-fetched alle 2 s bis Label-URL da ist; falls Timeout, wird `extractLabelUrl()` versucht — konstruiert `/labels/{normal_printer|label_printer}/{parcelId}` als Last-Resort-Pfad (Deutsche Post braucht das oft).

## Rate-Limits + Quotas

- SendCloud publiziert dokumentiert ~100 Calls/Minute pro Account; unsere Defensivstrategie:
  - 3-fach-Retry auf `5xx` + `429` (exponentielles Backoff)
  - Label-Polling absichtlich seriell (kein Parallel-Fan-Out pro Order)
  - Cron-Jobs (`tracking-catchup`, `sendcloud-sync`) laufen sequenziell pro Tenant
- **Wichtig:** SendCloud verrechnet Labels nur bei erfolgreichem `Announcement`. Status `1002` löst Auto-Cancel aus, damit kein „Geist-Label" persistiert wird.

## Bekannte Schwächen

- **Webhook-Verifikation fail-open ohne Secret.** Wenn `SENDCLOUD_SECRET_KEY` im Secret-Manager fehlt, akzeptiert der Endpoint jeden POST. Hardening-Plan Finding, siehe [webhook-signing.md](webhook-signing.md).
- **Basic-Auth-Decode prüft `decoded.includes(secret)` statt strikt `decoded === public:secret`.** Theoretisch matched z. B. ein User-Payload, das den Secret-String beiläufig enthält. Praktisch nicht ausnutzbar weil Basic-Encoding base64 wäre, aber Codestil ist „fail-loose".
- **Keine Idempotenz-Keys.** Wenn `createParcel` einen Timeout sieht und retried, kann der vorherige Call erfolgreich gewesen sein → Doppel-Parcel. Mitigation: `external_reference = ${orderId}_${Date.now()}` macht doppelte Reservation auffindbar, aber nicht atomar.
- **`request_label: true` ist Default + per-Order — fehlgeschlagene Carrier-Validation für Internetmarke erzeugt einen leeren Label-Slot.** Wir ergänzen mit `extractLabelUrl`-Konstruktion, aber das ist ein Workaround.
- **Carrier-Rules sind im Code, nicht in Firestore.** `DEFAULT_CARRIER_RULES` matched DHL/DPD nach Gewicht; Firestore-Override existiert konzeptionell, ist aber nicht in allen Code-Pfaden implementiert.
- **Adressen werden teilweise stillschweigend mutiert.** PLZ-Padding logged Warnung, Straßen-Variant-Retry logged Warnung — aber `customer.street` im Order-Doc wird nicht zurückgeschrieben. Späterer Re-Versand startet wieder mit der Original-Adresse.
- **Polling-Cron schreibt eigene Audit-Logs nur lückenhaft.** `tracking-catchup` und Webhook können denselben Status doppelt aufzeichnen.
- **`emitSyncEvent('shipment:updated')` hardcoded `tenantId: 'default'`** im Webhook-Body — siehe [backend/routes/webhooks.js](../../../backend/routes/webhooks.js). Multi-Tenant-Correctness: das passt nur, wenn das Shipment-Doc selbst den richtigen Tenant trägt (`shipData.tenantId`), was aber für den `emitSyncEvent` separat geprüft werden muss.

## Owner / Docs

- **Code-Owner:** Backend-Team.
- **Externe Doku:**
  - API v2: [sendcloud.dev API Reference](https://www.sendcloud.dev/docs/)
  - Parcel-Statuses: [docs.sendcloud.sc](https://docs.sendcloud.sc/api/v2/shipping/#parcel-statuses)
  - Statuscode-Reference: [support.sendcloud.sc Article 360024967612](https://support.sendcloud.sc/hc/en-us/articles/360024967612)
- **Verwandte KB-Seiten:**
  - [webhook-signing.md](webhook-signing.md) — Verifikations-Status
  - [services/shipping-engine.js](../../../backend/services/shipping-engine.js) — Label-Engine
