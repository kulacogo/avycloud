'use strict';

// Zonen — TrendOcean-Business-Regeln (NICHT SendClouds Länderlisten).
const ZONE_1 = ['BE', 'DK', 'FR', 'LU', 'MC', 'NL', 'AT', 'PL', 'CZ'];
const ZONE_2 = ['AD', 'IT', 'SM', 'SE', 'SK', 'SI', 'ES', 'HU', 'VA'];
const DPD_EUROPA = ['BE', 'LU', 'NL', 'AT', 'DK', 'CZ', 'FR'];

// Zusatzleistungen, die NIE genutzt werden — jeder Code, der matcht, fliegt raus.
// `incoterm`/`ddp` = Einfuhrabgaben gehen zu unseren Lasten (teuer) -> nie automatisch.
// `flex_delivery`/`bulky_goods` = kostenpflichtige Zusatzservices.
const FORBIDDEN = /gogreen|eco[_-]?delivery|premium|service[_-]?point|locker|filial|alterssicht|age[_-]?check|agecheck|transportvers|insur|express|sperrgut|bulky_goods|extra_fee|signature|flex_delivery|incoterm|ddp/i;

// Kuratierte Produkte (Plakat-Nomenklatur). `match(code)` prüft den v3-Basis-Produktcode.
// tracking = nur Anzeige-Indikator (Sendungsnummer existiert immer).
// Ein Produkt kann über mehrere Gewichts-Tiers matchen (z. B. DPD Classic 0-5/5-10/…);
// der Resolver wählt die gewichts-passende, plainste Variante.
const PRODUCTS = [
  // ── DEUTSCHLAND (scope: national) — Reihenfolge: Maxibrief, Warensendung, Kleinpaket, DPD Classic, DHL Paket ──
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

  // ── EU / INTERNATIONAL (scope: international) ──
  { key: 'warenpost_int', displayName: 'Warenpost International', carrier: 'dhl_de', scope: 'international', maxWeightKg: 1, tracking: false, rank: 1,
    match: (c) => /^dhl_de:warenpostinternational(\b|\/|,|$)/i.test(c) },
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
  { key: 'dhl_paket_int', displayName: 'DHL Paket International', carrier: 'dhl_de', scope: 'international', maxWeightKg: 31.5, tracking: true, rank: 3,
    match: (c) => /^dhl_de:(weltpaket|paket_international|dhl_paket_international)(\b|\/|,|$)/i.test(c) },
];

module.exports = { ZONE_1, ZONE_2, DPD_EUROPA, FORBIDDEN, PRODUCTS };
