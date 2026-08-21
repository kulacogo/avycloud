'use strict';

/**
 * K-Typ direkt aus der Fahrzeugliste (MVL) statt nur ueber HSN/TSN-Belege.
 *
 * Vorfall 2026-08-21 (Airbag-Steuergeraet, SKU-7093518261, "k-typ bitte"):
 * Das K-Typ-Feld trug 5 Fahrzeuge (aus der HSN/TSN-Ernte vom 17.08.), die MVL
 * kennt fuer Audi Q7 (4M) + Q8 aber ~44. Der Chat schwieg komplett, weil
 * "ein bestehender K-Typ bleibt unangetastet" — und das Modell recherchierte
 * stattdessen nutzlose HSN/TSN-Prosa. Drei strukturelle Luecken:
 *
 * 1. Der HSN/TSN-Weg ist eine Lupe: 12 recherchierte Schluesselnummern ergeben
 *    nur 8 K-Typen. Das Teil passt aber in die GANZE Baureihe — und die steht
 *    als make+model+platform+period direkt in der MVL. Neu:
 *    resolveKTypFromVehicleSpec() liest die Fahrzeugnennung aus den EIGENEN
 *    Produktdaten (Titel, Modell/Baureihe/Baujahr-Attribute) und schlaegt sie
 *    deterministisch in der MVL nach. Kein LLM, kein Raten.
 *
 * 2. Der Plattform-Index kannte nur den ROH-String ("4MB, 4MG, 4MQ") — ein
 *    Titel-Token wie "4M" traf nie (10.711 von 55.851 MVL-Zeilen haben
 *    Komma-Plattformen). Neu: Komma-Tokens werden zusaetzlich indiziert.
 *
 * 3. Die Beleg-Ernte las nur 200 Zeichen ab Stichwort — von 12 aufgelisteten
 *    Schluesselnummern kamen 8 an. Neu: gefundene Paare verlaengern das
 *    Lesefenster (Ketten-Logik), Listen werden vollstaendig gelesen.
 *
 * No-Guessing-Leitplanken (nicht verhandelbar):
 * - Modell-Treffer allein reicht NIE. Ohne Generations-Beleg (Plattform-Token
 *   ODER Bauzeitraum-Ueberlappung) wird NICHTS geschrieben — sonst bekaeme ein
 *   4M-Teil auch das alte Q7 (4LB, bis 2015) zugeschrieben.
 * - "Q8" (Verbrenner) und "Q8 E-Tron ..." sind VERSCHIEDENE Modelle; der
 *   laengste Modellname gewinnt an seiner Textposition.
 * - Ein bestehender K-Typ wird nur ERWEITERT (Union), nie gekuerzt/ersetzt.
 */

const {
  buildMvlIndexFromRecords,
  resolveKTypFromVehicleSpec,
  extractHsnTsnFromEvidenceText,
  enrichKTypFromHsnTsnEvidence,
  enrichKTypIfPossible,
  resolveKTypForChatTurn,
  isKTypIntentMessage,
  buildKTypDatasheetChange,
} = require('../lib/ktype-enrichment');

/** Datensaetze in ECHTER MVL-Compact-Form — derselbe Index-Bauer wie Produktion. */
function fixtureIndex() {
  return buildMvlIndexFromRecords([
    { k: 101, make: 'Audi', model: 'Q7', type: '3.0 TDI', platform: '4LB', period: '2010/11-2015/08', hsn_tsn: '0588|ALT' },
    { k: 102, make: 'Audi', model: 'Q7', type: '45 TDI', platform: '4MB, 4MG, 4MQ', period: '2015/01-2019/12', hsn_tsn: '0588|BDM' },
    { k: 103, make: 'Audi', model: 'Q7', type: '50 TDI', platform: '4MB, 4MG', period: '2018/07-2019/12', hsn_tsn: '' },
    { k: 104, make: 'Audi', model: 'Q8', type: '50 TDI', platform: '4MN, 4MT', period: '2018/07-2026/12', hsn_tsn: '' },
    { k: 105, make: 'Audi', model: 'Q8 E-Tron SUV', type: '55', platform: 'GET', period: '2022/11-2026/12', hsn_tsn: '' },
    { k: 106, make: 'BMW', model: 'X5', type: '3.0d', platform: 'E70', period: '2006/10-2013/06', hsn_tsn: '' },
    { k: 107, make: 'Peugeot', model: '205', type: '1.6', platform: '741A/C', period: '1983/02-1998/12', hsn_tsn: '' },
    { k: 108, make: 'VW', model: 'Golf', type: '1.9 TDI', platform: '1K1', period: '2003/10-2008/11', hsn_tsn: '' },
    { k: 109, make: 'VW', model: 'Golf', type: '1.6', platform: '5K1', period: '2008/10-2012/11', hsn_tsn: '' },
    { k: 110, make: 'Ford', model: 'GT', type: '5.4 V8', platform: '--', period: '2004/01-2006/12', hsn_tsn: '' },
    { k: 111, make: 'Ford', model: 'Fiesta V', type: '1.3', platform: 'JH1, JD3', period: '2003/01-2008/12', hsn_tsn: '' },
  ]);
}

