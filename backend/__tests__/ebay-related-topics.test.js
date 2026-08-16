/**
 * Empfehlungs-Kacheln fuer die eBay-Angebotsvorlage.
 *
 * WARUM DIESE LIB SO GEBAUT IST (Messung 2026-08-16, 1.338 Kandidaten):
 *
 *   - 70,7 % der aktiven Angebote haben Menge 1 — ein Verkauf beendet sie. Von
 *     5.839 jemals eingestellten Angeboten sind 1.978 (33,9 %) schon wieder weg.
 *     Ein einbetonierter `/itm/<ItemID>`-Link ist deshalb nach kurzer Zeit tot.
 *     => Kachel-ZIEL ist nie ein Einzelangebot, sondern eine Verkaeufer-Suche.
 *
 *   - Es gibt nur ~81 tragfaehige Themen (>= 8 aktive Artikel) fuer 1.338
 *     Produkte; "Schwarz" allein deckt 267 ab. Themen als Kachel-INHALT waeren
 *     also im ganzen Shop immer dieselben.
 *     => Kachel-INHALT ist ein konkretes Nachbarprodukt (1.338 Varianten).
 *
 *   - Kein Preis in der Kachel. Ein Preis ist ein Versprechen, das brechen kann,
 *     sobald der abgebildete Artikel verkauft ist.
 */

const {
  buildTopicIndex,
  pickRelatedTiles,
  buildRelatedTopicsHtml,
  isRelatedTopicsEnabled,
  toCandidate,
} = require('../lib/ebay-related-topics');

const SELLER = 'trendocean-store';

/** Kandidat mit eigenem GCS-Bild (classifyImageHost -> own). */
const kandidat = (over = {}) => ({
  id: over.id || 'p1',
  title: over.title || 'Bosch Bremsscheibe Vorderachse 300mm',
  imageUrl: over.imageUrl !== undefined
    ? over.imageUrl
    : 'https://storage.googleapis.com/trendocean/img/p1.jpg',
  produktart: over.produktart !== undefined ? over.produktart : 'Bremsscheibe',
  marke: over.marke !== undefined ? over.marke : 'BOSCH',
  categoryId: over.categoryId !== undefined ? over.categoryId : '33564',
});

/** Pool mit `n` Kandidaten derselben Produktart, fortlaufende IDs. */
const poolGleicheArt = (n, over = {}) =>
  Array.from({ length: n }, (_, i) => kandidat({
    ...over,
    id: `p${i + 1}`,
    title: `Bremsscheibe Variante ${i + 1}`,
    imageUrl: `https://storage.googleapis.com/trendocean/img/p${i + 1}.jpg`,
  }));

