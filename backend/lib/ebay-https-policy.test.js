const {
  forceHttpsUrl,
  forceHttpsInHtml,
  buildAddFixedPriceItemXml,
  isRestrictedTermsError,
  describeRestrictedTermsError,
} = require('./ebay-trading-api');

describe('forceHttpsUrl', () => {
  test('upgrades http:// to https://', () => {
    expect(forceHttpsUrl('http://img.example.com/a.jpg')).toBe('https://img.example.com/a.jpg');
  });
  test('leaves https:// untouched', () => {
    expect(forceHttpsUrl('https://storage.googleapis.com/b.jpg')).toBe('https://storage.googleapis.com/b.jpg');
  });
  test('case-insensitive scheme + empty input', () => {
    expect(forceHttpsUrl('HTTP://x.de/i.png')).toBe('https://x.de/i.png');
    expect(forceHttpsUrl('')).toBe('');
    expect(forceHttpsUrl(null)).toBe('');
  });
  test('does not touch http inside the path/query', () => {
    expect(forceHttpsUrl('https://x.de/r?u=http://y.de')).toBe('https://x.de/r?u=http://y.de');
  });
});

describe('forceHttpsInHtml', () => {
  test('rewrites embedded http:// image resources in description HTML', () => {
    const html = '<p>Foo</p><img src="http://cdn.example.com/p.jpg"><a href="http://x.de">x</a>';
    const out = forceHttpsInHtml(html);
    expect(out).not.toMatch(/http:\/\//);
    expect(out).toContain('https://cdn.example.com/p.jpg');
    expect(out).toContain('https://x.de');
  });
});

describe('buildAddFixedPriceItemXml HTTPS enforcement (eBay error 21919490)', () => {
  const base = {
    title: 'Test',
    primaryCategoryId: '267',
    startPrice: 9.99,
    currency: 'EUR',
    quantity: 1,
  };

  test('picture URLs are emitted as https in PictureDetails', () => {
    const xml = buildAddFixedPriceItemXml(
      { ...base, pictureUrls: ['http://img.example.com/1.jpg', 'https://cdn.de/2.jpg'] },
      {}
    );
    expect(xml).toContain('<PictureURL>https://img.example.com/1.jpg</PictureURL>');
    expect(xml).not.toMatch(/<PictureURL>http:\/\//);
  });

  test('description http resources are upgraded to https', () => {
    const xml = buildAddFixedPriceItemXml(
      { ...base, description: '<img src="http://cdn.example.com/p.jpg">' },
      {}
    );
    expect(xml).not.toMatch(/http:\/\//);
    expect(xml).toContain('https://cdn.example.com/p.jpg');
  });
});

describe('isRestrictedTermsError / describeRestrictedTermsError (eBay error 240)', () => {
  test('detects by error code 240', () => {
    expect(isRestrictedTermsError([{ errorCode: '240', longMessage: 'whatever' }])).toBe(true);
  });

  test('detects by German policy boilerplate', () => {
    const errors = [{
      code: null,
      longMessage:
        'Der Artikel kann weder eingestellt noch bearbeitet werden. Die Artikelbezeichnung ' +
        'und/oder -beschreibung enthalten unter Umständen unzulässige Begriffe oder das Angebot ' +
        'verstößt gegen die eBay-Grundsätze.',
    }];
    expect(isRestrictedTermsError(errors)).toBe(true);
    const msg = describeRestrictedTermsError(errors);
    expect(msg).toMatch(/Fehler 240/);
    expect(msg).toMatch(/manuelle/i);
  });

  test('does not misfire on unrelated errors', () => {
    expect(isRestrictedTermsError([{ errorCode: '21919303', longMessage: 'Missing aspect' }])).toBe(false);
    expect(describeRestrictedTermsError([{ errorCode: '21919303' }])).toBeNull();
    expect(isRestrictedTermsError([])).toBe(false);
  });
});