/** Der reale Fall: Airbag-Steuergeraet fuer Audi Q7 (4M) und Q8. */
function airbagProduct(extraAttrs = {}) {
  return {
    id: 'p-air',
    identification: {
      name: 'Original Continental Airbag Steuergerät 4M0959655J für Audi Q7 4M & Q8 SRS Modul',
      brand: 'Audi',
    },
    details: {
      categoryId: '177711',
      attributes: {
        Herstellernummer: '4M0 959 655 J',
        Modell: 'Q7',
        Fahrzeugmarke: 'Audi',
        Baureihe: '4M',
        Baujahr: '2016-2025',
        ...extraAttrs,
      },
    },
  };
}

describe('MVL-Index: Komma-Plattformen und Modell-Zugriff', () => {
  it('indiziert jeden Komma-Token der Plattform zusaetzlich zum Roh-String', () => {
    const idx = fixtureIndex();
    expect(idx.byMakePlatform.has('audi|4MB, 4MG, 4MQ')).toBe(true); // bisheriges Verhalten bleibt
    expect(Array.from(idx.byMakePlatform.get('audi|4MB'))).toContain(102);
    expect(Array.from(idx.byMakePlatform.get('audi|4MG'))).toEqual(expect.arrayContaining([102, 103]));
  });

  it('baut den Modell-Index je Marke auf', () => {
    const idx = fixtureIndex();
    expect(idx.byMakeModel.get('audi|Q7').map((r) => r.k).sort()).toEqual([101, 102, 103]);
    expect(idx.byMakeModel.get('audi|Q8').map((r) => r.k)).toEqual([104]);
    // E-Tron ist ein EIGENES Modell, kein Q8-Untereintrag.
    expect(idx.byMakeModel.has('audi|Q8 E TRON SUV')).toBe(true);
  });
});