describe('pickRelatedTiles', () => {
  it('empfiehlt niemals das Produkt, auf dessen Angebot die Kacheln stehen', () => {
    const pool = poolGleicheArt(10);
    const index = buildTopicIndex(pool, { minTopicSize: 8 });

    const tiles = pickRelatedTiles({
      product: pool[0],
      pool,
      index,
      sellerId: SELLER,
      max: 4,
    });

    expect(tiles.length).toBe(4);
    expect(tiles.map((t) => t.productId)).not.toContain('p1');
  });

  it('verlinkt auf die Verkaeufer-Suche nach dem Thema des NACHBARN, nicht auf dessen Angebot', () => {
    // 10 Bremsscheiben => Thema "Bremsscheibe" ist mit >= 8 tragfaehig.
    const pool = poolGleicheArt(10);
    const index = buildTopicIndex(pool, { minTopicSize: 8 });

    const tiles = pickRelatedTiles({
      product: pool[0], pool, index, sellerId: SELLER, max: 4,
    });

    tiles.forEach((t) => {
      // Niemals ein Einzelangebot: /itm/<ItemID> stirbt mit dem Verkauf.
      expect(t.url).not.toMatch(/\/itm\//);
      expect(t.url).toContain('_ssn=trendocean-store');
      expect(t.url).toContain('_nkw=Bremsscheibe');
    });
  });

  it('nimmt nur Kandidaten mit eigenem Bild — Amazon-Bilder duerfen nicht in die Vorlage', () => {
    // Messung 2026-07-29: 46,2 % der Produktbilder sind fremd, 23,5 % sind
    // urheberrechtlich gesperrt. Die Vorlage darf sie nicht weiterverbreiten.
    const pool = [
      kandidat({ id: 'p1' }),
      kandidat({ id: 'amazon', imageUrl: 'https://m.media-amazon.com/images/I/71abc.jpg' }),
      kandidat({ id: 'proxy-amazon', imageUrl: 'https://product-hub-backend-79205549235.europe-west3.run.app/api/image-proxy?url=https%3A%2F%2Fm.media-amazon.com%2Fimages%2FI%2F71abc.jpg' }),
      kandidat({ id: 'ebaybild', imageUrl: 'https://i.ebayimg.com/images/g/xyz/s-l1600.jpg' }),
      kandidat({ id: 'ohnebild', imageUrl: '' }),
      kandidat({ id: 'eigen2' }),
      kandidat({ id: 'eigen3' }),
      kandidat({ id: 'eigen4' }),
      kandidat({ id: 'eigen5' }),
      kandidat({ id: 'eigen6' }),
    ];
    const index = buildTopicIndex(pool, { minTopicSize: 8 });

    const tiles = pickRelatedTiles({
      product: pool[0], pool, index, sellerId: SELLER, max: 8,
    });

    const ids = tiles.map((t) => t.productId);
    expect(ids).not.toContain('amazon');
    expect(ids).not.toContain('proxy-amazon');
    expect(ids).not.toContain('ebaybild');
    expect(ids).not.toContain('ohnebild');
    expect(ids).toEqual(expect.arrayContaining(['eigen2', 'eigen3']));
  });

  it('stellt thematisch passende Nachbarn vor unverwandte', () => {
    // Die unverwandten stehen im Pool ZUERST. Ohne Bewertung wuerde die Auswahl
    // sie einfach der Reihe nach nehmen.
    const fremd = (i) => kandidat({
      id: `fremd${i}`,
      title: `Barhocker ${i}`,
      imageUrl: `https://storage.googleapis.com/trendocean/img/f${i}.jpg`,
      produktart: 'Barhocker',
      marke: 'STOOLINK',
      categoryId: '99999',
    });
    const passend = (i) => kandidat({
      id: `passend${i}`,
      title: `Bremsscheibe ${i}`,
      imageUrl: `https://storage.googleapis.com/trendocean/img/b${i}.jpg`,
    });

    const pool = [
      kandidat({ id: 'p1' }),
      ...Array.from({ length: 8 }, (_, i) => fremd(i + 1)),
      ...Array.from({ length: 8 }, (_, i) => passend(i + 1)),
    ];
    const index = buildTopicIndex(pool, { minTopicSize: 8 });

    const tiles = pickRelatedTiles({
      product: pool[0], pool, index, sellerId: SELLER, max: 4,
    });

    expect(tiles.length).toBe(4);
    tiles.forEach((t) => {
      expect(t.productId).toMatch(/^passend/);
    });
  });

  it('liefert ohne Shopnamen GAR KEINE Kacheln statt kaputter Links', () => {
    const pool = poolGleicheArt(10);
    const index = buildTopicIndex(pool, { minTopicSize: 8 });

    const tiles = pickRelatedTiles({
      product: pool[0], pool, index, sellerId: '', max: 4,
    });

    expect(tiles).toEqual([]);
  });

  it('faellt auf die Verkaeufer-Suche OHNE Suchwort zurueck, wenn kein Thema tragfaehig ist', () => {
    // 3 Bremsscheiben < minTopicSize 8 => das Thema traegt nicht. Die Suche nach
    // "Bremsscheibe" koennte leer laufen; die Suche ohne Suchwort nie.
    const pool = poolGleicheArt(3);
    const index = buildTopicIndex(pool, { minTopicSize: 8 });

    const tiles = pickRelatedTiles({
      product: pool[0], pool, index, sellerId: SELLER, max: 4,
    });

    expect(tiles.length).toBe(2);
    tiles.forEach((t) => {
      expect(t.topic).toBe('');
      expect(t.url).toBe('https://www.ebay.de/sch/i.html?_ssn=trendocean-store');
    });
  });

  it('liefert keine Kachelreihe mit nur einem Eintrag', () => {
    // Eine einzelne Kachel sieht nach Fehler aus. Dann lieber gar keine Sektion.
    const pool = [kandidat({ id: 'p1' }), kandidat({ id: 'p2', imageUrl: 'https://storage.googleapis.com/trendocean/img/p2.jpg' })];
    const index = buildTopicIndex(pool, { minTopicSize: 8 });

    const tiles = pickRelatedTiles({
      product: pool[0], pool, index, sellerId: SELLER, max: 4,
    });

    expect(tiles).toEqual([]);
  });

  it('waehlt bei gleicher Passung nicht fuer alle Produkte dieselben Nachbarn', () => {
    // Das ausdrueckliche Ziel: nicht ueberall dieselben vier Artikel.
    const pool = poolGleicheArt(20);
    const index = buildTopicIndex(pool, { minTopicSize: 8 });
    const fuer = (p) => pickRelatedTiles({ product: p, pool, index, sellerId: SELLER, max: 4 })
      .map((t) => t.productId).join(',');

    const a = fuer(pool[0]);
    const b = fuer(pool[1]);
    const c = fuer(pool[2]);

    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    // ... aber stabil: derselbe Eingang liefert denselben Ausgang.
    expect(fuer(pool[0])).toBe(a);
  });

  it('nennt in der Kachel keinen Preis', () => {
    // Ein Preis ist ein Versprechen, das bricht, sobald der Artikel verkauft ist.
    const pool = poolGleicheArt(10).map((c) => ({ ...c, price: 42.9, currentPrice: 42.9 }));
    const index = buildTopicIndex(pool, { minTopicSize: 8 });

    const tiles = pickRelatedTiles({
      product: pool[0], pool, index, sellerId: SELLER, max: 4,
    });

    tiles.forEach((t) => {
      expect(Object.keys(t)).toEqual(expect.not.arrayContaining(['price', 'currentPrice']));
      expect(JSON.stringify(t)).not.toContain('42.9');
    });
  });
});

describe('buildRelatedTopicsHtml', () => {
  const tiles = [
    {
      productId: 'a',
      title: 'Bosch Bremsscheibe Vorderachse 300mm',
      imageUrl: 'https://storage.googleapis.com/trendocean/img/a.jpg',
      topic: 'Bremsscheibe',
      url: 'https://www.ebay.de/sch/i.html?_ssn=trendocean-store&_nkw=Bremsscheibe',
    },
    {
      productId: 'b',
      title: 'ATE Bremsbeläge <Satz> & "Zubehör"',
      imageUrl: 'https://storage.googleapis.com/trendocean/img/b.jpg',
      topic: 'Bremsbelag',
      url: 'https://www.ebay.de/sch/i.html?_ssn=trendocean-store&_nkw=Bremsbelag',
    },
  ];

  it('laedt Kachelbilder verzoegert nach', () => {
    // eBay misst seit 2024 die Ladezeit am Handy und laesst sie ins Ranking
    // einfliessen. Vier zusaetzliche Bilder duerfen die Seite nicht ausbremsen.
    const html = buildRelatedTopicsHtml(tiles);
    const imgTags = html.match(/<img[^>]*>/g) || [];
    expect(imgTags.length).toBe(2);
    imgTags.forEach((tag) => {
      expect(tag).toContain('loading="lazy"');
      expect(tag).toContain('decoding="async"');
    });
  });

  it('schreibt den Produkttitel als Text in die Kachel', () => {
    // Der Text ist der Teil, den eBay als Nebensignal auswertet — er muss die
    // Woerter enthalten, nach denen gesucht wird.
    const html = buildRelatedTopicsHtml(tiles);
    expect(html).toContain('Bosch Bremsscheibe Vorderachse 300mm');
  });

  it('maskiert Sonderzeichen im Titel', () => {
    const html = buildRelatedTopicsHtml(tiles);
    expect(html).toContain('&lt;Satz&gt;');
    expect(html).toContain('&quot;Zubeh');
    expect(html).not.toContain('<Satz>');
  });

  it('rendert nichts bei leerer Kachelliste', () => {
    expect(buildRelatedTopicsHtml([])).toBe('');
    expect(buildRelatedTopicsHtml(null)).toBe('');
  });

  it('erzeugt keine aktiven Inhalte — eBay verbietet Script und iframe', () => {
    const html = buildRelatedTopicsHtml(tiles);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
});

describe('toCandidate', () => {
  const doc = (over = {}) => ({
    id: 'prod-1',
    identification: { name: 'Bosch Bremsscheibe Vorderachse 300mm', brand: 'BOSCH' },
    inventory: { quantity: 3 },
    marketplace: { ebay: { itemId: '800412345678' } },
    details: {
      categoryId: '33564',
      attributes: { Produktart: 'Bremsscheibe', Marke: 'BOSCH' },
      images: [{ url: 'https://storage.googleapis.com/trendocean/img/x.jpg' }],
    },
    ...over,
  });

  it('liest Titel, Bild, Produktart, Marke und Kategorie aus dem Produktdokument', () => {
    const c = toCandidate(doc());
    expect(c).toMatchObject({
      id: 'prod-1',
      title: 'Bosch Bremsscheibe Vorderachse 300mm',
      imageUrl: 'https://storage.googleapis.com/trendocean/img/x.jpg',
      produktart: 'Bremsscheibe',
      marke: 'BOSCH',
      categoryId: '33564',
    });
  });

  it('verwirft Produkte ohne Bestand — eine Empfehlung muss kaufbar sein', () => {
    expect(toCandidate(doc({ inventory: { quantity: 0 } }))).toBeNull();
  });

  it('verwirft Produkte, die gar nicht bei eBay stehen', () => {
    expect(toCandidate(doc({ marketplace: {} }))).toBeNull();
  });

  it('nimmt das erste EIGENE Bild, nicht einfach das erste', () => {
    const c = toCandidate(doc({
      details: {
        categoryId: '33564',
        attributes: { Produktart: 'Bremsscheibe' },
        images: [
          { url: 'https://m.media-amazon.com/images/I/71abc.jpg' },
          { url: 'https://storage.googleapis.com/trendocean/img/zweites.jpg' },
        ],
      },
    }));
    expect(c.imageUrl).toBe('https://storage.googleapis.com/trendocean/img/zweites.jpg');
  });

  it('verwirft Produkte ganz ohne eigenes Bild', () => {
    expect(toCandidate(doc({
      details: {
        categoryId: '33564',
        images: [{ url: 'https://m.media-amazon.com/images/I/71abc.jpg' }],
      },
    }))).toBeNull();
  });
});

describe('isRelatedTopicsEnabled', () => {
  const alt = process.env.EBAY_RELATED_TOPICS;
  afterEach(() => {
    if (alt === undefined) delete process.env.EBAY_RELATED_TOPICS;
    else process.env.EBAY_RELATED_TOPICS = alt;
  });

  it('ist ohne gesetzte Variable AUS', () => {
    delete process.env.EBAY_RELATED_TOPICS;
    expect(isRelatedTopicsEnabled()).toBe(false);
  });

  it('ist nur bei genau "on" an', () => {
    process.env.EBAY_RELATED_TOPICS = 'on';
    expect(isRelatedTopicsEnabled()).toBe(true);
    process.env.EBAY_RELATED_TOPICS = 'true';
    expect(isRelatedTopicsEnabled()).toBe(false);
  });
});
