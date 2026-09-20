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
    //
    // KEINE 800-px-UNTERGRENZE MEHR (2026-09-10): sie band bei kleineren
    // Ausschnitten VOR dem Fuellziel und drueckte die Fuellung auf 75 % statt
    // 92 %. Geschuetzt hat sie nichts — lib/storage.js normalisiert jedes
    // Galeriebild ohnehin auf 1200 px lange Kante.
    expect(r.width).toBe(r.height);
    expect(r.width).toBeLessThanOrEqual(LEINWAND);
    expect(r.info.fuellungBreite).toBeGreaterThan(88);

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
    // Das Fenster deckt den Quellton (70/65/60) UND seine belichtungskorrigierte
    // Fassung ab: der Untergrund des Fixtures ist hell, also greift seit
    // 2026-09-10 eine Verstaerkung von bis zu 1,6. Sie ist LINEAR — die
    // Pixelherkunft aendert sie nicht, nur den Tonwert. Geprueft wird deshalb
    // die dunkle Produkthuelle gegen den hellen Grund, nicht ein exakter Wert.
    let dunkelProdukt = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i] > 55 && data[i] < 130 && data[i + 1] > 50 && data[i + 1] < 125) dunkelProdukt += 1;
    }
    // Die Produktfarbe aus dem FOTO muss im Ergebnis vorkommen.
    expect(dunkelProdukt).toBeGreaterThan(1000);
    // Und der Kontrast zum hellen Innenfeld bleibt erhalten — eine lineare
    // Verstaerkung verschiebt beide, sie zieht sie nicht zusammen.
    let hellInnen = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) hellInnen += 1;
    }
    expect(hellInnen).toBeGreaterThan(1000);
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

/**
 * VERLAUFSGRUND (seit 2026-09-10) — fuer die Angebotsgalerie.
 *
 * Der Betreiber hat den hellgrauen e-Commerce-Verlauf vorgegeben. Die
 * gerenderten Ansichten liefern ihn ohnehin; ein reinweisser Packshot daneben
 * fiele als Fremdkoerper auf. Die VOREINSTELLUNG bleibt Weiss, damit der
 * Studio-Foto-Weg unveraendert bleibt.
 */
describe('Hintergrund der Leinwand', () => {
  it('ist ohne Angabe REINWEISS — Studio-Weg unveraendert', async () => {
    const r = await bauePackshot(await echtesFoto(), await maskenQuelle());
    expect(r.ok).toBe(true);
    expect(r.info.hintergrund).toBe('weiss');
    const ecke = await sharp(r.buffer)
      .extract({ left: 0, top: 0, width: 40, height: 40 })
      .removeAlpha()
      .toBuffer();
    const stats = await sharp(ecke).stats();
    for (const k of stats.channels) expect(k.min).toBeGreaterThanOrEqual(250);
  });

  it('legt auf Wunsch einen hellgrauen Verlauf an — Ecke dunkler als Mitte', async () => {
    const r = await bauePackshot(await echtesFoto(), await maskenQuelle(), {
      hintergrund: 'verlauf',
    });
    expect(r.ok).toBe(true);
    expect(r.info.hintergrund).toBe('verlauf');

    const mittel = async (left, top) => {
      const teil = await sharp(r.buffer)
        .extract({ left, top, width: 30, height: 30 })
        .removeAlpha()
        .toBuffer();
      return (await sharp(teil).stats()).channels[0].mean;
    };
    const ecke = await mittel(0, 0);
    // Knapp neben dem hellen Kern, aber noch ausserhalb des Produkts.
    const nahMitte = await mittel(Math.round(r.width * 0.5) - 15, Math.round(r.height * 0.04));

    expect(nahMitte).toBeGreaterThan(ecke);
    // Schmales Band: der Verlauf soll Tiefe andeuten, nicht als grauer Kasten
    // auffallen. Faellt er zu weit ab, sieht das Bild schmutzig aus.
    expect(ecke).toBeGreaterThan(215);
    expect(nahMitte).toBeLessThanOrEqual(255);
  });

  it('haelt auch beim Verlauf die Rand-Wache scharf', async () => {
    // Eine Maske, die den ganzen Rahmen als Produkt fuehrt, muss auch mit
    // Verlauf abgelehnt werden — sonst raegt Hintergrund oder Hand ins Bild.
    const randvoll = await sharp({
      create: { width: 1000, height: 1000, channels: 3, background: { r: 20, g: 20, b: 20 } },
    })
      .png()
      .toBuffer();
    const r = await bauePackshot(await echtesFoto(), randvoll, { hintergrund: 'verlauf' });
    expect(r.ok).toBe(false);
  });
});