describe('resolveKTypFromVehicleSpec — Fahrzeugnennung deterministisch nachschlagen', () => {
  it('findet die ganze 4M-Baureihe fuer den Airbag-Fall (Q7 4M + Q8), ohne Altgeneration und ohne E-Tron', () => {
    const res = resolveKTypFromVehicleSpec(airbagProduct(), { mvl: fixtureIndex() });
    expect(res.ok).toBe(true);
    expect(res.ids).toEqual([102, 103, 104]);
    // 101 (4LB, alte Generation) und 105 (E-Tron) duerfen NIE dabei sein.
    expect(res.ids).not.toContain(101);
    expect(res.ids).not.toContain(105);
  });

  it('schreibt NICHTS ohne Generations-Beleg (mehrgenerationiges Modell, kein Plattform-Token, kein Baujahr)', () => {
    const product = {
      id: 'p-golf',
      identification: { name: 'Außenspiegel für VW Golf links' },
      details: { categoryId: '177711', attributes: {} },
    };
    const res = resolveKTypFromVehicleSpec(product, { mvl: fixtureIndex() });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('vehicle_generation_unresolved');
  });

  it('Baujahr-Ueberlappung genuegt als Generations-Beleg', () => {
    const product = {
      id: 'p-golf2',
      identification: { name: 'Außenspiegel für VW Golf links' },
      details: { categoryId: '177711', attributes: { Baujahr: '2010-2011' } },
    };
    const res = resolveKTypFromVehicleSpec(product, { mvl: fixtureIndex() });
    expect(res.ok).toBe(true);
    expect(res.ids).toEqual([109]); // nur Golf VI (5K1, 2008-2012), nicht Golf V
  });

  it('ohne Markennennung passiert nichts', () => {
    const product = {
      id: 'p-nomake',
      identification: { name: 'Steuergerät Q7 4M universal' },
      details: { categoryId: '177711', attributes: {} },
    };
    const res = resolveKTypFromVehicleSpec(product, { mvl: fixtureIndex() });
    expect(res.ok).toBe(false);
  });

  it('reine Ziffern-Modelle brauchen die Marke direkt davor (Masse sind keine Modelle)', () => {
    // "205 mm" ist ein Mass; Peugeot steht vor der 306, nicht vor der 205.
    const trap = {
      id: 'p-trap',
      identification: { name: 'Bremsscheibe 205 mm für Peugeot 306 Baujahr 1995' },
      details: { categoryId: '177711', attributes: {} },
    };
    expect(resolveKTypFromVehicleSpec(trap, { mvl: fixtureIndex() }).ok).toBe(false);

    const legit = {
      id: 'p-205',
      identification: { name: 'Zierleiste für Peugeot 205 Baujahr 1990' },
      details: { categoryId: '177711', attributes: {} },
    };
    const res = resolveKTypFromVehicleSpec(legit, { mvl: fixtureIndex() });
    expect(res.ok).toBe(true);
    expect(res.ids).toEqual([107]);
  });

  it('laeuft nur in Fahrzeug-Kategorien', () => {
    const product = airbagProduct();
    product.details.categoryId = '11450'; // Bekleidung
    expect(resolveKTypFromVehicleSpec(product, { mvl: fixtureIndex() }).ok).toBe(false);
  });

  it('Kurz-Modelle ("GT") zaehlen nur verankert — Ausstattungs-Kuerzel sind keine Modelle', () => {
    // Dry-Run 2026-08-21: drei Fiesta-Produkte matchten "Ford GT" (den
    // Supersportwagen), weil "GT" als Ausstattungs-Token im Titel stand.
    const fiesta = {
      id: 'p-fiesta',
      identification: { name: 'Zierleiste für Ford Fiesta V GT Optik Baujahr 2005' },
      details: { categoryId: '177711', attributes: {} },
    };
    const res = resolveKTypFromVehicleSpec(fiesta, { mvl: fixtureIndex() });
    expect(res.ok).toBe(true);
    expect(res.ids).toEqual([111]); // Fiesta V ja, Ford GT (110) NIEMALS

    // Der echte Ford GT steht direkt hinter der Marke — der zaehlt.
    const gt = {
      id: 'p-gt',
      identification: { name: 'Heckspoiler für Ford GT Baujahr 2005' },
      details: { categoryId: '177711', attributes: {} },
    };
    expect(resolveKTypFromVehicleSpec(gt, { mvl: fixtureIndex() }).ids).toEqual([110]);

    // Oder er steht ausdruecklich im Modell-Attribut.
    const gtAttr = {
      id: 'p-gt-attr',
      identification: { name: 'Heckspoiler Baujahr 2005' },
      details: { categoryId: '177711', attributes: { Fahrzeugmarke: 'Ford', Modell: 'GT' } },
    };
    expect(resolveKTypFromVehicleSpec(gtAttr, { mvl: fixtureIndex() }).ids).toEqual([110]);
  });
});

