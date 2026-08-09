'use strict';

/**
 * Deutsche Ländernamen müssen erkannt werden.
 *
 * Befund 2026-08-10: `normalizeCountryToEnglish` kannte genau DREI deutsche
 * Ländernamen (Deutschland, Österreich, Schweiz). In einer deutschsprachigen
 * Anwendung, in der Menschen "Spanien" und "Frankreich" tippen, blieb alles
 * andere unerkannt.
 *
 * Die Folge ist nicht kosmetisch: `buildResponsiblePersonFromGpsr`
 * (lib/gpsr-eu-rep.js) bildet den Ländercode als
 *
 *   eu_responsible_country_code || normalizeCountryCode(eu_responsible_country) || 'DE'
 *
 * Ein Nutzer, der "Spanien" einträgt und keinen Code setzt, bekommt damit
 * still 'DE' — eine Madrider Adresse geht als Deutschland an eBay. Genau
 * dieser Zustand stand im Produkt SKU-3154363905 (eBay 800483780290):
 * eu_responsible_country "Spanien", eu_responsible_country_code "DE".
 */

const {
  normalizeCountryCode,
  normalizeCountryToEnglish,
} = require('../lib/gpsr-manufacturer-registry');

describe('normalizeCountryCode — deutsche Ländernamen', () => {
  const EU_UND_NACHBARN = {
    Deutschland: 'DE',
    Österreich: 'AT',
    Schweiz: 'CH',
    Spanien: 'ES',
    Frankreich: 'FR',
    Italien: 'IT',
    Niederlande: 'NL',
    Belgien: 'BE',
    Polen: 'PL',
    Tschechien: 'CZ',
    Slowakei: 'SK',
    Slowenien: 'SI',
    Ungarn: 'HU',
    Rumänien: 'RO',
    Bulgarien: 'BG',
    Griechenland: 'GR',
    Kroatien: 'HR',
    Schweden: 'SE',
    Dänemark: 'DK',
    Finnland: 'FI',
    Norwegen: 'NO',
    Irland: 'IE',
    Portugal: 'PT',
    Estland: 'EE',
    Lettland: 'LV',
    Litauen: 'LT',
    Luxemburg: 'LU',
    Malta: 'MT',
    Zypern: 'CY',
    Türkei: 'TR',
  };

  it.each(Object.entries(EU_UND_NACHBARN))('erkennt "%s" als %s', (name, code) => {
    expect(normalizeCountryCode(name)).toBe(code);
  });

  it('erkennt auch Schreibweisen ohne Umlaut', () => {
    expect(normalizeCountryCode('Oesterreich')).toBe('AT');
    expect(normalizeCountryCode('Tuerkei')).toBe('TR');
    expect(normalizeCountryCode('Daenemark')).toBe('DK');
    expect(normalizeCountryCode('Rumaenien')).toBe('RO');
  });

  it('erkennt außereuropäische Herkunftsländer auf Deutsch', () => {
    expect(normalizeCountryCode('China')).toBe('CN');
    expect(normalizeCountryCode('Vereinigte Staaten')).toBe('US');
    expect(normalizeCountryCode('Vereinigtes Königreich')).toBe('UK');
    expect(normalizeCountryCode('Japan')).toBe('JP');
    expect(normalizeCountryCode('Indien')).toBe('IN');
    expect(normalizeCountryCode('Südkorea')).toBe('KR');
    expect(normalizeCountryCode('Taiwan')).toBe('TW');
    expect(normalizeCountryCode('Hongkong')).toBe('HK');
    expect(normalizeCountryCode('Vietnam')).toBe('VN');
  });

  it('bleibt bei englischen Namen und Codes unverändert korrekt', () => {
    expect(normalizeCountryCode('Spain')).toBe('ES');
    expect(normalizeCountryCode('Germany')).toBe('DE');
    expect(normalizeCountryCode('ES')).toBe('ES');
    expect(normalizeCountryCode('GB')).toBe('UK'); // Marktplatz-Konvention
    expect(normalizeCountryCode('')).toBe('');
  });

  it('normalizeCountryToEnglish übersetzt deutsche Namen', () => {
    expect(normalizeCountryToEnglish('Spanien')).toBe('Spain');
    expect(normalizeCountryToEnglish('Frankreich')).toBe('France');
    expect(normalizeCountryToEnglish('Niederlande')).toBe('Netherlands');
  });

  it('erfindet für unbekannte Eingaben keinen Code', () => {
    // Fail-safe: lieber leer als falsch — ein geratener Code landet als
    // rechtlich relevante Angabe auf dem Marktplatz.
    expect(normalizeCountryCode('Phantasialand')).toBe('');
    expect(normalizeCountryCode('irgendwas')).toBe('');
  });
});