/**
 * BELICHTUNG / WEISSABGLEICH aus dem HINTERGRUND (seit 2026-09-10).
 *
 * Anlass: der pixeltreue Weg übernimmt die Pixel des Fotos — und damit dessen
 * Belichtung. Gemessen am Marstek-Speicher: Hintergrund 195, das WEISSE Gerät
 * nur 125. Der Packshot zeigte ein mattgraues Produkt.
 *
 * Die Korrektur nimmt bewusst den HINTERGRUND als Referenz (Graukarten-Methode)
 * und nicht das Produkt: derselbe Faktor wirkt überall, also bleiben alle Farben
 * ZUEINANDER unverändert. Aus Beige kann so bauartbedingt kein Weiss werden.
 */
describe('Belichtung aus dem Hintergrund', () => {
  /** Foto mit einstellbarem Untergrund und Produkt-Tonwert. */
  async function fotoMit({ grund, produktTon }) {
    const produkt = await sharp({
      create: { width: 600, height: 500, channels: 3, background: produktTon },
    })
      .png()
      .toBuffer();
    return sharp({ create: { width: 1000, height: 1000, channels: 3, background: grund } })
      .composite([{ input: produkt, left: 200, top: 250 }])
      .jpeg()
      .toBuffer();
  }

  /** Mittlerer Tonwert der Produktfläche im fertigen Packshot. */
  async function produktTon(buffer) {
    const m = await sharp(buffer).metadata();
    const teil = await sharp(buffer)
      .extract({
        left: Math.round(m.width * 0.45),
        top: Math.round(m.height * 0.45),
        width: Math.round(m.width * 0.1),
        height: Math.round(m.height * 0.1),
      })
      .removeAlpha()
      .toBuffer();
    return (await sharp(teil).stats()).channels[0].mean;
  }

  it('hebt ein unterbelichtetes Produkt an — heller Untergrund als Referenz', async () => {
    const foto = await fotoMit({
      grund: { r: 195, g: 195, b: 195 },
      produktTon: { r: 125, g: 125, b: 125 },
    });
    const r = await bauePackshot(foto, await maskenQuelle(), { hintergrund: 'verlauf' });
    expect(r.ok).toBe(true);
    expect(r.info.belichtung.faktoren).not.toBeNull();
    // Untergrund 195 auf ~248 → Faktor rund 1,27.
    expect(r.info.belichtung.faktoren[0]).toBeGreaterThan(1.2);
    expect(await produktTon(r.buffer)).toBeGreaterThan(140);
  });

  it('HELLT EIN WIRKLICH DUNKLES PRODUKT NICHT AUF — sonst wäre es eine Produktveränderung', async () => {
    const foto = await fotoMit({
      grund: { r: 225, g: 225, b: 225 },
      produktTon: { r: 20, g: 20, b: 20 },
    });
    const r = await bauePackshot(foto, await maskenQuelle(), { hintergrund: 'verlauf' });
    expect(r.ok).toBe(true);
    // Der Faktor richtet sich nach dem Untergrund (225 → ~1,10), nicht nach dem
    // Produkt. Ein schwarzes Gehäuse bleibt schwarz.
    expect(r.info.belichtung.faktoren[0]).toBeLessThan(1.15);
    expect(await produktTon(r.buffer)).toBeLessThan(45);
  });

  it('korrigiert NICHT vor dunklem Untergrund — das war keine Graukarte', async () => {
    const foto = await fotoMit({ grund: { r: 90, g: 90, b: 90 }, produktTon: { r: 60, g: 60, b: 60 } });
    const r = await bauePackshot(foto, await maskenQuelle(), { hintergrund: 'verlauf' });
    // Der Packshot selbst darf scheitern (Rand nicht hell) — entscheidend ist,
    // dass KEINE Korrektur aus einem untauglichen Bezug abgeleitet wurde.
    const info = r.ok ? r.info.belichtung : null;
    if (info) {
      expect(info.faktoren).toBeNull();
      expect(info.grund).toMatch(/hintergrund_zu_dunkel/);
    }
  });

  it('korrigiert NICHT vor farbigem Untergrund — ein Weissabgleich darauf färbte den Artikel um', async () => {
    const foto = await fotoMit({
      grund: { r: 230, g: 170, b: 150 },
      produktTon: { r: 120, g: 120, b: 120 },
    });
    const r = await bauePackshot(foto, await maskenQuelle(), { hintergrund: 'verlauf' });
    if (r.ok) {
      expect(r.info.belichtung.faktoren).toBeNull();
      expect(r.info.belichtung.grund).toMatch(/hintergrund_farbig/);
    }
  });

  it('deckelt die Verstaerkung — kein ausgebranntes Bild aus einem sehr dunklen Foto', async () => {
    const foto = await fotoMit({
      grund: { r: 145, g: 145, b: 145 },
      produktTon: { r: 90, g: 90, b: 90 },
    });
    const r = await bauePackshot(foto, await maskenQuelle(), { hintergrund: 'verlauf' });
    if (r.ok && r.info.belichtung.faktoren) {
      for (const f of r.info.belichtung.faktoren) expect(f).toBeLessThanOrEqual(1.6);
    }
  });
});

