'use strict';

/**
 * Bild-Host-Erkennung — reine Funktionen, KEIN I/O, keine Abhaengigkeiten.
 *
 * Warum es das gibt (Messung Bestand 2026-07-29, 8.408 Bildadressen):
 *   - 5.563 liegen auf storage.googleapis.com (eigener Speicher)
 *   - 906 auf m.media-amazon.com, 142 auf i.ebayimg.com, 110 auf
 *     media.cdn.kaufland.de — fremde Marktplatz-Bilder
 *   - 373 sind /api/image-proxy?url=-Wrapper auf die eigene Cloud-Run-Domain.
 *     Wer nur den aeusseren Host anschaut, haelt ein Amazon-Bild faelschlich
 *     fuer ein eigenes. Deshalb wird IMMER der innere Host klassifiziert.
 *
 * Zwei Fragen beantwortet dieses Modul:
 *   1. Liegt das Bild auf eigenem Speicher?           -> own
 *   2. Duerfte man es auf eigenen Speicher kopieren?  -> rehostable
 *
 * `rehostable` ist bewusst konservativ: nur fremde Hosts, die NICHT auf der
 * Urheberrechts-Denylist stehen. Marktplatz-Bilder (Amazon/eBay/Kaufland)
 * duerfen nicht umgehostet werden — die muessen ersetzt werden.
 */

/** Eigene GCS-Buckets (exakte Namen). Zusaetzlich gilt das Praefix `avycloud-`. */
const OWN_STORAGE_BUCKETS = new Set([
  'prodsandjobs',
  'trendocean',
  'avycloud-product-images',
  'avycloud-genai-images',
]);

/** Praefix-Regel fuer kuenftige eigene Buckets (avycloud-*). */
const OWN_STORAGE_BUCKET_PREFIXES = ['avycloud-'];

/** Host-Namen, unter denen eigener Objektspeicher ausgeliefert wird. */
const OWN_STORAGE_HOSTS = new Set([
  'storage.googleapis.com',
  'storage.cloud.google.com',
]);

/**
 * Eigene Cloud-Run-/Hosting-Domains. `run.app`-Hosts zaehlen nur, wenn der
 * Service-Name zu uns gehoert — eine fremde run.app-Adresse ist nicht unsere.
 */
const OWN_HOST_SUFFIXES = ['.web.app', '.firebaseapp.com'];
const OWN_HOSTS = new Set(['avycloud.web.app', 'avycloud.firebaseapp.com']);
const OWN_CLOUD_RUN_SERVICE_PREFIXES = ['product-hub-backend', 'product-hub-worker'];

/**
 * Urheberrechtlich gesperrte Bildhosts. Bilder von hier duerfen NICHT auf
 * eigenen Speicher kopiert werden — sie muessen durch eigene Fotos ersetzt
 * werden. Liste bewusst benannt + exportiert, damit sie leicht waechst.
 */
const COPYRIGHT_BLOCKED_HOSTS = new Set([
  // Amazon
  'm.media-amazon.com',
  'images-na.ssl-images-amazon.com',
  'images-eu.ssl-images-amazon.com',
  'images-fe.ssl-images-amazon.com',
  'images.amazon.com',
  // eBay
  'i.ebayimg.com',
  'ir.ebaystatic.com',
  'thumbs.ebaystatic.com',
  // Kaufland
  'media.cdn.kaufland.de',
]);

/**
 * Suffix-Regeln der Denylist (immer MIT fuehrendem Punkt, damit
 * `ebayimg.com.boeser-shop.de` NICHT faelschlich matcht).
 */
const COPYRIGHT_BLOCKED_HOST_SUFFIXES = [
  '.media-amazon.com',
  '.ssl-images-amazon.com',
  '.ebayimg.com',
  '.ebaystatic.com',
  '.cdn.kaufland.de',
];

/** Pfad-Marker des eigenen Bild-Proxys. */
const IMAGE_PROXY_PATH = '/api/image-proxy';

function toTrimmedString(value) {
  if (typeof value === 'string') return value.trim();
  return '';
}

/**
 * Parst eine Bildadresse robust. Liefert `null` statt zu werfen.
 * Akzeptiert protokoll-relative Adressen (`//host/x.jpg`).
 * @param {unknown} raw
 * @returns {URL|null}
 */
function safeParseUrl(raw) {
  const s = toTrimmedString(raw);
  if (!s) return null;
  const candidate = s.startsWith('//') ? `https:${s}` : s;
  try {
    const u = new URL(candidate);
    if (!u.hostname) return null;
    return u;
  } catch (_) {
    return null;
  }
}

/**
 * Holt den Hostnamen aus einer Adresse ODER akzeptiert einen blanken Host.
 * @param {unknown} raw
 * @returns {string|null} kleingeschriebener Host ohne Port
 */
function extractHost(raw) {
  const u = safeParseUrl(raw);
  if (u) return u.hostname.toLowerCase();
  const s = toTrimmedString(raw).toLowerCase();
  // Blanker Hostname wie 'm.media-amazon.com' (kein Schema, keine Slashes)
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return s;
  return null;
}

/**
 * Ist die Adresse ein `/api/image-proxy?url=`-Wrapper? Dann die INNERE Adresse
 * zurueckgeben, sonst null.
 * @param {unknown} raw
 * @returns {string|null}
 */
function unwrapProxyUrl(raw) {
  const u = safeParseUrl(raw);
  if (!u) return null;
  if (!u.pathname || !u.pathname.endsWith(IMAGE_PROXY_PATH)) return null;
  let inner;
  try {
    inner = u.searchParams.get('url');
  } catch (_) {
    return null;
  }
  if (!inner) return null;
  const innerTrimmed = toTrimmedString(inner);
  if (!innerTrimmed) return null;
  // Nur akzeptieren, wenn die innere Adresse selbst parsebar ist.
  return safeParseUrl(innerTrimmed) ? innerTrimmed : null;
}