describe('Adversarial-Review 2026-08-21 — Falschdaten-Faelle (an echter MVL-Struktur verifiziert)', () => {
  /**
   * Realitaets-Muster der MVL: das nackte "Golf" ist ein Suedamerika-Exot
   * (9B3), die Generationen sind EIGENE Modelle mit ROEMISCHEN Ziffern.
   * Ducato-Modelle sind alle mehrteilig; "500" ist ein echtes Fiat-Modell.
   */
  function realityIndex() {
    return buildMvlIndexFromRecords([
      { k: 201, make: 'VW', model: 'Golf', type: '1.6', platform: '9B3', period: '2007/03-2014/03', hsn_tsn: '' },
      { k: 202, make: 'VW', model: 'Golf VII', type: '2.0 TDI', platform: '5G1, BQ1', period: '2012/08-2020/03', hsn_tsn: '' },
      { k: 203, make: 'Fiat', model: '500', type: '1.2', platform: '312', period: '2007/07-2025/12', hsn_tsn: '' },
      { k: 204, make: 'Fiat', model: 'Ducato Kasten', type: '2.3 D', platform: '250, 290', period: '2006/07-2025/12', hsn_tsn: '' },
      { k: 205, make: 'Audi', model: 'A4', type: '2.0 TDI', platform: '8EC', period: '2004/11-2008/06', hsn_tsn: '' },
      { k: 206, make: 'Audi', model: 'A4', type: '2.0 TDI', platform: '8K2', period: '2007/11-2015/12', hsn_tsn: '' },
      { k: 207, make: 'Audi', model: 'A4', type: '2.0 TDI', platform: '8W2', period: '2015/05-2025/12', hsn_tsn: '' },
    ]);
  }

  it('"Golf 7" (arabische Ziffer) trifft Golf VII — NIE den Suedamerika-Golf', () => {
    const product = {
      id: 'p-golf7',
      identification: { name: 'Außenspiegel links für VW Golf 7 Bj. 2013-2019' },
      details: { categoryId: '177711', attributes: {} },
    };
    const res = resolveKTypFromVehicleSpec(product, { mvl: realityIndex() });
    expect(res.ok).toBe(true);
    expect(res.ids).toEqual([202]);
    expect(res.ids).not.toContain(201); // 9B3-Exot
  });

  it('nacktes "Golf" mit Generations-Geschwistern: Baujahr allein reicht NICHT', () => {
    const product = {
      id: 'p-golf-bare',
      identification: { name: 'Fußmatten für VW Golf Bj. 2013' },
      details: { categoryId: '177711', attributes: {} },
    };
    const res = resolveKTypFromVehicleSpec(product, { mvl: realityIndex() });
    expect(res.ok).toBe(false); // sonst kaeme der 9B3-Exot ueber die Jahresgrenze
  });

  it('"Fiat Ducato 500 kg" wird NIE zum Fiat 500 (Einheiten-Veto + Marken-Sequenz-Anker)', () => {
    const product = {
      id: 'p-ducato',
      identification: { name: 'Anhängerkupplung für Fiat Ducato 500 kg Stützlast' },
      details: { categoryId: '177711', attributes: { Baujahr: '2015-2020' } },
    };
    const res = resolveKTypFromVehicleSpec(product, { mvl: realityIndex() });
    expect(res.ok).toBe(false);
  });

  it('widersprechender Plattform-Token ("A4 B8", MVL kennt nur Werkscodes) vetot statt Jahres-Fallback', () => {
    // Sonst zoege die Jahresgrenze 2008/2015 die Nachbargenerationen B7+B9 rein.
    const product = {
      id: 'p-a4b8',
      identification: { name: 'Bremsscheiben Set für Audi A4 B8 Bj. 2008-2015' },
      details: { categoryId: '177711', attributes: {} },
    };
    const res = resolveKTypFromVehicleSpec(product, { mvl: realityIndex() });
    expect(res.ok).toBe(false);
  });

  it('Werkscode im Titel trifft exakt die richtige Generation', () => {
    const product = {
      id: 'p-a4-8k2',
      identification: { name: 'Bremsscheiben Set für Audi A4 8K2 Bj. 2008-2015' },
      details: { categoryId: '177711', attributes: {} },
    };
    const res = resolveKTypFromVehicleSpec(product, { mvl: realityIndex() });
    expect(res.ok).toBe(true);
    expect(res.ids).toEqual([206]);
  });

  it('Index: reine Buchstaben-Fragmente aus Komma-Plattformen werden KEINE Lookup-Schluessel', () => {
    const idx = buildMvlIndexFromRecords([
      { k: 300, make: 'Test', model: 'Alpha', type: 'x', platform: '1A2, KBA, PS', period: '2010/01-2020/12', hsn_tsn: '' },
    ]);
    expect(idx.byMakePlatform.has('test|1A2')).toBe(true);
    expect(idx.byMakePlatform.has('test|KBA')).toBe(false);
    expect(idx.byMakePlatform.has('test|PS')).toBe(false);
    expect(idx.byMakePlatform.has('test|1A2, KBA, PS')).toBe(true); // Roh-String bleibt
  });

  it('"Modellnummer" ist Teilenummern-, kein Fahrzeugtext', () => {
    const product = {
      id: 'p-modellnr',
      identification: { name: 'Steuergerät universal' },
      details: {
        categoryId: '177711',
        // Ohne Ausschluss wuerde "1987" aus der Modellnummer als Baujahr gelten.
        attributes: { Fahrzeugmarke: 'VW', Modellnummer: '1987 Golf 429' },
      },
    };
    const res = resolveKTypFromVehicleSpec(product, { mvl: realityIndex() });
    expect(res.ok).toBe(false);
  });
});

