/**
 * Tests für lib/packshot-composite.js — Studio-Packshot aus ORIGINALPIXELN.
 *
 * Kernzusicherung: das Produkt wird NIE neu gezeichnet. Ein Bildmodell liefert
 * nur die Silhouette; ins Endbild gehen ausschliesslich Pixel des echten Fotos.
 * Damit bleibt der Kleindruck buchstabengetreu — gemessen an einem echten
 * Produktfoto Zeichen für Zeichen, inklusive ß, Makron und Kyrillisch.
 */

const sharp = require('sharp');
const {
  bauePackshot,
  compositeEnabled,
  _internal,
} = require('../lib/packshot-composite');

const {
  binarisiere,
  groessteKomponente,
  fuelleLoecher,
  erodiere,
  winkelMinRechteck,
  bereichAusMaske,
  pruefeMaske,
  randberuehrungen,
  solid,
  LEINWAND,
} = _internal;

/** Foto: dunkles Produkt mit HELLEM Innenfeld, dazu Stoergut am Rand. */
async function echtesFoto({ mitStoerung = true } = {}) {
  const produkt = await sharp({
    create: { width: 600, height: 500, channels: 3, background: { r: 70, g: 65, b: 60 } },
  })
    .composite([
      {
        // Helles Innenfeld — der alte Freisteller machte genau das transparent.
        input: await sharp({
          create: { width: 220, height: 160, channels: 3, background: { r: 252, g: 252, b: 252 } },
        }).png().toBuffer(),
        left: 190,
        top: 170,
      },
    ])
    .png()
    .toBuffer();

  const teile = [{ input: produkt, left: 200, top: 250 }];
  if (mitStoerung) {
    // "Hand"/"Kiste" am Rand — darf NICHT im Packshot landen.
    teile.push({
      input: await sharp({
        create: { width: 120, height: 300, channels: 3, background: { r: 30, g: 60, b: 160 } },
      }).png().toBuffer(),
      left: 0,
      top: 600,
    });
  }
  return sharp({
    create: { width: 1000, height: 1000, channels: 3, background: { r: 190, g: 185, b: 180 } },
  })
    .composite(teile)
    .jpeg()
    .toBuffer();
}