/**
 * Steht der Host auf der Urheberrechts-Denylist? Der image-proxy-Wrapper wird
 * vorher ausgepackt, damit ein durchgereichtes Amazon-Bild nicht durchrutscht.
 * @param {unknown} rawUrlOrHost - Adresse oder blanker Hostname
 * @returns {boolean}
 */
function isCopyrightBlockedHost(rawUrlOrHost) {
  const unwrapped = unwrapProxyUrl(rawUrlOrHost);
  const host = extractHost(unwrapped || rawUrlOrHost);
  if (!host) return false;
  if (COPYRIGHT_BLOCKED_HOSTS.has(host)) return true;
  return COPYRIGHT_BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** GCS-Bucketname aus dem Pfad (`/<bucket>/<object...>`). */
function bucketFromPath(pathname) {
  const segments = String(pathname || '')
    .split('/')
    .filter(Boolean);
  return segments.length ? decodeURIComponent(segments[0]).toLowerCase() : '';
}

function isOwnBucket(bucket) {
  if (!bucket) return false;
  if (OWN_STORAGE_BUCKETS.has(bucket)) return true;
  if (OWN_STORAGE_BUCKET_PREFIXES.some((p) => bucket.startsWith(p))) return true;
  const configured = toTrimmedString(process.env.STORAGE_BUCKET)
    .replace(/^gs:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  return Boolean(configured) && configured === bucket;
}

function isOwnCloudRunHost(host) {
  if (!host) return false;
  if (!host.endsWith('.run.app')) return false;
  const service = host.split('.')[0] || '';
  return OWN_CLOUD_RUN_SERVICE_PREFIXES.some((p) => service.startsWith(p));
}

function buildResult(overrides) {
  return {
    host: null,
    bucket: null,
    own: false,
    blocked: false,
    rehostable: false,
    proxied: false,
    wrapperHost: null,
    reason: 'unknown',
    ...overrides,
  };
}

/**
 * Klassifiziert eine Bildadresse.
 *
 * @param {unknown} rawUrl
 * @returns {{
 *   host: string|null,
 *   bucket: string|null,
 *   own: boolean,
 *   blocked: boolean,
 *   rehostable: boolean,
 *   proxied: boolean,
 *   wrapperHost: string|null,
 *   reason: string
 * }}
 *
 * reason ist einer von:
 *   empty | data_uri | relative_path | invalid_url |
 *   own_storage_bucket | own_cloud_run | own_host |
 *   copyright_blocked | foreign_host
 */
function classifyImageHost(rawUrl) {
  const s = toTrimmedString(rawUrl);
  if (!s) return buildResult({ reason: 'empty' });
  if (/^data:/i.test(s)) return buildResult({ reason: 'data_uri' });
  if (/^(?:\.{0,2}\/)/.test(s) && !s.startsWith('//')) {
    return buildResult({ reason: 'relative_path' });
  }

  const wrapperUrl = safeParseUrl(s);
  const inner = unwrapProxyUrl(s);
  const effective = inner ? safeParseUrl(inner) : wrapperUrl;

  if (!effective) {
    // Kein Schema, aber vielleicht ein relativer Pfad ohne fuehrenden Slash?
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.startsWith('//') && !extractHost(s)) {
      return buildResult({ reason: 'relative_path' });
    }
    return buildResult({ reason: 'invalid_url' });
  }

  const proxied = Boolean(inner);
  const wrapperHost = proxied && wrapperUrl ? wrapperUrl.hostname.toLowerCase() : null;
  const host = effective.hostname.toLowerCase();
  const base = { host, proxied, wrapperHost };

  // 1. Eigener Objektspeicher
  if (OWN_STORAGE_HOSTS.has(host)) {
    const bucket = bucketFromPath(effective.pathname);
    if (isOwnBucket(bucket)) {
      return buildResult({ ...base, bucket, own: true, reason: 'own_storage_bucket' });
    }
    // Fremder Bucket auf storage.googleapis.com — fremd, aber nicht gesperrt.
    if (isCopyrightBlockedHost(host)) {
      return buildResult({ ...base, bucket, blocked: true, reason: 'copyright_blocked' });
    }
    return buildResult({ ...base, bucket, rehostable: true, reason: 'foreign_host' });
  }

  // 2. Eigene Cloud-Run-/Hosting-Domain
  if (isOwnCloudRunHost(host)) {
    return buildResult({ ...base, own: true, reason: 'own_cloud_run' });
  }
  if (OWN_HOSTS.has(host) || OWN_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return buildResult({ ...base, own: true, reason: 'own_host' });
  }

  // 3. Urheberrechtlich gesperrt
  if (isCopyrightBlockedHost(host)) {
    return buildResult({ ...base, blocked: true, reason: 'copyright_blocked' });
  }

  // 4. Fremd, aber umhostbar
  return buildResult({ ...base, rehostable: true, reason: 'foreign_host' });
}

module.exports = {
  classifyImageHost,
  isCopyrightBlockedHost,
  unwrapProxyUrl,
  safeParseUrl,
  extractHost,
  COPYRIGHT_BLOCKED_HOSTS,
  COPYRIGHT_BLOCKED_HOST_SUFFIXES,
  OWN_STORAGE_BUCKETS,
  OWN_STORAGE_HOSTS,
  OWN_CLOUD_RUN_SERVICE_PREFIXES,
  IMAGE_PROXY_PATH,
};