describe('Beleg-Ernte liest LISTEN vollstaendig (Ketten-Fenster)', () => {
  it('liest alle 12 Schluesselnummern der Screenshot-Antwort vom 21.08. (vorher: 8)', () => {
    const text = [
      'Basierend auf den von Ihnen bereitgestellten Informationen und einer Webrecherche habe ich die',
      'folgenden K-Typ Nummern (HSN/TSN) für die passenden Fahrzeuge Audi Q7 (4M) und Audi Q8 gefunden.',
      '',
      '**Audi Q7 (Baureihe 4M, ab 2015):**',
      '* **0588/BDM**',
      '* **0588/BDQ**',
      '* **0588/BNJ**',
      '* **0588/BNK**',
      '* **0588/BRC**',
      '',
      '**Audi Q8 (ab 2018):**',
      '* **0588/BNL**',
      '* **0588/BNM**',
      '* **0588/BPQ**',
      '* **0588/BPR**',
      '* **0588/BPV**',
      '* **0588/BXJ**',
      '* **0588/BXK**',
    ].join('\n');
    const pairs = extractHsnTsnFromEvidenceText(text);
    expect(pairs).toHaveLength(12);
    expect(pairs).toEqual(
      expect.arrayContaining(['0588|BDM', '0588|BPV', '0588|BXJ', '0588|BXK'])
    );
  });

  it('die Kette endet am Teilenummern-Etikett — Vergleichsnummern sind keine Schluesselnummern', () => {
    // Review-Befund 2026-08-21: ohne Abbruch frisst sich die Reichweiten-Kette
    // durch die ganze Teilenummern-Liste. Und "Vergleichsnummern" (Plural)
    // matchte das Label-Regex vorher NIE.
    const text = 'HSN/TSN: 0588/BDM. Vergleichsnummern: 1234/ABC, 5678/DEF, 9012/GHI';
    expect(extractHsnTsnFromEvidenceText(text)).toEqual(['0588|BDM']);
  });

  it('die Kette bricht ab, wenn die Liste endet (kein Freibrief fuer den Resttext)', () => {
    const text =
      'HSN/TSN: 0588/BDM.\n' +
      `${'Fließtext ohne Schlüsselnummern. '.repeat(20)}\n` +
      'Vergleichsnummer: 1234/ABC';
    expect(extractHsnTsnFromEvidenceText(text)).toEqual(['0588|BDM']);
  });
});

