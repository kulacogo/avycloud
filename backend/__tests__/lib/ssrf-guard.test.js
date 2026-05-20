/**
 * SSRF-Guard tests — HARDEN-5 (2026-05-20).
 * Covers pure IP/CIDR classification + URL-level assertions.
 *
 * globals: true → describe/it/expect are global from vitest.config.js
 */

'use strict';

const {
  assertPublicHost,
  isPrivateIp,
  isPrivateV4,
  isPrivateV6,
  SSRFError,
} = require('../../lib/ssrf-guard');

describe('SSRF-Guard: pure IP classification', () => {
  it('classifies IPv4 loopback as private', () => {
    expect(isPrivateV4('127.0.0.1')).toBe(true);
    expect(isPrivateV4('127.255.255.254')).toBe(true);
  });

  it('classifies RFC1918 ranges as private', () => {
    expect(isPrivateV4('10.0.0.1')).toBe(true);
    expect(isPrivateV4('10.255.255.255')).toBe(true);
    expect(isPrivateV4('172.16.0.1')).toBe(true);
    expect(isPrivateV4('172.31.255.255')).toBe(true);
    expect(isPrivateV4('192.168.1.1')).toBe(true);
  });

  it('classifies link-local / metadata-endpoint as private', () => {
    expect(isPrivateV4('169.254.0.1')).toBe(true);
    expect(isPrivateV4('169.254.169.254')).toBe(true); // GCP/AWS metadata
  });

  it('does NOT classify public IPs as private', () => {
    expect(isPrivateV4('1.1.1.1')).toBe(false);
    expect(isPrivateV4('8.8.8.8')).toBe(false);
    expect(isPrivateV4('142.250.179.46')).toBe(false); // google.com
    expect(isPrivateV4('172.15.255.255')).toBe(false); // 1 below 172.16/12
    expect(isPrivateV4('172.32.0.0')).toBe(false);     // 1 above 172.16/12
  });

  it('classifies IPv6 loopback + link-local + ULA as private', () => {
    expect(isPrivateV6('::1')).toBe(true);
    expect(isPrivateV6('fe80::1')).toBe(true);
    expect(isPrivateV6('fc00::1')).toBe(true);
    expect(isPrivateV6('fd12:3456:789a::1')).toBe(true);
  });

  it('treats IPv4-mapped IPv6 of private addresses as private', () => {
    expect(isPrivateV6('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateV6('::ffff:10.0.0.1')).toBe(true);
  });

  it('handles invalid input gracefully', () => {
    expect(isPrivateIp('')).toBe(true);
    expect(isPrivateIp(null)).toBe(true);
    expect(isPrivateIp('not-an-ip')).toBe(false); // not an IP literal
  });
});

describe('SSRF-Guard: assertPublicHost URL-level', () => {
  it('rejects file:// and other non-http(s) protocols', async () => {
    await expect(assertPublicHost('file:///etc/passwd')).rejects.toMatchObject({
      name: 'SSRFError',
      code: 'SSRF_PROTOCOL',
    });
    await expect(assertPublicHost('gopher://example.com/foo')).rejects.toMatchObject({
      code: 'SSRF_PROTOCOL',
    });
  });

  it('rejects banned hostnames regardless of DNS', async () => {
    await expect(assertPublicHost('http://localhost/x')).rejects.toMatchObject({
      code: 'SSRF_BANNED_HOST',
    });
    await expect(assertPublicHost('http://metadata.google.internal/foo')).rejects.toMatchObject({
      code: 'SSRF_BANNED_HOST',
    });
    await expect(assertPublicHost('http://169.254.169.254/computeMetadata/v1/')).rejects.toMatchObject({
      // Numeric literal → IP-Pfad greift; banned via private-IP-check
      code: 'SSRF_BANNED_HOST',
    });
  });

  it('rejects private IP literals directly', async () => {
    await expect(assertPublicHost('http://10.0.0.1/admin')).rejects.toMatchObject({
      code: 'SSRF_PRIVATE_IP',
    });
    await expect(assertPublicHost('http://192.168.1.1/login')).rejects.toMatchObject({
      code: 'SSRF_PRIVATE_IP',
    });
  });

  it('rejects internal TLDs', async () => {
    await expect(assertPublicHost('http://service.internal/api')).rejects.toMatchObject({
      code: 'SSRF_INTERNAL_TLD',
    });
    await expect(assertPublicHost('http://printer.local/status')).rejects.toMatchObject({
      code: 'SSRF_INTERNAL_TLD',
    });
  });

  it('rejects invalid URL strings', async () => {
    await expect(assertPublicHost('not a url')).rejects.toMatchObject({
      code: 'SSRF_INVALID_URL',
    });
  });

  it('rejects URLs with empty hostnames', async () => {
    // URL('http:///path') has empty hostname
    try {
      await assertPublicHost('http:///path');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SSRFError);
    }
  });

  it('accepts a known public hostname (DNS-resolve path)', async () => {
    // example.com is reserved by IANA for documentation and always resolves
    // to public IPs. Use it as a stable positive test.
    const url = await assertPublicHost('https://example.com/');
    expect(url.hostname).toBe('example.com');
  }, 5000);

  it('accepts a public CDN IP literal', async () => {
    // 1.1.1.1 (Cloudflare) is intentionally publicly routable.
    const url = await assertPublicHost('https://1.1.1.1/');
    expect(url.hostname).toBe('1.1.1.1');
  });
});
