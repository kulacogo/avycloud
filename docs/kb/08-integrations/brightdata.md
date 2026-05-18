---
title: "Integration: Bright Data (Web-Unlocker)"
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Bright Data — Web-Unlocker

> Anti-Bot-Proxy für blockierte HTML-Seiten + Bilder. AvyCloud nutzt den Bright Data **Web-Unlocker** Endpoint (nicht SERP API, nicht Datasets).
> Nicht in der `integration-registry.js` — Bright Data ist Backend-Infrastruktur.

## Was integriert ist

- **HTML-Fallback** wenn direkter `fetch` blockiert wird (z. B. Hersteller-Websites mit Cloudflare-Bot-Check) — Identify-Pipeline (`gpsr-web-fallback.js`, `weight-web-lookup.js`).
- **Image-Proxy-Fallback** in [backend/routes/products.js](../../../backend/routes/products.js) `GET /api/image-proxy` — wenn direkter Image-Fetch fehlschlägt, wird Bright Data als zweite Stufe versucht.
- **Generischer Content-Fetcher** für atomic-tools (`fetch_url_content`) im Chat-V3 / Identify-V4.
- **Screenshot-Modus** (`dataFormat: 'screenshot'`) — vorhanden im API, aktuell nicht aktiv genutzt.

## Auth + Credentials

- **Bearer-Token** im `Authorization`-Header gegen `https://api.brightdata.com/request`.
- Resolution-Reihenfolge in `getBrightDataToken()` ([backend/lib/web-unlocker.js](../../../backend/lib/web-unlocker.js)):
  1. `process.env.BRIGHTDATA_API_TOKEN`
  2. `getSecretValue('BRIGHTDATA_API_TOKEN')`
- Wenn nichts gefunden: harter Throw `'BRIGHTDATA_API_TOKEN is not configured'`.
- Cache: `cachedToken` in-process; Rotation = Restart.

### ENV-Konfiguration

| ENV | Default | Bedeutung |
|-----|---------|-----------|
| `BRIGHTDATA_ENDPOINT` | `https://api.brightdata.com/request` | API-Endpoint |
| `BRIGHTDATA_ZONE` (alt `BRIGHTDATA_DEFAULT_ZONE`) | `unlocker_avy` | Bright Data Zone (Account-Konfiguration im Bright-Data-Panel) |
| `BRIGHTDATA_FORMAT` | `raw` | Antwort-Format (`raw` = HTML/Bytes, `json` = strukturiert) |
| `BRIGHTDATA_COUNTRY` | `null` | Optional: Geo-Targeting (`de`, `us`, …) |
| `BRIGHTDATA_TIMEOUT_MS` | `30000` | Request-Timeout |
| `BRIGHTDATA_MAX_TEXT_BYTES` | `200000` | Cut-off für Text-Body |

## Hauptendpoints (call sites im Code)

Einziger Entry-Point: `fetchWithUnlocker({ url, method, headers, body, zone, format, country, mobile, expect, dataFormat, timeoutMs })` in [backend/lib/web-unlocker.js](../../../backend/lib/web-unlocker.js).

### Request-Schema

```json
{
  "zone": "unlocker_avy",
  "url": "https://example.com/...",
  "method": "GET",
  "format": "raw",
  "headers": { "User-Agent": "…", "Accept": "…" },
  "country": "de",          // optional
  "data_format": "screenshot",  // optional binary
  "ua": "mobile"            // optional
}
```

Mit `expect: { element: '#main', text: 'Impressum' }` setzt das Wrapper-Modul den `x-unblock-expect`-Header — Bright Data wartet, bis das Element gerendert ist.

### Caller im Code

| Datei | Verwendung |
|-------|------------|
| [backend/routes/products.js](../../../backend/routes/products.js) `GET /api/image-proxy` | Image-Fallback (siehe SSRF-Hinweis unten) |
| [backend/lib/gpsr-web-fallback.js](../../../backend/lib/gpsr-web-fallback.js) | Hersteller-Impressum-Scrape |
| [backend/lib/weight-web-lookup.js](../../../backend/lib/weight-web-lookup.js) | Gewicht-Lookup (Stage 2) |
| `services/atomic-tools.js` | `fetch_url_content` Executor (Chat-V3 + Identify-V4) |

### Response-Schema

```js
{
  success: boolean,         // response.ok
  url: string,
  status: number,
  statusText: string,
  headers: {},              // Response-Headers (flach kopiert)
  contentType: string,
  body: string | null,      // Text bis MAX_TEXT_BYTES
  body_base64: string | null, // Binary (screenshot / image content-type)
  bytes: number,
  dataFormat: string | null,
  format: 'raw' | 'json',
  zone: string,
}
```

## Tracker-Wrap

`fetchWithUnlocker` wickelt jeden Call durch `instrumentExternalCall('brightdata', endpointLabel, …)`:

- `endpointLabel` = Hostname der Target-URL (`new URL(opts.url).hostname`), Fallback `'unknown'`.
- Schreibt fire-and-forget in `external_api_calls`: `service='brightdata'`, `endpoint=<hostname>`, `success`, `latencyMs`, `errorCode`.
- Sample-Rate-ENV: `EXTERNAL_API_TRACKER_SAMPLE_RATE=1.0` default.
- **Zweck:** Antwort auf die Frage „brauchen wir BrightData noch?" mit Daten statt Meinungen (siehe `/api/health/identify` Operator-Dashboard).

## Webhooks

**Keine.** Bright Data ist request/response.

## Rate-Limits + Quotas