/**
 * FUELLUNG + SCHATTENAUFHELLUNG + KAPPEN DER DREHUNG (seit 2026-09-10).
 *
 * Betreiber am Futtereimer "Stiefel Pflanzenkohle": "es ist sogar schlechter
 * geworden … das produkt darf gerne korrekt platziert werden also nicht schief
 * und krumm und die belichtung/helligkeit darf auch verbessert werden da die
 * vorderseite in diesem fall beschattet ist."
 *
 * Am ECHTEN Bild nachgemessen, vorher -> nachher:
 *   Fuellung   78 % B / 42 % H / 28 % Flaeche  ->  92 / 49 / 45
 *   Schatten   p10 4, Median 39, p90 104       ->  p10 19, Median 65, p90 125
 *   Zielband aus drei HERSTELLER-Studiofotos desselben Eimers:
 *              p10 15-31, Median 54-64, p90 111-152
 */
describe('Fuellung und Schattenaufhellung', () => {
  async function fotoMit({ grund, produktTon, breite = 600, hoehe = 500 }) {
    const produkt = await sharp({
      create: { width: breite, height: hoehe, channels: 3, background: produktTon },
    })
      .png()
      .toBuffer();
    return sharp({ create: { width: 1000, height: 1000, channels: 3, background: grund } })
      .composite([{ input: produkt, left: Math.round((1000 - breite) / 2), top: 250 }])
      .jpeg()
      .toBuffer();
  }

  it('fuellt die Leinwand deutlich besser als die alten 78 Prozent', async () => {
    const r = await bauePackshot(await echtesFoto(), await maskenQuelle());
    expect(r.ok).toBe(true);
    // Die Breite ist bei einem breiten Artikel die bindende Richtung.
    expect(r.info.fuellungBreite).toBeGreaterThan(88);
    // Frueher waren es 28 % Flaeche — der Artikel schwamm im Weiss.
    expect(r.info.fuellungFlaeche).toBeGreaterThan(40);
  });

  it('vergroessert dabei NIE — die Leinwand richtet sich nach dem Produkt', async () => {
    const r = await bauePackshot(await echtesFoto(), await maskenQuelle());
    expect(r.info.skalierung).toBeLessThanOrEqual(1);
  });

  it('laesst dem Kontaktschatten Platz — der Rand bleibt sauber', async () => {
    // Die Rand-Wache ist fail-closed: ein angeschnittener Schatten wuerde den
    // ganzen Packshot verwerfen. Dass ok:true herauskommt, IST der Nachweis.
    const r = await bauePackshot(await echtesFoto(), await maskenQuelle());
    expect(r.ok).toBe(true);
  });

  it('oeffnet die Schatten eines unterbelichteten Artikels', async () => {
    const foto = await fotoMit({ grund: { r: 235, g: 235, b: 235 }, produktTon: { r: 22, g: 22, b: 22 } });
    const r = await bauePackshot(foto, await maskenQuelle());
    expect(r.ok).toBe(true);
    expect(r.info.schattenlift.gamma).toBeGreaterThan(1);
    expect(r.info.schattenlift.zielP10).toBe(32);
  });

  it('faehrt die Kurve NICHT, wenn die Schatten schon offen sind', async () => {
    const foto = await fotoMit({ grund: { r: 240, g: 240, b: 240 }, produktTon: { r: 120, g: 120, b: 120 } });
    const r = await bauePackshot(foto, await maskenQuelle());
    expect(r.ok).toBe(true);
    expect(r.info.schattenlift.gamma).toBeNull();
    expect(r.info.schattenlift.grund).toMatch(/schatten_bereits_offen/);
  });

  it('HAELT DEN FARBTON — eine Kurve pro Kanal wuerde Gesaettigtes ausbleichen', async () => {
    // Kraeftiges Rot, unterbelichtet. Nach der Aufhellung muss es ROT bleiben:
    // die Kanalverhaeltnisse duerfen sich nicht verschieben.
    const foto = await fotoMit({ grund: { r: 235, g: 235, b: 235 }, produktTon: { r: 90, g: 18, b: 18 } });
    const r = await bauePackshot(foto, await maskenQuelle());
    expect(r.ok).toBe(true);
    const m = await sharp(r.buffer).metadata();
    const teil = await sharp(r.buffer)
      .extract({
        left: Math.round(m.width * 0.45),
        top: Math.round(m.height * 0.4),
        width: Math.round(m.width * 0.1),
        height: Math.round(m.height * 0.1),
      })
      .removeAlpha()
      .toBuffer();
    const st = await sharp(teil).stats();
    const [rr, gg, bb] = st.channels.map((c) => c.mean);
    // Ausgangsverhaeltnis R:G war 5:1. Es darf sich nur wenig verschieben.
    expect(rr / Math.max(1, gg)).toBeGreaterThan(3.2);
    expect(Math.abs(gg - bb)).toBeLessThan(6);
  });

  it('KAPPT eine grosse Schieflage, statt sie stehen zu lassen', async () => {
    // Bis 2026-09-10 stand hier `return 0`: ein um 20 Grad gekipptes Foto blieb
    // vollstaendig schief. Jetzt wird um die Deckelung (12 Grad) aufgerichtet,
    // sofern die Silhouette den Winkel belegt.
    const { winkelMinRechteck, binarisiere, groessteKomponente, fuelleLoecher } = _internal;
    const schraeg = await sharp({
      create: { width: 1000, height: 1000, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 520, height: 260, channels: 3, background: { r: 40, g: 40, b: 40 } },
          })
            .rotate(20, { background: { r: 255, g: 255, b: 255 } })
            .png()
            .toBuffer(),
          left: 200,
          top: 300,
        },
      ])
      .png()
      .toBuffer();
    const bin = await binarisiere(schraeg);
    const gef = fuelleLoecher(groessteKomponente(bin.maske, bin.w, bin.h).maske, bin.w, bin.h);
    const w = winkelMinRechteck(gef, bin.w, bin.h);
    expect(Math.abs(w)).toBe(12);
  });

  it('kappt NICHT bei einem runden Umriss — dort ist der Winkel Rauschen', async () => {
    const { winkelMinRechteck, binarisiere, groessteKomponente, fuelleLoecher } = _internal;
    const kreis = await sharp({
      create: { width: 900, height: 900, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="900" height="900"><circle cx="450" cy="450" r="300" fill="#282828"/></svg>'
          ),
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
    const bin = await binarisiere(kreis);
    const gef = fuelleLoecher(groessteKomponente(bin.maske, bin.w, bin.h).maske, bin.w, bin.h);
    expect(Math.abs(winkelMinRechteck(gef, bin.w, bin.h))).toBeLessThan(12);
  });
});

