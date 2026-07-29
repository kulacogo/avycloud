/**
 * Tests fuer lib/image-hosts.js — reine Host-Klassifizierung, kein I/O.
 *
 * Hintergrund (Messung 2026-07-29): 1.476 von 3.690 Bildadressen liegen auf
 * fremden Shop-Servern. 719 Fotos stammen von m.media-amazon.com und duerfen
 * aus Urheberrechtsgruenden NICHT auf eigenen Speicher kopiert werden.
 * 373 Adressen sind /api/image-proxy?url=-Wrapper — dort muss der INNERE Host
 * klassifiziert werden, sonst sieht ein Amazon-Bild wie ein eigenes aus.
 */

const {
  classifyImageHost,
  isCopyrightBlockedHost,
  unwrapProxyUrl,
  COPYRIGHT_BLOCKED_HOSTS,
  COPYRIGHT_BLOCKED_HOST_SUFFIXES,
  OWN_STORAGE_BUCKETS,
} = require('../../lib/image-hosts');

describe('classifyImageHost — eigener Speicher', () => {
  it('erkennt GCS-Bucket prodsandjobs als eigen', () => {
    const r = classifyImageHost('https://storage.googleapis.com/prodsandjobs/products/SKU-1/main_abc.jpg');
    expect(r.host).toBe('storage.googleapis.com');
    expect(r.own).toBe(true);
    expect(r.rehostable).toBe(false);
    expect(r.reason).toBe('own_storage_bucket');
    expect(r.bucket).toBe('prodsandjobs');
  });

  it('erkennt avycloud-*-Buckets als eigen', () => {
    for (const bucket of ['avycloud-product-images', 'avycloud-genai-images', 'avycloud-irgendwas-neu']) {
      const r = classifyImageHost(`https://storage.googleapis.com/${bucket}/x/y.jpg`);
      expect(r.own).toBe(true);
      expect(r.reason).toBe('own_storage_bucket');
    }
  });

  it('erkennt den Tenant-Bucket trendocean als eigen', () => {
    expect(classifyImageHost('https://storage.googleapis.com/trendocean/a.jpg').own).toBe(true);
    expect(OWN_STORAGE_BUCKETS.has('trendocean')).toBe(true);
  });

  it('behandelt einen FREMDEN GCS-Bucket nicht als eigen', () => {
    const r = classifyImageHost('https://storage.googleapis.com/fremder-shop-bucket/a.jpg');
    expect(r.own).toBe(false);
    expect(r.rehostable).toBe(true);
    expect(r.reason).toBe('foreign_host');
  });

  it('erkennt die eigene Cloud-Run-Domain als eigen', () => {
    const r = classifyImageHost('https://product-hub-backend-79205549235.europe-west3.run.app/api/images/x.jpg');
    expect(r.own).toBe(true);
    expect(r.reason).toBe('own_cloud_run');
  });

  it('erkennt die alte Cloud-Run-Domain (sa6a4cbk3q-ey) als eigen', () => {
    expect(classifyImageHost('https://product-hub-backend-sa6a4cbk3q-ey.a.run.app/x.jpg').own).toBe(true);
  });

  it('behandelt eine fremde run.app-Domain nicht als eigen', () => {
    const r = classifyImageHost('https://fremd-service-123.europe-west3.run.app/x.jpg');
    expect(r.own).toBe(false);
    expect(r.rehostable).toBe(true);
  });
});

