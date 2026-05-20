'use strict';

/**
 * SSRF-Guard für ausgehende Requests, die User-Input als Ziel-URL akzeptieren
 * (`/api/image-proxy`, `fetch_url_content`-Tool, evtl. weitere Atomic-Tools).
 *
 * Schützt gegen:
 *  - Loopback (`127.0.0.0/8`, `::1`)
 *  - Link-Local (`169.254.0.0/16`, `fe80::/10`) inkl. GCP/AWS Metadata-Endpunkt
 *  - Private RFC1918 (`10/8`, `172.16/12`, `192.168/16`)
 *  - IPv4-mapped IPv6 die auf privaten v4 zeigen (`::ffff:127.0.0.1`)
 *  - Hostnames die als `localhost`/`metadata` getarnt sind
 *  - DNS-Rebinding (lookup separat, alle resolved A/AAAA müssen public sein)
 *
 * Nutzung:
 *   const { assertPublicHost } = require('./ssrf-guard');
 *   await assertPublicHost(targetUrl); // wirft SSRFError bei Problem
 *
 * HARDEN-5 (2026-05-20): bewusst KEIN Auth-Gate auf /api/image-proxy, da die
 * Route von `<img src>` ohne Authorization-Header konsumiert wird (frontend
 * `ImageGallery.tsx`, `api/client.ts`). Stattdessen SSRF-Härtung hier.
 */

const dns = require('dns').promises;
const net = require('net');

class SSRFError extends Error {
  constructor(message, code = 'SSRF_BLOCKED') {
    super(message);
    this.name = 'SSRFError';
    this.code = code;
    this.statusCode = 400;
  }
}

// Hostnames, die immer geblockt werden, unabhängig von Resolution.
const BANNED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'metadata.gce.internal',
  'instance-data',
  '169.254.169.254',
  'kubernetes',
  'kubernetes.default',
  'kubernetes.default.svc',
  'kubernetes.default.svc.cluster.local',
]);

// CIDR-Bereiche die als nicht-public gelten.
const PRIVATE_V4_RANGES = [
  ['127.0.0.0', 8],     // loopback
  ['10.0.0.0', 8],      // RFC1918
  ['172.16.0.0', 12],   // RFC1918
  ['192.168.0.0', 16],  // RFC1918
  ['169.254.0.0', 16],  // link-local incl. metadata
  ['100.64.0.0', 10],   // carrier-grade NAT
  ['192.0.0.0', 24],    // IETF Protocol Assignments
  ['192.0.2.0', 24],    // TEST-NET-1
  ['198.18.0.0', 15],   // Benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24],  // TEST-NET-3
  ['224.0.0.0', 4],     // multicast
  ['240.0.0.0', 4],     // reserved
  ['0.0.0.0', 8],       // current network
];

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const p of parts) {
    const n = Number.parseInt(p, 10);
    if (!Number.isFinite(n) || n < 0 || n > 255) return null;
    result = (result * 256) + n;
  }
  return result;
}

function isPrivateV4(ip) {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;
  for (const [cidrStart, mask] of PRIVATE_V4_RANGES) {
    const startInt = ipv4ToInt(cidrStart);
    if (startInt === null) continue;
    const shift = 32 - mask;
    // eslint-disable-next-line no-bitwise
    const network = (startInt >>> shift) << shift;
    // eslint-disable-next-line no-bitwise
    const candidate = (ipInt >>> shift) << shift;
    if (network === candidate) return true;
  }
  return false;
}

function isPrivateV6(ip) {
  const lower = String(ip || '').toLowerCase();
  if (!lower) return false;
  // Loopback
  if (lower === '::1') return true;
  // IPv4-mapped (::ffff:1.2.3.4) — re-check on the v4 component
  const mappedMatch = lower.match(/^::ffff:([0-9a-f.:]+)$/);
  if (mappedMatch) {
    const v4 = mappedMatch[1];
    if (v4.includes('.')) {
      return isPrivateV4(v4);
    }
  }
  // Link-local
  if (lower.startsWith('fe80:') || lower.startsWith('fe80::')) return true;
  // Unique local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // Multicast (ff00::/8) — block too
  if (lower.startsWith('ff')) return true;
  return false;
}

function isPrivateIp(ip) {
  if (!ip) return true;
  const v = String(ip).trim();
  if (!v) return true;
  if (net.isIPv4(v)) return isPrivateV4(v);
  if (net.isIPv6(v)) return isPrivateV6(v);
  return false;
}

function normalizeHostname(host) {
  return String(host || '').trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * Throw if the URL points anywhere except a public, routable host on
 * http/https. Performs DNS lookup if hostname is not already an IP literal.
 *
 * @param {string|URL} input — URL string or URL instance
 * @returns {Promise<URL>} the parsed URL (for chaining)
 */
async function assertPublicHost(input) {
  let parsed;
  try {
    parsed = input instanceof URL ? input : new URL(String(input));
  } catch {
    throw new SSRFError('Invalid URL', 'SSRF_INVALID_URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new SSRFError(`Protocol ${parsed.protocol} not allowed`, 'SSRF_PROTOCOL');
  }

  const host = normalizeHostname(parsed.hostname);
  if (!host) {
    throw new SSRFError('Empty hostname', 'SSRF_EMPTY_HOST');
  }
  if (BANNED_HOSTNAMES.has(host)) {
    throw new SSRFError(`Hostname ${host} is banned`, 'SSRF_BANNED_HOST');
  }
  // Block any *.internal / *.local / *.cluster.local-style internal TLDs
  if (host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.localdomain')) {
    throw new SSRFError(`Internal TLD blocked: ${host}`, 'SSRF_INTERNAL_TLD');
  }

  // If hostname is already an IP literal, check directly without DNS.
  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      throw new SSRFError(`Private IP blocked: ${host}`, 'SSRF_PRIVATE_IP');
    }
    return parsed;
  }

  // Resolve and check every returned address. This is best-effort; DNS-rebinding
  // attacks can still race the actual fetch — for absolute safety the fetch
  // would need to be pinned to the resolved IP. For now this catches the
  // common cases (`metadata.google.internal`, `localhost`, etc.).
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new SSRFError(`DNS lookup failed for ${host}: ${err.message}`, 'SSRF_DNS_FAIL');
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new SSRFError(`No DNS results for ${host}`, 'SSRF_DNS_EMPTY');
  }

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new SSRFError(`Hostname ${host} resolved to private IP ${address}`, 'SSRF_PRIVATE_RESOLVE');
    }
  }

  return parsed;
}

module.exports = {
  assertPublicHost,
  isPrivateIp,
  isPrivateV4,
  isPrivateV6,
  SSRFError,
  BANNED_HOSTNAMES,
};
