'use strict';

/**
 * VORFALL 2026-09-03 — Produkt 371fce64 (SKU-1698488489, Marke "BBQ-Toro").
 *
 * Der Chat recherchierte am 03.09.2026 um 20:15 UTC die RICHTIGEN
 * Herstellerangaben und schrieb sie ins Datenblatt. 400 Millisekunden später,
 * im selben Speichervorgang, überschrieb der Registry-Enforce-Block in
 * `lib/firestore.js` sie wieder — belegt durch `ops.data_quality.gpsr_backup_v1`
 * am echten Produkt:
 *
 *   before: CS-Trading GmbH & Co. KG · Moselweinstraße 55 · 54472 Brauneberg
 *           · Rheinland-Pfalz · +4965349487986 · Germany/DE      <- richtig
 *   after:  BBQ-Toro · Moselweinstrasse 55 · 73230 Kirchheim unter Teck
 *           · "D-54472 Brauneburg" · +4970219989130 · China/CN   <- Schrott
 *
 * Quelle des Schrotts: `gpsrManufacturers/bbq-toro` (confidence 0.5, sources
 * ["https://www.ebay.com/itm/382755377149",
 *  "https://www.google.co.in/intl/de/about/products?tab=wh"]).
 * Der Eintrag ist in sich widersprüchlich: deutsche Telefonnummer, deutsche
 * Domain, deutsche E-Mail, ZWEI verschiedene Postleitzahlen (73230 im PLZ-Feld,
 * 54472 im Bundesland-Feld) — und als Sitzland "China".
 *
 * Acht Minuten später schrieb ein manueller Save den bereits verdorbenen Block
 * mit `overwrite: true` in die Registry ZURÜCK (gpsr_registry_upsert_v1,
 * sources_count 0). Damit heilt die Verschmierung sich selbst — und der
 * LESE-Pfad (`lib/firestore.js` getProduct) legt sie bei jedem Laden erneut
 * über das Produkt, weshalb jede Korrektur wirkungslos erscheint.
 *
 * Die bestehenden Sperren greifen hier bauartbedingt NICHT:
 *   - `isPlaceholderBrand('BBQ-Toro')` → false (echte Marke)
 *   - `isEnforceableRegistryEntry(...)` → true (irgendein Beleg genügt; eine
 *     Google-Produktübersichtsseite zählt als "Quelle")
 *
 * Dieser Test hält die dritte, fehlende Sperre fest.
 */

const {
  countryHintsFromGpsr,
  findGpsrInconsistencies,
  isInternallyConsistentGpsr,
  registryEnforceLevel,
  planRegistryEnforce,
  MANUFACTURER_ADDRESS_KEYS,
} = require('../lib/gpsr-enforce-guard');

// ---------------------------------------------------------------------------
// Echte Produktionsdaten (read-only gemessen am 03.09.2026)
// ---------------------------------------------------------------------------

const REGISTRY_BBQ_TORO = {
  key: 'bbq-toro',
  manufacturer_name: 'BBQ-Toro',
  confidence: 0.5,
  sources: [
    'https://www.ebay.com/itm/382755377149',
    'https://www.google.co.in/intl/de/about/products?tab=wh',
  ],
  gpsr: {
    entity_country: 'China',
    country_code: 'CN',
    manufacturer_name: 'BBQ-Toro',
    manufacturer_address: 'Moselweinstrasse 55',
    manufacturer_city: 'Kirchheim unter Teck',
    manufacturer_postalcode: '73230',
    manufacturer_state_province: 'D-54472 Brauneburg',
    manufacturer_phone: '+4970219989130',
    email: 'verkauf@cs-trading.de',
    url: 'www.bbq-toro.de',
    eu_responsible_name: 'Geaplan GmbH',
    eu_responsible_address: 'Gewerbestraße 5',
    eu_responsible_city: 'Wallenhorst',
    eu_responsible_postalcode: '49134',
    eu_responsible_state_province: 'Niedersachsen',
    eu_responsible_country: 'Deutschland',
    eu_responsible_country_code: 'DE',
    eu_responsible_email: 'info@geaplan.de',
    eu_responsible_phone: '+49540781770',
  },
};

// Das, was der Chat recherchiert und ins Datenblatt geschrieben hatte.
const PRODUKT_GPSR_RICHTIG = {
  entity_country: 'Germany',
  country_code: 'DE',
  manufacturer_name: 'CS-Trading GmbH & Co. KG',
  manufacturer_address: 'Moselweinstraße 55',
  manufacturer_city: 'Brauneberg',
  manufacturer_postalcode: '54472',
  manufacturer_state_province: 'Rheinland-Pfalz',
  manufacturer_phone: '+4965349487986',
  email: 'verkauf@cs-trading.de',
  url: 'https://bbq-toro.de',
};