describe('classifyImageHost — image-proxy-Wrapper', () => {
  const proxied = (inner) =>
    `https://product-hub-backend-79205549235.europe-west3.run.app/api/image-proxy?url=${encodeURIComponent(inner)}`;

  it('klassifiziert den INNEREN Host, nicht den Wrapper', () => {
    const r = classifyImageHost(proxied('https://i.ebayimg.com/images/g/JgUAAOSw6CRm2Fmr/s-l1200.jpg'));
    expect(r.host).toBe('i.ebayimg.com');
    expect(r.own).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.rehostable).toBe(false);
    expect(r.reason).toBe('copyright_blocked');
    expect(r.proxied).toBe(true);
    expect(r.wrapperHost).toBe('product-hub-backend-79205549235.europe-west3.run.app');
  });

  it('erkennt Kaufland hinter dem Proxy als gesperrt', () => {
    const r = classifyImageHost(proxied('https://media.cdn.kaufland.de/product-images/original/c5b12836956e8'));
    expect(r.host).toBe('media.cdn.kaufland.de');
    expect(r.blocked).toBe(true);
    expect(r.rehostable).toBe(false);
  });

  it('erkennt einen rehostbaren Fremdshop hinter dem Proxy', () => {
    const r = classifyImageHost(proxied('https://cdn.autodoc.de/thumb?id=123'));
    expect(r.host).toBe('cdn.autodoc.de');
    expect(r.own).toBe(false);
    expect(r.blocked).toBe(false);
    expect(r.rehostable).toBe(true);
    expect(r.proxied).toBe(true);
  });

  it('erkennt eigenen Speicher hinter dem Proxy als eigen', () => {
    const r = classifyImageHost(proxied('https://storage.googleapis.com/prodsandjobs/products/a/b.jpg'));
    expect(r.own).toBe(true);
    expect(r.proxied).toBe(true);
  });

  it('faellt bei kaputtem inneren url-Parameter auf den Wrapper zurueck', () => {
    const r = classifyImageHost(
      'https://product-hub-backend-79205549235.europe-west3.run.app/api/image-proxy?url=%%%kaputt'
    );
    expect(r.host).toBe('product-hub-backend-79205549235.europe-west3.run.app');
    expect(r.own).toBe(true);
    expect(r.proxied).toBe(false);
  });

  it('unwrapProxyUrl gibt die innere Adresse zurueck', () => {
    const inner = 'https://m.media-amazon.com/images/I/71abc.jpg';
    expect(unwrapProxyUrl(proxied(inner))).toBe(inner);
    expect(unwrapProxyUrl('https://cdn.autodoc.de/x.jpg')).toBe(null);
    expect(unwrapProxyUrl(null)).toBe(null);
  });
});

describe('isCopyrightBlockedHost — Denylist', () => {
  it('sperrt Amazon-Bildhosts', () => {
    expect(isCopyrightBlockedHost('https://m.media-amazon.com/images/I/71abc.jpg')).toBe(true);
    expect(isCopyrightBlockedHost('https://images-na.ssl-images-amazon.com/images/I/x.jpg')).toBe(true);
    expect(isCopyrightBlockedHost('https://images-eu.ssl-images-amazon.com/images/I/x.jpg')).toBe(true);
    expect(isCopyrightBlockedHost('https://images.media-amazon.com/x.jpg')).toBe(true);
  });

  it('sperrt eBay-Bildhosts', () => {
    expect(isCopyrightBlockedHost('https://i.ebayimg.com/images/g/abc/s-l1600.jpg')).toBe(true);
    expect(isCopyrightBlockedHost('https://i9.ebayimg.com/x.jpg')).toBe(true);
  });

  it('sperrt Kaufland-Bildhost', () => {
    expect(isCopyrightBlockedHost('https://media.cdn.kaufland.de/product-images/original/x')).toBe(true);
  });

  it('sperrt auch hinter dem image-proxy-Wrapper', () => {
    const wrapped =
      'https://product-hub-backend-79205549235.europe-west3.run.app/api/image-proxy?url=' +
      encodeURIComponent('https://m.media-amazon.com/images/I/71abc.jpg');
    expect(isCopyrightBlockedHost(wrapped)).toBe(true);
  });

  it('akzeptiert auch einen blanken Hostnamen', () => {
    expect(isCopyrightBlockedHost('m.media-amazon.com')).toBe(true);
    expect(isCopyrightBlockedHost('cdn.autodoc.de')).toBe(false);
  });

  it('sperrt NICHT bei aehnlich klingenden Fremd-Domains (kein naives includes)', () => {
    expect(isCopyrightBlockedHost('https://ebayimg.com.boeser-shop.de/x.jpg')).toBe(false);
    expect(isCopyrightBlockedHost('https://not-media-amazon.com.evil.de/x.jpg')).toBe(false);
    expect(isCopyrightBlockedHost('https://kaufland.de/x.jpg')).toBe(false);
  });

  it('exportiert die Denylist als benannte, erweiterbare Konstante', () => {
    expect(COPYRIGHT_BLOCKED_HOSTS.has('m.media-amazon.com')).toBe(true);
    expect(COPYRIGHT_BLOCKED_HOSTS.has('i.ebayimg.com')).toBe(true);
    expect(COPYRIGHT_BLOCKED_HOSTS.has('media.cdn.kaufland.de')).toBe(true);
    expect(COPYRIGHT_BLOCKED_HOST_SUFFIXES).toContain('.media-amazon.com');
    expect(COPYRIGHT_BLOCKED_HOST_SUFFIXES).toContain('.ebayimg.com');
  });
});

