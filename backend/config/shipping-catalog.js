'use strict';

// Zonen — TrendOcean-Business-Regeln (NICHT SendClouds Länderlisten).
const ZONE_1 = ['BE', 'DK', 'FR', 'LU', 'MC', 'NL', 'AT', 'PL', 'CZ'];
const ZONE_2 = ['AD', 'IT', 'SM', 'SE', 'SK', 'SI', 'ES', 'HU', 'VA'];
const DPD_EUROPA = ['BE', 'LU', 'NL', 'AT', 'DK', 'CZ', 'FR'];

// Zusatzleistungen, die NIE genutzt werden — jeder Code, der matcht, fliegt raus.
// `incoterm`/`ddp` = Einfuhrabgaben gehen zu unseren Lasten (teuer) -> nie automatisch.
// `flex_delivery`/`bulky_goods` = kostenpflichtige Zusatzservices.
// AUSNAHMEN pro Produkt über `allow` (siehe unten): `premium` ist seit 2026-08-21
// für DHL International PFLICHT (nur Premium trägt Sendungsverfolgung) und
// `express` ist das DPD-Express-Produkt selbst — beide bleiben für alle
// übrigen Produkte verboten.
const FORBIDDEN = /gogreen|eco[_-]?delivery|premium|service[_-]?point|locker|filial|alterssicht|age[_-]?check|agecheck|transportvers|insur|express|sperrgut|bulky_goods|extra_fee|signature|flex_delivery|incoterm|ddp/i;

// Tracking-Pflicht (Betreiber-Anweisung 2026-08-21): ab diesem Bestellwert (EUR)
// sind nur noch Versandarten mit Sendungsverfolgung erlaubt. ENV-Override
// SHIPPING_TRACKED_ONLY_FROM_EUR ('off' schaltet die Regel ab).
const TRACKED_ONLY_FROM_EUR_DEFAULT = 10;

// Prüft, ob ein Premium-Modifier im Code steckt (dhl_de:weltpaket/premium,
// dhl_de:warenpostinternational/premium — gemessen 2026-08-21).
const hasPremium = (c) => /[/,]premium(\b|,|$)/i.test(c);

// Notbremse für premiumlose Lanes: NUR der exakte Wert 'off' schaltet die
// Premium-Pflicht ab (Katalog matcht dann wieder plain-Codes, der
// createParcel-Guard lässt sie durch). Default an. Gemessen 2026-08-21: alle
// real bedienten Lanes (FR/IT/GR/AT/CH/GB) führen weltpaket/premium — die
// Bremse ist Versicherung gegen ungemessene Lanes, kein erwarteter Zustand.
const premiumRequired = () => String(process.env.SHIPPING_PREMIUM_REQUIRED ?? 'on').trim().toLowerCase() !== 'off';