// Ein sauberer, belegter Eintrag — der Enforce MUSS hier weiter funktionieren.
const REGISTRY_SAUBER = {
  key: 'cs-trading-gmbh-and-co-kg',
  manufacturer_name: 'CS-Trading GmbH & Co. KG',
  confidence: 0.95,
  sources: ['https://www.cs-trading.de/impressum'],
  gpsr: {
    entity_country: 'Germany',
    country_code: 'DE',
    manufacturer_name: 'CS-Trading GmbH & Co. KG',
    manufacturer_address: 'Moselweinstraße 55',
    manufacturer_city: 'Brauneberg',
    manufacturer_postalcode: '54472',
    manufacturer_state_province: 'Rheinland-Pfalz',
    manufacturer_phone: '+4965349487986',
    email: 'verkauf@cs-trading.de',
    url: 'https://bbq-toro.de',
  },
};

// ---------------------------------------------------------------------------

describe('countryHintsFromGpsr', () => {
  it('liest DE aus Telefonvorwahl, Domain, E-Mail und Bundesland-Feld', () => {
    const hints = countryHintsFromGpsr(REGISTRY_BBQ_TORO.gpsr);
    expect(hints.codes).toContain('DE');
    expect(hints.codes).toHaveLength(1);
    expect(hints.strong).toBeGreaterThanOrEqual(1);
    expect(hints.total).toBeGreaterThanOrEqual(2);
  });

  it('bestaetigt einen echten chinesischen Hersteller ohne Falschmeldung', () => {
    const hints = countryHintsFromGpsr({
      entity_country: 'China',
      country_code: 'CN',
      manufacturer_name: 'Shenzhen Fideco Technology Co., Ltd.',
      manufacturer_address: 'Bao An District',
      manufacturer_city: 'Shenzhen',
      manufacturer_phone: '+8675512345678',
      email: 'service@fideco.cn',
    });
    expect(hints.codes).toEqual(['CN']);
  });

  it('liefert nichts, wenn es nichts zu erkennen gibt', () => {
    expect(countryHintsFromGpsr({ manufacturer_name: 'Acme' }).codes).toEqual([]);
    expect(countryHintsFromGpsr(null).codes).toEqual([]);
  });
});

describe('findGpsrInconsistencies — der echte BBQ-Toro-Eintrag', () => {
  it('erkennt das Sitzland als widersprüchlich zur Anschrift', () => {
    const probleme = findGpsrInconsistencies(REGISTRY_BBQ_TORO.gpsr);
    expect(probleme.map((p) => p.art)).toContain('land_widerspricht_anschrift');
  });

  it('erkennt die zweite, abweichende Postleitzahl im Bundesland-Feld', () => {
    const probleme = findGpsrInconsistencies(REGISTRY_BBQ_TORO.gpsr);
    const plz = probleme.find((p) => p.art === 'zwei_postleitzahlen');
    expect(plz).toBeTruthy();
    expect(plz.details).toContain('73230');
    expect(plz.details).toContain('54472');
  });

  it('haelt den Eintrag insgesamt fuer unbrauchbar', () => {
    expect(isInternallyConsistentGpsr(REGISTRY_BBQ_TORO.gpsr)).toBe(false);
  });

  it('laesst saubere Eintraege in Ruhe', () => {
    expect(findGpsrInconsistencies(REGISTRY_SAUBER.gpsr)).toEqual([]);
    expect(isInternallyConsistentGpsr(REGISTRY_SAUBER.gpsr)).toBe(true);
    expect(isInternallyConsistentGpsr(PRODUKT_GPSR_RICHTIG)).toBe(true);
  });

  it('meldet nichts bei duenner Datenlage (fail-open, kein Rateschluss)', () => {
    expect(findGpsrInconsistencies({ manufacturer_name: 'Acme', entity_country: 'China' })).toEqual([]);
    expect(isInternallyConsistentGpsr({})).toBe(true);
  });
});