describe('enrichKTypFromHsnTsnEvidence — Erweitern statt Schweigen', () => {
  const mvl = fixtureIndex();

  it('erweitert einen bestehenden K-Typ durch ANHAENGEN (extendExisting)', async () => {
    const product = airbagProduct({ 'K-Typ': '113153|132151' });
    const res = await enrichKTypFromHsnTsnEvidence(product, ['0588|BDM'], {
      mvl,
      extendExisting: true,
    });
    expect(res.ok).toBe(true);
    expect(product.details.attributes['K-Typ']).toBe('113153|132151|102');
  });

  it('erhaelt Notizen im Bestand VERBATIM — K-Typ darf `<id>,<note>` tragen', async () => {
    // Review-Befund 2026-08-21: ein Union-Rewrite ueber geparste Zahlen haette
    // die Notiz "Audi Q7 III" still geloescht (Datenverlust-Klasse Punkt 16).
    const product = airbagProduct({ 'K-Typ': '113153,Audi Q7 III|132151' });
    const res = await enrichKTypFromHsnTsnEvidence(product, ['0588|BDM'], {
      mvl,
      extendExisting: true,
    });
    expect(res.ok).toBe(true);
    expect(product.details.attributes['K-Typ']).toBe('113153,Audi Q7 III|132151|102');
  });

  it('meldet no_new_ids, wenn der Beleg nichts Neues bringt', async () => {
    const product = airbagProduct({ 'K-Typ': '102' });
    const res = await enrichKTypFromHsnTsnEvidence(product, ['0588|BDM'], {
      mvl,
      extendExisting: true,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no_new_ids');
    expect(product.details.attributes['K-Typ']).toBe('102');
  });

  it('Default-Verhalten unveraendert: bestehender K-Typ bleibt unangetastet', async () => {
    const product = airbagProduct({ 'K-Typ': '1234' });
    const res = await enrichKTypFromHsnTsnEvidence(product, ['0588|BDM'], { mvl });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('already_has_ktype');
    expect(product.details.attributes['K-Typ']).toBe('1234');
  });
});

describe('enrichKTypIfPossible — Fahrzeugnennung als Fast-Path (auch ohne MPN)', () => {
  it('fuellt aus den eigenen Produktdaten, bevor der Web-Wasserfall startet', async () => {
    const product = airbagProduct();
    delete product.details.attributes.Herstellernummer; // kein MPN — frueher: sofort missing_part_number
    const res = await enrichKTypIfPossible(product, { reason: 'identify', mvl: fixtureIndex() });
    expect(res.ok).toBe(true);
    expect(product.details.attributes['K-Typ']).toBe('102|103|104');
    expect(product.ops.data_quality.ktype_enrich_v1.source).toBe('local_vehicle_model');
  });
});

describe('isKTypIntentMessage — erkennt die K-Typ-Frage', () => {
  it('erkennt uebliche Formulierungen', () => {
    expect(isKTypIntentMessage('k-typ bitte')).toBe(true);
    expect(isKTypIntentMessage('K-Typ ermitteln')).toBe(true);
    expect(isKTypIntentMessage('bitte die KTyp Liste füllen')).toBe(true);
    expect(isKTypIntentMessage('Fahrzeugverwendungsliste ergänzen')).toBe(true);
  });

  it('schlaegt bei anderen Fragen NICHT an', () => {
    expect(isKTypIntentMessage('Welcher Typ Stecker ist das?')).toBe(false);
    expect(isKTypIntentMessage('Preis prüfen bitte')).toBe(false);
    expect(isKTypIntentMessage('das ist ganz k typisch für den Preis')).toBe(false);
    expect(isKTypIntentMessage('')).toBe(false);
  });
});

describe('resolveKTypForChatTurn — der Chat-Weg, der den Vorfall behebt', () => {
  it('erweitert einen gefuellten K-Typ, wenn der Bediener danach fragt (der 21.08.-Fall)', async () => {
    const product = airbagProduct({ 'K-Typ': '113153|132151' });
    const chatResult = { message: 'Recherche: HSN/TSN 0588/BDM für Audi Q7 (4M).' };
    const res = await resolveKTypForChatTurn(product, chatResult, {
      userMessage: 'k-typ bitte',
      mvl: fixtureIndex(),
    });
    expect(res.intent).toBe(true);
    expect(res.addedCount).toBeGreaterThan(0);
    const now = product.details.attributes['K-Typ'].split('|');
    // Bestand bleibt, Baureihe kommt dazu.
    expect(now).toEqual(expect.arrayContaining(['113153', '132151', '102', '103', '104']));
  });

  it('sagt ehrlich "bereits gesetzt", wenn nichts Neues belegbar ist', async () => {
    const product = airbagProduct({ 'K-Typ': '102|103|104' });
    const chatResult = { message: 'Keine neuen Erkenntnisse.' };
    const res = await resolveKTypForChatTurn(product, chatResult, {
      userMessage: 'k-typ bitte',
      mvl: fixtureIndex(),
    });
    expect(res.addedCount).toBe(0);
    expect(res.status).toBe('already_set');
    expect(product.details.attributes['K-Typ']).toBe('102|103|104');
  });

  it('fuellt ein leeres Feld auch OHNE K-Typ-Frage (bisheriges Verhalten bleibt)', async () => {
    const product = airbagProduct();
    const chatResult = { message: 'Schlüsselnummern (HSN/TSN): 0588/BDM.' };
    const res = await resolveKTypForChatTurn(product, chatResult, {
      userMessage: 'optimier mal alles',
      mvl: fixtureIndex(),
    });
    expect(res.intent).toBe(false);
    expect(product.details.attributes['K-Typ']).toBeTruthy();
  });

  it('ruehrt einen gefuellten K-Typ NICHT an, wenn niemand danach gefragt hat', async () => {
    const product = airbagProduct({ 'K-Typ': '113153' });
    const chatResult = { message: 'Schlüsselnummern (HSN/TSN): 0588/BDM.' };
    await resolveKTypForChatTurn(product, chatResult, {
      userMessage: 'beschreibung verbessern',
      mvl: fixtureIndex(),
    });
    expect(product.details.attributes['K-Typ']).toBe('113153');
  });
});

describe('buildKTypDatasheetChange — Karte erklaert die Erweiterung', () => {
  it('nennt bei Erweiterung die Zahl der NEUEN Fahrzeuge', async () => {
    const product = airbagProduct({ 'K-Typ': '113153|132151' });
    await resolveKTypForChatTurn(product, { message: '' }, {
      userMessage: 'k-typ bitte',
      mvl: fixtureIndex(),
    });
    const change = buildKTypDatasheetChange(product, { beforeValue: '113153|132151' });
    expect(change).toBeTruthy();
    expect(change.attributes['K-Typ']).toContain('113153');
    expect(change.summary).toMatch(/erweitert/i);
    expect(change.summary).toMatch(/\+3/);
  });
});