/**
 * EIN WEISSES ETIKETT DARF DIE AUFHELLUNG NICHT KIPPEN (2026-09-10, gemessen).
 *
 * Hier stand eine "Lichter-Wache", die die Kurve zuruecknahm, sobald das obere
 * Prozent ueber 252 gelandet waere. Sie schuetzte gegen nichts — 255 ist ein
 * Fixpunkt der Gamma-Kurve, es gibt kein Clipping — und genuegte doch, um die
 * GANZE Aufhellung zu verwerfen. Betroffen waren genau die Artikel, die sie am
 * noetigsten haben: dunkles Gehaeuse, helles Etikett.
 */
describe('Lichter und Schattenaufhellung', () => {
  async function dunkelMitEtikett(etikettTon) {
    const koerper = await sharp({
      create: { width: 600, height: 400, channels: 3, background: { r: 22, g: 22, b: 22 } },
    }).png().toBuffer();
    const etikett = await sharp({
      create: { width: 300, height: 150, channels: 3, background: etikettTon },
    }).png().toBuffer();
    return sharp({ create: { width: 1000, height: 1000, channels: 3, background: { r: 238, g: 238, b: 238 } } })
      .composite([{ input: koerper, left: 200, top: 300 }, { input: etikett, left: 350, top: 420 }])
      .jpeg()
      .toBuffer();
  }
  async function koerperMaske() {
    const koerper = await sharp({
      create: { width: 600, height: 400, channels: 3, background: { r: 22, g: 22, b: 22 } },
    }).png().toBuffer();
    return sharp({ create: { width: 1000, height: 1000, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([{ input: koerper, left: 200, top: 300 }])
      .png()
      .toBuffer();
  }

  it('hellt auch dann auf, wenn ein REINWEISSES Etikett im Bild ist', async () => {
    const r = await bauePackshot(await dunkelMitEtikett({ r: 255, g: 255, b: 255 }), await koerperMaske());
    expect(r.ok).toBe(true);
    expect(r.info.schattenlift.gamma).toBeGreaterThan(1);
  });

  it('laesst Weiss dabei WEISS — die Kurve hat 255 als Fixpunkt', async () => {
    const r = await bauePackshot(await dunkelMitEtikett({ r: 255, g: 255, b: 255 }), await koerperMaske());
    const m = await sharp(r.buffer).metadata();
    const teil = await sharp(r.buffer)
      .extract({
        left: Math.round(m.width * 0.47), top: Math.round(m.height * 0.47),
        width: 40, height: 20,
      })
      .removeAlpha()
      .toBuffer();
    const st = await sharp(teil).stats();
    for (const k of st.channels.slice(0, 3)) expect(k.mean).toBeGreaterThan(250);
  });
});

describe('Irregulaere Produktform nur mit Ergebnisabnahme', () => {
  async function uForm() {
    return sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000" fill="white"/><path d="M200 200H370V580H630V200H800V800H200Z" fill="#18202a"/></svg>')).png().toBuffer();
  }
  it('behaelt die Geometriewache ohne verpflichtende Abnahme bei', async () => {
    const image = await uForm();
    const result = await bauePackshot(image, image);
    expect(result.ok).toBe(false);
    expect(result.gruende.some(g => g.startsWith('maske_nicht_kompakt'))).toBe(true);
  });
  it('liefert eine U-Form nur nach positiver Abnahme des fertigen Bildes', async () => {
    const image = await uForm();
    const reviewResult = vi.fn(async buffer => {
      expect((await sharp(buffer).metadata()).width).toBeGreaterThan(512);
      return { action: 'ok' };
    });
    const result = await bauePackshot(image, image, { reviewResult, schattenlift: false });
    expect(result.ok).toBe(true);
    expect(reviewResult).toHaveBeenCalledTimes(1);
    expect(result.info.schattenlift.gamma).toBeNull();
  });
  it.each([null, { action: 'warnen' }, { action: 'verwerfen', warnings: ['Hand im Bild'] }])('verweigert eine nicht freigegebene U-Form', async verdict => {
    const image = await uForm();
    const result = await bauePackshot(image, image, { reviewResult: async () => verdict });
    expect(result.ok).toBe(false);
    expect(result.gruende).toContain('ergebnis_nicht_bestaetigt');
  });
  it('verweigert auch bei fehlerhafter Ergebnispruefung die Ausgabe', async () => {
    const image = await uForm();
    const result = await bauePackshot(image, image, { reviewResult: async () => { throw new Error('offline'); } });
    expect(result.ok).toBe(false);
    expect(result.gruende).toContain('ergebnispruefung_fehlgeschlagen');
  });
});