describe('Drei-Buchstaben-Ländercodes (ISO alpha-3)', () => {
  it('erkennt CHN/DEU/USA — bisher fielen sie durch alle Tabellen', () => {
    // Gemessen 2026-08-10: 5 Produkte trugen entity_country "CHN" und galten
    // dadurch als EU-Hersteller — also ohne Pflicht zum EU-Verantwortlichen.
    expect(normalizeCountryCode('CHN')).toBe('CN');
    expect(normalizeCountryCode('DEU')).toBe('DE');
    expect(normalizeCountryCode('USA')).toBe('US');
    expect(normalizeCountryCode('ESP')).toBe('ES');
    expect(normalizeCountryCode('FRA')).toBe('FR');
    expect(normalizeCountryCode('GBR')).toBe('UK');
    expect(normalizeCountryCode('NLD')).toBe('NL');
    expect(normalizeCountryCode('POL')).toBe('PL');
  });
});

describe('Nicht-EU-Erkennung profitiert von der Übersetzung', () => {
  const { isNonEuManufacturer, manufacturerCountryCode } = require('../lib/gpsr-eu-rep');

  it('erkennt einen chinesischen Hersteller über den deutschen Namen', () => {
    expect(isNonEuManufacturer({ entity_country: 'China' })).toBe(true);
  });

  it('erkennt einen französischen Hersteller als EU (kein EU-Rep nötig)', () => {
    expect(isNonEuManufacturer({ entity_country: 'Frankreich' })).toBe(false);
  });

  it('erkennt einen spanischen Hersteller als EU', () => {
    expect(isNonEuManufacturer({ entity_country: 'Spanien' })).toBe(false);
  });

  it('erkennt "CHN" als Nicht-EU', () => {
    expect(isNonEuManufacturer({ entity_country: 'CHN' })).toBe(true);
  });

  it('lässt das ausgeschriebene Land gewinnen, wenn der Code ihm widerspricht', () => {
    // Gemessen 2026-08-10: 17 Produkte mit entity_country "China" galten als
    // EU, weil ein stehengebliebener country_code (z.B. "DE" oder "FR") den
    // Vorrang hatte. Der Code ist der abgeleitete, oft veraltete Wert; das
    // ausgeschriebene Land kommt vom Etikett bzw. vom Menschen.
    expect(manufacturerCountryCode({ entity_country: 'China', country_code: 'FR' })).toBe('CN');
    expect(isNonEuManufacturer({ entity_country: 'China', country_code: 'FR' })).toBe(true);
  });

  it('behält den Code, wenn kein widersprechendes Land danebensteht', () => {
    expect(manufacturerCountryCode({ country_code: 'CN' })).toBe('CN');
    expect(manufacturerCountryCode({ entity_country: 'China', country_code: 'CN' })).toBe('CN');
    // Unauflösbares Land darf einen gültigen Code NICHT verdrängen.
    expect(manufacturerCountryCode({ entity_country: 'Phantasialand', country_code: 'CN' })).toBe('CN');
  });
});