// Kuratierte Produkte (Plakat-Nomenklatur). `match(code)` prüft den v3-Basis-Produktcode.
// tracking = trägt die Versandart eine Sendungsnummer? Seit 2026-08-21 FILTER-relevant:
// ab 10 € Bestellwert (und bei unbekanntem Wert) fliegen tracking:false-Produkte raus.
// `allow` = Regex der FORBIDDEN-Tokens, die für DIESES Produkt erlaubt sind; der
// Resolver entfernt sie vor dem FORBIDDEN-Test aus dem Code (alle übrigen
// Zusatzleistungen bleiben auch für diese Produkte verboten).
// Ein Produkt kann über mehrere Gewichts-Tiers matchen (z. B. DPD Classic 0-5/5-10/…);
// der Resolver wählt die gewichts-passende, plainste Variante.
const PRODUCTS = [
  // ── DEUTSCHLAND (scope: national) — Reihenfolge: Maxibrief, Warensendung, Kleinpaket, DPD Classic, DHL Paket, DPD Express ──
  // Großbrief bewusst NICHT im Katalog: einfacher Großbrief ist auf dem SendCloud-Konto
  // nicht verfügbar (nur Einschreiben-Variante) — wird per Hand frankiert (Owner-Entscheid 2026-07-22).
  { key: 'maxibrief', displayName: 'Maxibrief', carrier: 'dp', scope: 'national', maxWeightKg: 1, tracking: false, rank: 1,
    match: (c) => /^dp:maxibrief(\b|\/|,|$)/i.test(c) },
  { key: 'warensendung', displayName: 'Warensendung', carrier: 'dp', scope: 'national', maxWeightKg: 1, tracking: false, rank: 2,
    // Deutsche Post hat Büchersendung + Warensendung zu "Bücher- und Warensendung"
    // verschmolzen — echter Code `dp:bucherwarensendung` (verifiziert via Prod-Logs 2026-07-22).
    match: (c) => /^dp:(bucherwarensendung|warensendung)(\b|\/|,|$)/i.test(c) },
  { key: 'kleinpaket', displayName: 'Kleinpaket', carrier: 'dhl_de', scope: 'national', maxWeightKg: 1, tracking: true, rank: 3,
    match: (c) => /^dhl_de:warenpost(\b|\/|,|$)/i.test(c) && !/international/i.test(c) },
  { key: 'dpd_classic', displayName: 'DPD Classic', carrier: 'dpd', scope: 'national', maxWeightKg: 31.5, tracking: true, rank: 4,
    match: (c) => /^dpd:classic(\b|\/|,|$)/i.test(c) },
  { key: 'dhl_paket', displayName: 'DHL Paket', carrier: 'dhl_de', scope: 'national', maxWeightKg: 31.5, tracking: true, rank: 5,
    match: (c) => /^dhl_de:dhl_paket(\b|\/|,|$)/i.test(c) },
  // DPD Express (Betreiber-Anweisung 2026-08-21: Teil des DPD-Vertrags, war durch
  // die FORBIDDEN-Regex unerreichbar). Live gemessen 2026-08-21: `dpd:express`
  // existiert NIE nackt, nur mit Pflicht-Modifier delivery=0830|12|18 — und nur
  // auf DE-Lanes. 18:00 (Standard-Express, günstiger) vor 12:00; die
  // 08:30-Variante bleibt bewusst draußen (teuerste Randvariante, bei Bedarf
  // später ergänzen).
  { key: 'dpd_express_18', displayName: 'DPD Express 18:00', carrier: 'dpd', scope: 'national', maxWeightKg: 31.5, tracking: true, rank: 6,
    allow: /express/gi,
    match: (c) => /^dpd:express[/,]/i.test(c) && /[/,]delivery=18(\b|,|$)/i.test(c) },
  { key: 'dpd_express_12', displayName: 'DPD Express 12:00', carrier: 'dpd', scope: 'national', maxWeightKg: 31.5, tracking: true, rank: 7,
    allow: /express/gi,
    match: (c) => /^dpd:express[/,]/i.test(c) && /[/,]delivery=12(\b|,|$)/i.test(c) },

  // ── EU / INTERNATIONAL (scope: international) ──
  // PREMIUM-PFLICHT (Betreiber-Anweisung 2026-08-21): Warenpost International und
  // DHL Paket International tragen NUR als Premium eine Sendungsverfolgung — sie
  // werden IMMER als Premium versendet. Ohne Premium-Variante auf der Lane
  // verschwindet der Slot (DPD Classic bleibt als tracked Alternative), statt
  // ohne Tracking zu versenden.
  { key: 'warenpost_int', displayName: 'Warenpost International Premium', carrier: 'dhl_de', scope: 'international', maxWeightKg: 1, tracking: true, rank: 1,
    allow: /premium/gi,
    match: (c) => /^dhl_de:warenpostinternational(\b|\/|,|$)/i.test(c) && (!premiumRequired() || hasPremium(c)) },
  // KEINE eigene Länder-Sperre mehr (Owner 2026-07-22): DPD wird überall angeboten,
  // wo SendCloud es für die Lane liefert (z. B. Portugal — DPD dort leistungsstärker).
  // DPD_EUROPA bleibt nur als Doku der günstigsten Plakat-Lanes erhalten.
  { key: 'dpd_classic_europa', displayName: 'DPD Classic Europa', carrier: 'dpd', scope: 'international', maxWeightKg: 31.5, tracking: true, rank: 2,
    match: (c) => /^dpd:classic(\b|\/|,|$)/i.test(c) },
  // `europaket` gehört hier NICHT hinein: SendCloud unterscheidet die beiden
  // Produkte sauber über product.name — `dhl_de:weltpaket` ist „DHL Paket
  // International", `dhl_de:europaket` ist „DHL Europaket". Das ist ein anderes
  // DHL-Produkt (eigene Abrechnungsnummer, andere Preise) und steht nicht auf
  // dem TrendOcean-Plakat. Solange es im Vertrag keine Abrechnungsnummer hat,
  // scheitert JEDER Label-Call daran:
  //   400 "Please add the billing number for this product in the DHL contract."
  // Weil beide Codes modifierCount 0 haben, war die Wahl zwischen ihnen ein
  // Gleichstand — und die stabile Sortierung übernahm die Reihenfolge der
  // SendCloud-Antwort, die nachweislich nicht deterministisch ist. Ergebnis:
  // Münzwurf. 21 Tage Prod-Logs, ausnahmslos: europaket 11× → Fehler,
  // weltpaket 6× → Erfolg (Vorfall 2026-08-07, Auftrag 10-14999-44761).
  { key: 'dhl_paket_int', displayName: 'DHL Paket International Premium', carrier: 'dhl_de', scope: 'international', maxWeightKg: 31.5, tracking: true, rank: 3,
    allow: /premium/gi,
    match: (c) => /^dhl_de:(weltpaket|paket_international|dhl_paket_international)(\b|\/|,|$)/i.test(c) && (!premiumRequired() || hasPremium(c)) },
];

module.exports = { ZONE_1, ZONE_2, DPD_EUROPA, FORBIDDEN, PRODUCTS, TRACKED_ONLY_FROM_EUR_DEFAULT, premiumRequired, hasPremium };
