const { buildAddressLabelsHtml } = require('../services/label-printer');

describe('buildAddressLabelsHtml', () => {
  it('generates HTML with all 3 address lines', () => {
    const html = buildAddressLabelsHtml([
      { name: 'Max Mustermann', street: 'Musterstr. 1', zip: '10115', city: 'Berlin' },
    ]);
    expect(html).toContain('Max Mustermann');
    expect(html).toContain('Musterstr. 1');
    expect(html).toContain('10115 Berlin');
  });

  it('generates multiple labels with page-break-after', () => {
    const addrs = Array.from({ length: 5 }, (_, i) => ({
      name: `Person ${i}`,
      street: `Straße ${i}`,
      zip: '12345',
      city: 'Stadt',
    }));
    const html = buildAddressLabelsHtml(addrs);
    const labelCount = (html.match(/class="label"/g) || []).length;
    expect(labelCount).toBe(5);
    expect(html).toContain('page-break-after: always');
  });

  it('enforces white-space: nowrap on every line', () => {
    const html = buildAddressLabelsHtml([
      { name: 'Test', street: 'Str. 1', zip: '00000', city: 'Ort' },
    ]);
    expect(html).toContain('white-space: nowrap');
  });

  it('uses larger font for short addresses', () => {
    const html = buildAddressLabelsHtml([
      { name: 'Max', street: 'Str. 1', zip: '12345', city: 'Ort' },
    ]);
    const match = html.match(/font-size:([\d.]+)mm/);
    expect(match).toBeTruthy();
    const size = parseFloat(match[1]);
    expect(size).toBeGreaterThanOrEqual(4.5);
  });

  it('uses smaller font for long addresses', () => {
    const html = buildAddressLabelsHtml([
      { name: 'Dr. Hans-Friedrich von Mecklenburg-Schwerin', street: 'Obere Schmiedgasse am Marktplatz 147a', zip: '08062', city: 'Zwickau-Planitz' },
    ]);
    const match = html.match(/font-size:([\d.]+)mm/);
    expect(match).toBeTruthy();
    const size = parseFloat(match[1]);
    expect(size).toBeGreaterThanOrEqual(3.2);
    expect(size).toBeLessThan(4.5);
  });

  it('includes auto-print and auto-close scripts', () => {
    const html = buildAddressLabelsHtml([
      { name: 'Test', street: 'Str. 1', zip: '12345', city: 'Stadt' },
    ]);
    expect(html).toContain('window.print()');
    expect(html).toContain('window.close()');
  });

  it('preserves leading zeros in zip codes', () => {
    const html = buildAddressLabelsHtml([
      { name: 'Test', street: 'Str.', zip: '01234', city: 'Dresden' },
    ]);
    expect(html).toContain('01234 Dresden');
  });

  it('throws on empty input', () => {
    expect(() => buildAddressLabelsHtml([])).toThrow('Mindestens eine Adresse');
    expect(() => buildAddressLabelsHtml(null)).toThrow();
  });

  it('escapes HTML in address fields', () => {
    const html = buildAddressLabelsHtml([
      { name: '<script>alert(1)</script>', street: 'Str. & Co.', zip: '12345', city: 'Stadt' },
    ]);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&amp;');
  });

  it('uses 62mm x 29mm page size', () => {
    const html = buildAddressLabelsHtml([
      { name: 'Test', street: 'Str.', zip: '12345', city: 'Stadt' },
    ]);
    expect(html).toContain('size: 62mm 29mm');
  });
});