describe('registryEnforceLevel — wie scharf darf ein Eintrag wirken?', () => {
  it('verwirft den widersprüchlichen BBQ-Toro-Eintrag komplett', () => {
    const level = registryEnforceLevel(REGISTRY_BBQ_TORO);
    expect(level.level).toBe('reject');
    expect(level.grund).toBe('inkonsistent');
  });

  it('laesst einen belegten, sauberen Eintrag ueberschreiben', () => {
    expect(registryEnforceLevel(REGISTRY_SAUBER).level).toBe('overwrite');
  });

  it('degradiert schwach belegte, aber konsistente Eintraege auf reines Fuellen', () => {
    const schwach = { ...REGISTRY_SAUBER, confidence: 0.5, sources: ['https://example.com'] };
    expect(registryEnforceLevel(schwach).level).toBe('fill');
  });

  it('verwirft Eintraege ganz ohne Beleg (Spiegel von isEnforceableRegistryEntry)', () => {
    const ohne = { ...REGISTRY_SAUBER, confidence: 0, sources: [] };
    expect(registryEnforceLevel(ohne).level).toBe('reject');
  });

  it('zaehlt eine Suchmaschinen-/Portalseite nicht als Beleg', () => {
    const junk = {
      ...REGISTRY_SAUBER,
      confidence: 0,
      sources: ['https://www.google.co.in/intl/de/about/products?tab=wh'],
    };
    expect(registryEnforceLevel(junk).level).toBe('reject');
  });
});