- Bright Data berechnet pro **erfolgreichem Unlock** (Per-Request-Pricing nach Zone-Tier).
- Kein hartes In-Code-Rate-Limit — der einzige Drossel-Mechanismus ist der `BRIGHTDATA_TIMEOUT_MS=30000`-Timeout (Bright Data wartet auf JS-Render + Bot-Check, kann lang sein).
- Kein Circuit-Breaker, kein Retry-Wrapper. Fehlschläge propagieren direkt.

## Fallback in Image-Proxy (`/api/image-proxy`)

[backend/routes/products.js](../../../backend/routes/products.js) `GET /api/image-proxy`:

1. **GCS-Bypass:** Eigene Bucket-URLs (`storage.googleapis.com/prodsandjobs/...`) werden direkt geholt, kein Bright Data.
2. **Direkt-Fetch** mit User-Agent-Spoof (Chrome) → wenn `image/*` Content-Type kommt, wird das verwendet.
3. **Bright-Data-Fallback** mit `User-Agent: avystock-image-proxy/1.0`, leerem `Referer` und `format: 'raw'`.

### SSRF-Hinweis

> **WICHTIG:** `/api/image-proxy` ist in [backend/index.js](../../../backend/index.js) explizit von der `requireAuth`-Middleware ausgenommen (Zeile ~236 — `if (req.path === '/image-proxy') return next();`) — weil `<img src>` keinen `Authorization`-Header senden kann.

Die Konsequenzen für SSRF:

- Validation ist **nur** `URL`-Parsing + Protocol-Whitelist (`http:` / `https:`).
- **Keine Host-Allowlist.** Beliebige externe Hosts dürfen erreicht werden.
- **Keine Private-IP/Internal-Range-Blockade.** `http://169.254.169.254/...` (GCE Metadata), `http://localhost:…`, `http://10.x.x.x/...`, `http://internal-svc.cluster.local/…` werden NICHT explizit blockiert.
- **Bright Data leitet aus, nicht durch das Cloud-Run-Netzwerk.** Bright-Data-Pfad ist daher SSRF-resistenter (Calls gehen über Bright Data raus, kommen nicht aus dem GCP-Projekt). Trotzdem wird der **Direkt-Fetch ZUERST** versucht — und genau dieser Direkt-Fetch läuft aus dem Cloud-Run-Container raus.
- Mitigation-Status: **Hardening-Plan-Finding.** Anstehende Härtungen (in Open-Tasks/Roadmap):
  - Host-Allowlist oder explicit private-IP-Reject (z. B. via `ip-range-check` / RFC1918 + Link-Local).
  - Auth-Token aus signiertem Query-Param (statt komplett public).
  - Max-Size hartcap server-side (aktuell `IMAGE_PROXY_MAX_BYTES=5*1024*1024`, prüft erst nach Download).

Bis das gehärtet ist: **`/api/image-proxy` darf NICHT für untrustworthy User-Input genutzt werden** (z. B. öffentliche Such-Felder, die direkt in `?url=` fließen). Aktueller Use-Case sind ausschließlich Image-Quellen, die wir selbst kuratieren (Identify-Workflow + UI).

## Cost

- Bright Data Pricing pro Zone-Tier (Web-Unlocker ist die teurere Schiene gegenüber „Datacenter Proxies"). Typisch USD 0.001–0.005 pro erfolgreichem Request, abhängig vom Account.
- Telemetrie über `external_api_calls`-Aggregat in `/api/health/identify` (Operator-Dashboard).

## Bekannte Schwächen

- **Image-Proxy SSRF.** Siehe oben. **Hardening-Plan-Finding.**
- **Single Bearer-Token.** Rotation = Restart.
- **Kein Retry, kein Breaker.** Bei Bright-Data-Outage (selten, aber passiert) brechen abhängige Worker hart ab. Identify-Pipeline hat per-Worker-Try/Catch und macht weiter, aber Image-Proxy gibt `502` zurück.
- **`zone` ist global hardcoded** (`unlocker_avy`). Per-Tenant- oder per-Use-Case-Zones existieren konzeptionell, sind aber nicht angeschlossen.
- **`MAX_TEXT_BYTES=200000`-Cut-off** schneidet stillschweigend ab. Wenn ein Impressum auf einer Seite > 200 KB ins HTML eingebettet ist, fehlen Felder.
- **`dataFormat: 'screenshot'` ist gebaut, aber ungenutzt.** Wenn neuer Code Screenshots braucht: `body_base64` ist gesetzt, der Caller muss base64-decoden.
- **Geo-Targeting (`country`) ist standardmäßig `null`** — Bright Data wählt random. Für deutsche Hersteller-Sites wäre `BRIGHTDATA_COUNTRY=de` sicherer (geringeres Captcha-Risk).
- **`headers.Referer = ''`** im Image-Proxy ist Intent, kann aber bei einigen CDN-Anti-Hotlink-Setups zu 403 führen. Kein Fallback auf Referer-Spoof.

## Owner / Docs

- **Code-Owner:** Backend-Team / AI-Sub-Team.
- **Externe Doku:**
  - Web-Unlocker: [docs.brightdata.com/scraping-automation/web-unlocker](https://docs.brightdata.com/scraping-automation/web-unlocker)
  - Request-API: [docs.brightdata.com/api-reference/web-unlocker-api](https://docs.brightdata.com/api-reference/web-unlocker-api)
- **Verwandte KB-Seiten:**
  - [serpapi.md](serpapi.md) — alternative Quelle für strukturierte Search-Results
  - [firebase.md](firebase.md) — Auth-Modell und Allowlist-Routes
  - Bright-Data-Tracker-Telemetrie in `/api/health/identify` ([backend/routes/health.js](../../../backend/routes/health.js) bzw. analog)