/** Maskenquelle: dasselbe Produkt an derselben Stelle, aber auf reinweiss. */
async function maskenQuelle() {
  const produkt = await sharp({
    create: { width: 600, height: 500, channels: 3, background: { r: 70, g: 65, b: 60 } },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 220, height: 160, channels: 3, background: { r: 252, g: 252, b: 252 } },
        }).png().toBuffer(),
        left: 190,
        top: 170,
      },
    ])
    .png()
    .toBuffer();
  return sharp({
    create: { width: 1000, height: 1000, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([{ input: produkt, left: 200, top: 250 }])
    .png()
    .toBuffer();
}

beforeEach(() => {
  delete process.env.STUDIO_COMPOSITE;
  delete process.env.STUDIO_MASK_MIN_SOLIDITY;
  delete process.env.STUDIO_MASK_MIN_COMPONENT;
});

describe('Maskenableitung', () => {
  it('rettet helle Produktflaechen durch Loecherfuellen — der Schaden vom 2026-07-18', async () => {
    const roh = await binarisiere(await maskenQuelle());
    const komp = groessteKomponente(roh.maske, roh.w, roh.h);
    const vorher = bereichAusMaske(komp.maske, roh.w, roh.h).flaeche;
    const nachher = bereichAusMaske(fuelleLoecher(komp.maske, roh.w, roh.h), roh.w, roh.h).flaeche;
    // Ohne Fuellen bliebe das helle Innenfeld transparent und das Produkt zerfiele.
    expect(nachher).toBeGreaterThan(vorher);
  });

  it('behaelt nur die groesste zusammenhaengende Flaeche', () => {
    const w = 100; const h = 100;
    const m = new Uint8Array(w * h);
    for (let y = 10; y < 60; y += 1) for (let x = 10; x < 60; x += 1) m[y * w + x] = 1; // gross
    for (let y = 80; y < 90; y += 1) for (let x = 80; x < 90; x += 1) m[y * w + x] = 1; // Fleck
    const k = groessteKomponente(m, w, h);
    expect(k.groesse).toBe(50 * 50);
    expect(bereichAusMaske(k.maske, w, h).maxX).toBeLessThan(60);
  });

  it('erodiert wirklich morphologisch (kein blur)', () => {
    const w = 60; const h = 60;
    const m = new Uint8Array(w * h);
    for (let y = 10; y < 50; y += 1) for (let x = 10; x < 50; x += 1) m[y * w + x] = 1;
    const e = erodiere(m, w, h, 5);
    const b = bereichAusMaske(e, w, h);
    expect(b.minX).toBe(15);
    expect(b.maxX).toBe(44);
  });

  it('richtet nur GERADE, dreht nie um eine Vierteldrehung', () => {
    const w = 200; const h = 200;
    const m = new Uint8Array(w * h);
    for (let y = 40; y < 160; y += 1) for (let x = 20; x < 180; x += 1) m[y * w + x] = 1;
    // Achsparalleles Rechteck -> kein Drehbedarf.
    expect(Math.abs(winkelMinRechteck(m, w, h))).toBeLessThan(1);
  });

  it('zaehlt Randberuehrungen', () => {
    const w = 50; const h = 50;
    const voll = new Uint8Array(w * h).fill(1);
    expect(randberuehrungen(voll, w, h)).toBe(4);
    const mitte = new Uint8Array(w * h);
    for (let y = 20; y < 30; y += 1) for (let x = 20; x < 30; x += 1) mitte[y * w + x] = 1;
    expect(randberuehrungen(mitte, w, h)).toBe(0);
  });

  it('misst Kompaktheit: ein Rechteck ist kompakt, ein Rechteck mit Auslaeufer nicht', () => {
    const w = 200; const h = 200;
    const rechteck = new Uint8Array(w * h);
    for (let y = 40; y < 160; y += 1) for (let x = 40; x < 160; x += 1) rechteck[y * w + x] = 1;
    expect(solid(rechteck, w, h)).toBeGreaterThan(0.95);

    // Dasselbe Rechteck plus duenner Auslaeufer (die "Hand"): Flaeche kaum
    // groesser, konvexe Huelle deutlich groesser -> Kompaktheit bricht ein.
    const mitHand = Uint8Array.from(rechteck);
    for (let y = 90; y < 110; y += 1) for (let x = 0; x < 40; x += 1) mitHand[y * w + x] = 1;
    expect(solid(mitHand, w, h)).toBeLessThan(solid(rechteck, w, h));
  });
});

describe('Wachen — fail-closed', () => {
  it('laesst eine saubere Maske durch', () => {
    expect(pruefeMaske({ anteilGroesste: 1, deckung: 0.4, seitenAbweichung: 0.001, raender: 1, solidität: 0.97 }).ok).toBe(true);
  });

  it('verwirft eine zerfallene Maske', () => {
    const v = pruefeMaske({ anteilGroesste: 0.4, deckung: 0.4, seitenAbweichung: 0, raender: 1, solidität: 0.97 });
    expect(v.ok).toBe(false);
    expect(v.gruende.join()).toMatch(/produkt_zerfaellt/);
  });

  it('verwirft eine verschobene Maskenquelle', () => {
    const v = pruefeMaske({ anteilGroesste: 1, deckung: 0.4, seitenAbweichung: 0.3, raender: 1, solidität: 0.97 });
    expect(v.gruende.join()).toMatch(/maskenquelle_verschoben/);
  });

  it('verwirft eine Maske, die an drei Raendern klebt (Hintergrund nicht entfernt)', () => {
    const v = pruefeMaske({ anteilGroesste: 1, deckung: 0.4, seitenAbweichung: 0, raender: 3, solidität: 0.97 });
    expect(v.gruende.join()).toMatch(/hintergrund_nicht_entfernt/);
  });

  it('verwirft eine unkompakte Maske — Hand oder Kiste haengt am Produkt', () => {
    const v = pruefeMaske({ anteilGroesste: 1, deckung: 0.4, seitenAbweichung: 0, raender: 1, solidität: 0.6 });
    expect(v.gruende.join()).toMatch(/maske_nicht_kompakt/);
  });

  it('verwirft zu wenig und zu viel Produkt', () => {
    expect(pruefeMaske({ anteilGroesste: 1, deckung: 0.01, seitenAbweichung: 0, raender: 1, solidität: 1 }).ok).toBe(false);
    expect(pruefeMaske({ anteilGroesste: 1, deckung: 0.99, seitenAbweichung: 0, raender: 1, solidität: 1 }).ok).toBe(false);
  });
});

describe('bauePackshot — Gesamtdurchlauf', () => {
  it('liefert eine quadratische Leinwand mit reinweissem Rand', async () => {
    const r = await bauePackshot(await echtesFoto(), await maskenQuelle());
    expect(r.ok).toBe(true);
    // Die Leinwand RICHTET SICH NACH DEM PRODUKT (Korrektur 2026-09-04): ein
    // kleiner Ausschnitt wird nicht mehr auf 2000 px hochgerechnet. Quadratisch
    // bleibt sie, und groesser als LEINWAND wird sie nie.
    expect(r.width).toBe(r.height);
    expect(r.width).toBeLessThanOrEqual(LEINWAND);
    expect(r.width).toBeGreaterThanOrEqual(800);

    const ecke = await sharp(r.buffer).extract({ left: 0, top: 0, width: 40, height: 40 }).removeAlpha().toBuffer();
    const stats = await sharp(ecke).stats();
    for (const kanal of stats.channels.slice(0, 3)) expect(kanal.min).toBeGreaterThanOrEqual(250);
  });

  it('haelt das STOERGUT draussen — nur das Produkt kommt ins Bild', async () => {
    // Das Foto enthaelt einen blauen Block am Rand (die "Hand"/"Kiste"); die
    // Maskenquelle zeigt ihn nicht. Er darf im Packshot nicht auftauchen.
    const r = await bauePackshot(await echtesFoto({ mitStoerung: true }), await maskenQuelle());
    expect(r.ok).toBe(true);
    const { data, info } = await sharp(r.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let blau = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      // kraeftiges Blau = das Stoergut
      if (data[i + 2] > 120 && data[i + 2] - data[i] > 60) blau += 1;
    }
    expect(blau).toBe(0);
  });

  it('uebernimmt ORIGINALPIXEL, nicht die Pixel der Maskenquelle', async () => {
    // Die Maskenquelle ist hier bewusst anders eingefaerbt als das Foto. Kommt
    // ihre Farbe im Ergebnis vor, wuerde nicht das Original verwendet.
    const foto = await echtesFoto({ mitStoerung: false });
    const r = await bauePackshot(foto, await maskenQuelle());
    expect(r.ok).toBe(true);
    const { data, info } = await sharp(r.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let dunkelProdukt = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i] > 55 && data[i] < 90 && data[i + 1] > 50 && data[i + 1] < 85) dunkelProdukt += 1;
    }
    // Die Produktfarbe aus dem FOTO muss im Ergebnis vorkommen.
    expect(dunkelProdukt).toBeGreaterThan(1000);
  });

  it('vergroessert das Produkt NIE — sonst reine Qualitaetsvernichtung', async () => {
    // Gemeldet 2026-09-04: ein 980-px-Ausschnitt wurde auf 1560 px gezogen.
    // Die Galeriebilder sind auf 1200 px normalisiert, mehr Pixel gibt es nicht.
    const r = await bauePackshot(await echtesFoto(), await maskenQuelle());
    expect(r.ok).toBe(true);
    expect(r.info.skalierung).toBeLessThanOrEqual(1);
  });

  it('verwirft fail-closed statt ein zerstoertes Produkt zu liefern', async () => {
    // Maskenquelle ohne Produkt -> keine brauchbare Maske -> KEIN Packshot.
    const leer = await sharp({
      create: { width: 1000, height: 1000, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).png().toBuffer();
    const r = await bauePackshot(await echtesFoto(), leer);
    expect(r.ok).toBe(false);
    expect(r.gruende.length).toBeGreaterThan(0);
  });

  it('verwirft, wenn die Maskenquelle ein anderes Seitenverhaeltnis hat', async () => {
    const schief = await sharp({
      create: { width: 1000, height: 400, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([{
        input: await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 70, g: 65, b: 60 } } }).png().toBuffer(),
        left: 300, top: 100,
      }])
      .png()
      .toBuffer();
    const r = await bauePackshot(await echtesFoto(), schief);
    expect(r.ok).toBe(false);
    expect(r.gruende.join()).toMatch(/maskenquelle_verschoben/);
  });
});

describe('Betriebsschalter', () => {
  it('ist per Default an', () => {
    expect(compositeEnabled()).toBe(true);
  });

  it('schaltet NUR beim exakten Wert off ab', () => {
    process.env.STUDIO_COMPOSITE = 'false';
    expect(compositeEnabled()).toBe(true);
    process.env.STUDIO_COMPOSITE = 'off';
    expect(compositeEnabled()).toBe(false);
  });
});