describe('planRegistryEnforce — der Vorfall darf sich nicht wiederholen', () => {
  it('laesst die richtigen Chat-Daten stehen (Kern des Vorfalls)', () => {
    const plan = planRegistryEnforce({
      productGpsr: PRODUKT_GPSR_RICHTIG,
      registry: REGISTRY_BBQ_TORO,
      brand: 'BBQ-Toro',
    });
    expect(plan.apply).toEqual({});
    expect(plan.blocked).toBe(true);
    // Nichts aus dem Schrott-Eintrag darf ankommen:
    for (const k of Object.keys(REGISTRY_BBQ_TORO.gpsr)) {
      expect(plan.apply[k]).toBeUndefined();
    }
  });

  it('haengt die fremde Firma Geaplan nicht an einen EU-Hersteller', () => {
    const konsistenterEintragMitFremdemEuVertreter = {
      key: 'cs-trading-gmbh-and-co-kg',
      manufacturer_name: 'CS-Trading GmbH & Co. KG',
      confidence: 0.95,
      sources: ['https://www.cs-trading.de/impressum'],
      gpsr: {
        ...REGISTRY_SAUBER.gpsr,
        eu_responsible_name: 'Geaplan GmbH',
        eu_responsible_city: 'Wallenhorst',
        eu_responsible_email: 'info@geaplan.de',
      },
    };
    const plan = planRegistryEnforce({
      productGpsr: PRODUKT_GPSR_RICHTIG,
      registry: konsistenterEintragMitFremdemEuVertreter,
      brand: 'BBQ-Toro',
    });
    expect(plan.apply.eu_responsible_name).toBeUndefined();
    expect(plan.apply.eu_responsible_email).toBeUndefined();
    expect(plan.reasons).toContain('eu_vertreter_bei_eu_hersteller_uebersprungen');
  });

  it('ersetzt einen echten Herstellernamen nie durch die Marke', () => {
    const markeAlsHersteller = {
      key: 'weber',
      manufacturer_name: 'Weber',
      confidence: 1,
      sources: ['https://www.weber.com/DE/de/impressum.html'],
      gpsr: {
        entity_country: 'Germany',
        country_code: 'DE',
        manufacturer_name: 'Weber',
        manufacturer_address: 'Rheinstraße 194',
        manufacturer_city: 'Ingelheim',
        manufacturer_postalcode: '55218',
        manufacturer_phone: '+4906132123456',
        email: 'info@weberstephen.de',
      },
    };
    const plan = planRegistryEnforce({
      productGpsr: {
        manufacturer_name: 'Weber-Stephen Deutschland GmbH',
        manufacturer_city: 'Ingelheim (am Rhein)',
        country_code: 'DE',
        entity_country: 'Germany',
      },
      registry: markeAlsHersteller,
      brand: 'Weber',
    });
    expect(plan.apply.manufacturer_name).toBeUndefined();
    expect(plan.reasons).toContain('markenname_als_hersteller_verworfen');
  });

  it('behandelt die Anschrift als EINE Einheit — nie feldweise gemischt', () => {
    // Registry kennt nur Ort+PLZ, keine Straße: dann darf NICHTS aus der
    // Anschrift übernommen werden, sonst entsteht genau die Chimäre.
    const halbeAnschrift = {
      key: 'acme',
      manufacturer_name: 'Acme GmbH',
      confidence: 0.95,
      sources: ['https://acme.de/impressum'],
      gpsr: {
        manufacturer_name: 'Acme GmbH',
        manufacturer_city: 'Kirchheim unter Teck',
        manufacturer_postalcode: '73230',
        entity_country: 'Germany',
        country_code: 'DE',
      },
    };
    const plan = planRegistryEnforce({
      productGpsr: PRODUKT_GPSR_RICHTIG,
      registry: halbeAnschrift,
      brand: 'Acme',
    });
    for (const k of MANUFACTURER_ADDRESS_KEYS) {
      expect(plan.apply[k]).toBeUndefined();
    }
    expect(plan.reasons).toContain('anschrift_unvollstaendig_uebersprungen');
  });

  it('uebernimmt eine vollstaendige Anschrift dann aber KOMPLETT', () => {
    const plan = planRegistryEnforce({
      productGpsr: { manufacturer_name: '', manufacturer_city: 'Irgendwo' },
      registry: REGISTRY_SAUBER,
      brand: 'BBQ-Toro',
    });
    expect(plan.apply.manufacturer_address).toBe('Moselweinstraße 55');
    expect(plan.apply.manufacturer_city).toBe('Brauneberg');
    expect(plan.apply.manufacturer_postalcode).toBe('54472');
    expect(plan.apply.entity_country).toBe('Germany');
    expect(plan.apply.country_code).toBe('DE');
  });

  it('schuetzt vom Etikett gelesene Produktdaten (Bestandsverhalten)', () => {
    const plan = planRegistryEnforce({
      productGpsr: { ...PRODUKT_GPSR_RICHTIG, evidence: { status: 'product_image' } },
      registry: REGISTRY_SAUBER,
      brand: 'BBQ-Toro',
    });
    expect(plan.apply).toEqual({});
    expect(plan.reasons).toContain('produktbeleg_schlaegt_registry');
  });

  it('schuetzt eine menschliche Korrektur genauso wie das Etikett', () => {
    const plan = planRegistryEnforce({
      productGpsr: { ...PRODUKT_GPSR_RICHTIG, evidence: { status: 'manual' } },
      registry: REGISTRY_SAUBER,
      brand: 'BBQ-Toro',
    });
    expect(plan.apply).toEqual({});
  });

  it('fuellt bei schwachem Beleg nur Luecken und ueberschreibt nie', () => {
    const schwach = { ...REGISTRY_SAUBER, confidence: 0.4, sources: ['https://acme.de/impressum'] };
    const plan = planRegistryEnforce({
      productGpsr: { manufacturer_name: 'Eigener Name GmbH', email: '' },
      registry: schwach,
      brand: 'BBQ-Toro',
    });
    expect(plan.apply.manufacturer_name).toBeUndefined();
    expect(plan.apply.email).toBe('verkauf@cs-trading.de');
  });

  it('hinterlaesst nie einen widerspruechlichen Datensatz (Ergebniskontrolle)', () => {
    // Registry kennt eine vollständige deutsche Anschrift, nennt aber kein
    // Land. Am Produkt steht ein stehengebliebenes "China" — genau die
    // Konstellation des Vorfalls. Die Anschrift darf so NICHT landen.
    const ohneLand = {
      key: 'acme',
      manufacturer_name: 'Acme GmbH',
      confidence: 0.95,
      sources: ['https://acme.de/impressum'],
      gpsr: {
        manufacturer_name: 'Acme GmbH',
        manufacturer_address: 'Hauptstr. 1',
        manufacturer_city: 'Berlin',
        manufacturer_postalcode: '10115',
        manufacturer_phone: '+493012345',
        url: 'https://acme.de',
      },
    };
    const plan = planRegistryEnforce({
      productGpsr: { entity_country: 'China', country_code: 'CN' },
      registry: ohneLand,
      brand: 'Acme',
    });
    expect(plan.apply.manufacturer_address).toBeUndefined();
    expect(plan.apply.manufacturer_city).toBeUndefined();
    expect(plan.reasons).toContain('ergebnis_waere_widerspruechlich');
  });

  it('heilt einen widerspruechlichen Produktstand, wenn die Registry stimmig ist', () => {
    const plan = planRegistryEnforce({
      // Der kaputte Ist-Stand des Vorfalls …
      productGpsr: {
        entity_country: 'China',
        country_code: 'CN',
        manufacturer_address: 'Moselweinstrasse 55',
        manufacturer_city: 'Kirchheim unter Teck',
        manufacturer_postalcode: '73230',
      },
      // … und ein sauberer, belegter Eintrag, der das Land MITBRINGT.
      registry: REGISTRY_SAUBER,
      brand: 'BBQ-Toro',
    });
    expect(plan.blocked).toBe(false);
    expect(plan.apply.manufacturer_city).toBe('Brauneberg');
    expect(plan.apply.country_code).toBe('DE');
    expect(plan.reasons).not.toContain('ergebnis_waere_widerspruechlich');
  });

  it('ist fail-safe: kaputte Eingaben fuehren nie zu einer Uebernahme', () => {
    expect(planRegistryEnforce({}).apply).toEqual({});
    expect(planRegistryEnforce({ productGpsr: null, registry: null }).apply).toEqual({});
    expect(planRegistryEnforce({ registry: { gpsr: null } }).apply).toEqual({});
  });
});
