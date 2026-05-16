'use strict';

// Patch toolkit.js via require.cache before loading the module under test
const brightdataMock = vi.fn(async () => ({ ok: false, results: [] }));
const webFetchMock = vi.fn(async () => ({ success: false }));

const toolkitPath = require.resolve('../../services/toolkit');
require(toolkitPath);
require.cache[toolkitPath] = {
  id: toolkitPath,
  filename: toolkitPath,
  loaded: true,
  exports: {
    executeWebSearchToolCall: brightdataMock,
    executeWebFetchToolCall: webFetchMock,
    executeSerpapiToolCall: vi.fn(),
    serpapiToolDefinition: {},
    brightdataSearchToolDefinition: {},
    webFetchToolDefinition: {},
  },
};

const {
  lookupGpsrFromWeb,
  stripTags,
  extractEmail,
  extractAddress,
  extractCompanyName,
  computeConfidence,
  emailPriorityScore,
} = require('../../lib/gpsr-web-fallback');

beforeEach(() => {
  vi.clearAllMocks();
  brightdataMock.mockReset();
  webFetchMock.mockReset();
});

describe('gpsr-web-fallback helpers', () => {
  it('extracts email from HTML with "info@brand.de"', () => {
    const html = '<p>Kontakt: info@brand.de</p>';
    const email = extractEmail(stripTags(html));
    expect(email).toBe('info@brand.de');
  });

  it('extracts German address "Musterstr. 1, D-80331 München"', () => {
    const text = 'Musterstr. 1\n80331 München\nDeutschland';
    const addr = extractAddress(text);
    expect(addr).toMatch(/Musterstr\. 1/);
    expect(addr).toMatch(/80331/);
    expect(addr).toMatch(/München/);
  });

  it('prefers legal@/info@ over newsletter@', () => {
    const text = 'newsletter@brand.de und info@brand.de sowie legal@brand.de';
    const email = extractEmail(text);
    expect(email).toBe('legal@brand.de');
    expect(emailPriorityScore('newsletter@brand.de')).toBeGreaterThan(
      emailPriorityScore('info@brand.de'),
    );
  });

  it('extracts company name from H1 when legal form present', () => {
    const html = '<html><head><title>Impressum</title></head><body><h1>Beispiel GmbH</h1></body></html>';
    const name = extractCompanyName(html, stripTags(html));
    expect(name).toBe('Beispiel GmbH');
  });

  it('computeConfidence: 0.75 when name+address+email all set', () => {
    expect(computeConfidence({ name: 'X GmbH', address: 'Str. 1', email: 'a@b.de' })).toBe(0.75);
    expect(computeConfidence({ name: 'X GmbH', address: null, email: null })).toBe(0.3);
    expect(computeConfidence({ name: null, address: null, email: null })).toBe(0);
  });

  it('stripTags strips script/style and collapses whitespace', () => {
    const html = '<style>body{color:red}</style><script>x</script><p>Hello\n\n\n\nWorld</p>';
    const plain = stripTags(html);
    expect(plain).not.toMatch(/color:red/);
    expect(plain).not.toMatch(/<script/);
    expect(plain).toMatch(/Hello/);
    expect(plain).toMatch(/World/);
  });
});

describe('lookupGpsrFromWeb()', () => {
  const IMPRESSUM_HTML = `
    <html>
      <head><title>Impressum – Beispiel GmbH</title></head>
      <body>
        <h1>Beispiel GmbH</h1>
        <p>Musterstraße 12<br/>
        80331 München<br/>
        Deutschland</p>
        <p>Kontakt: info@beispiel.de</p>
      </body>
    </html>`;

  it('returns empty when brand is missing', async () => {
    const res = await lookupGpsrFromWeb('');
    expect(res.manufacturer_name).toBeNull();
    expect(res.manufacturer_email).toBeNull();
    expect(res.confidence).toBe(0);
    expect(brightdataMock).not.toHaveBeenCalled();
  });

  it('returns empty when search yields no candidates', async () => {
    brightdataMock.mockResolvedValueOnce({ ok: false, results: [] });
    const res = await lookupGpsrFromWeb('Beispiel');
    expect(res.confidence).toBe(0);
    expect(res.manufacturer_email).toBeNull();
  });

  it('returns confidence 0.75 when email+address+name all found', async () => {
    brightdataMock.mockResolvedValueOnce({
      ok: true,
      results: [{ url: 'https://beispiel.de/impressum', title: 'Impressum', snippet: '' }],
    });
    webFetchMock.mockResolvedValueOnce({ success: true, body: IMPRESSUM_HTML });

    const res = await lookupGpsrFromWeb('Beispiel');
    expect(res.confidence).toBe(0.75);
    expect(res.manufacturer_name).toBe('Beispiel GmbH');
    expect(res.manufacturer_email).toBe('info@beispiel.de');
    expect(res.manufacturer_address).toMatch(/Musterstraße 12/);
    expect(res.manufacturer_url).toBe('https://beispiel.de');
    expect(res.sources).toContain('https://beispiel.de/impressum');
  });

  it('handles fetch failure gracefully', async () => {
    brightdataMock.mockResolvedValueOnce({
      ok: true,
      results: [{ url: 'https://unreachable.example/impressum', title: '', snippet: '' }],
    });
    webFetchMock.mockResolvedValueOnce({ success: false, error: 'blocked' });

    const res = await lookupGpsrFromWeb('Acme');
    expect(res.confidence).toBe(0);
    expect(res.sources).toContain('https://unreachable.example/impressum');
  });

  it('prefers legal@ over newsletter@ when multiple emails on page', async () => {
    brightdataMock.mockResolvedValueOnce({
      ok: true,
      results: [{ url: 'https://x.de/impressum', title: 'Impressum', snippet: '' }],
    });
    const html = `<html><body><h1>X GmbH</h1>
      <p>newsletter@x.de</p>
      <p>legal@x.de</p>
      <p>Hauptstr. 1, 10115 Berlin</p>
    </body></html>`;
    webFetchMock.mockResolvedValueOnce({ success: true, body: html });
    const res = await lookupGpsrFromWeb('X');
    expect(res.manufacturer_email).toBe('legal@x.de');
  });
});