describe('classifyImageHost — Muell-Eingaben werfen nie', () => {
  const junk = [
    undefined,
    null,
    '',
    '   ',
    0,
    123,
    {},
    [],
    NaN,
    'kein-url',
    'http://',
    'https://',
    ':::',
    'javascript:alert(1)',
  ];

  it('liefert fuer jeden Muell ein Objekt statt eines Throws', () => {
    for (const v of junk) {
      let r;
      expect(() => {
        r = classifyImageHost(v);
      }).not.toThrow();
      expect(typeof r).toBe('object');
      expect(r.own).toBe(false);
      expect(r.rehostable).toBe(false);
      expect(typeof r.reason).toBe('string');
    }
  });

  it('markiert data:-URIs eigenstaendig', () => {
    const r = classifyImageHost('data:image/png;base64,iVBORw0KGgo=');
    expect(r.reason).toBe('data_uri');
    expect(r.own).toBe(false);
    expect(r.rehostable).toBe(false);
    expect(r.host).toBe(null);
  });

  it('markiert relative Pfade eigenstaendig', () => {
    for (const p of ['/products/a/b.jpg', 'products/a/b.jpg', './x.png', '../y.png']) {
      const r = classifyImageHost(p);
      expect(r.reason).toBe('relative_path');
      expect(r.own).toBe(false);
      expect(r.rehostable).toBe(false);
    }
  });

  it('markiert leere Eingaben als empty', () => {
    expect(classifyImageHost('').reason).toBe('empty');
    expect(classifyImageHost(null).reason).toBe('empty');
    expect(classifyImageHost('   ').reason).toBe('empty');
  });

  it('behandelt protokoll-relative Adressen als https', () => {
    const r = classifyImageHost('//m.media-amazon.com/images/I/71abc.jpg');
    expect(r.host).toBe('m.media-amazon.com');
    expect(r.blocked).toBe(true);
  });

  it('normalisiert Grossschreibung und www-Ports', () => {
    const r = classifyImageHost('HTTPS://M.MEDIA-AMAZON.COM:443/images/I/71abc.jpg');
    expect(r.host).toBe('m.media-amazon.com');
    expect(r.blocked).toBe(true);
  });

  it('isCopyrightBlockedHost wirft nie bei Muell', () => {
    for (const v of junk) {
      expect(() => isCopyrightBlockedHost(v)).not.toThrow();
      expect(isCopyrightBlockedHost(v)).toBe(false);
    }
  });
});

describe('classifyImageHost — Fremdshops (rehostbar)', () => {
  it('markiert gemessene Fremd-CDNs als rehostbar', () => {
    for (const h of ['cdn.autodoc.de', 'cdn.idealo.com', 'i.otto.de', 'img.kwcdn.com', 'www.ikea.com']) {
      const r = classifyImageHost(`https://${h}/bild.jpg`);
      expect(r.host).toBe(h);
      expect(r.own).toBe(false);
      expect(r.blocked).toBe(false);
      expect(r.rehostable).toBe(true);
      expect(r.reason).toBe('foreign_host');
    }
  });
});
