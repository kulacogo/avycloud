'use strict';

// Zonen — TrendOcean-Business-Regeln (NICHT SendClouds Länderlisten).
const ZONE_1 = ['BE', 'DK', 'FR', 'LU', 'MC', 'NL', 'AT', 'PL', 'CZ'];
const ZONE_2 = ['AD', 'IT', 'SM', 'SE', 'SK', 'SI', 'ES', 'HU', 'VA'];
const DPD_EUROPA = ['BE', 'LU', 'NL', 'AT', 'DK', 'CZ', 'FR'];

// Zusatzleistungen, die NIE genutzt werden — jeder Code, der matcht, fliegt raus.
const FORBIDDEN = /gogreen|eco[_-]?delivery|premium|service[_-]?point|locker|filial|alterssicht|age[_-]?check|agecheck|transportvers|insur|express|sperrgut|extra_fee|signature/i;

// Kuratierte Produkte (Plakat-Nomenklatur). `match(code)` prüft den v3-Basis-Produktcode.
// tracking = nur Anzeige-Indikator (Sendungsnummer existiert immer).
// Ein Produkt kann über mehrere Gewichts-Tiers matchen (z. B. DPD Classic 0-5/5-10/…);
// der Resolver wählt die gewichts-passende, plainste Variante.
const PRODUCTS = [
  // ── DEUTSCHLAND (scope: national) ──
  { key: 'grossbrief', displayName: 'Großbrief', carrier: 'dp', scope: 'national', maxWeightKg: 0.5, tracking: false, rank: 1,
    match: (c) => /^dp:grossbrief(\b|\/|,|$)/i.test(c) },
  { key: 'warensendung', displayName: 'Warensendung', carrier: 'dp', scope: 'national', maxWeightKg: 1, tracking: false, rank: 2,
    // Deutsche Post hat Büchersendung + Warensendung zu "Bücher- und Warensendung"
    // verschmolzen — auf diesem Konto ist der echte Code `dp:bucherwarensendung`
    // (verifiziert via Prod-Logs 2026-07-22). `dp:warensendung` als Fallback belassen.
    match: (c) => /^dp:(bucherwarensendung|warensendung)(\b|\/|,|$)/i.test(c) },
  { key: 'maxibrief', displayName: 'Maxibrief', carrier: 'dp', scope: 'national', maxWeightKg: 1, tracking: false, rank: 3,
    match: (c) => /^dp:maxibrief(\b|\/|,|$)/i.test(c) },
  { key: 'kleinpaket', displayName: 'Kleinpaket', carrier: 'dhl_de', scope: 'national', maxWeightKg: 1, tracking: true, rank: 3,
    match: (c) => /^dhl_de:warenpost(\b|\/|,|$)/i.test(c) && !/international/i.test(c) },
  { key: 'dpd_classic', displayName: 'DPD Classic', carrier: 'dpd', scope: 'national', maxWeightKg: 31.5, tracking: true, rank: 4,
    match: (c) => /^dpd:classic(\b|\/|,|$)/i.test(c) },
  { key: 'dhl_paket', displayName: 'DHL Paket', carrier: 'dhl_de', scope: 'national', maxWeightKg: 31.5, tracking: true, rank: 5,
    match: (c) => /^dhl_de:dhl_paket(\b|\/|,|$)/i.test(c) },

  // ── EU / INTERNATIONAL (scope: international) ──
  { key: 'warenpost_int', displayName: 'Warenpost International', carrier: 'dhl_de', scope: 'international', maxWeightKg: 1, tracking: false, rank: 1,
    match: (c) => /^dhl_de:warenpostinternational(\b|\/|,|$)/i.test(c) },
  { key: 'dpd_classic_europa', displayName: 'DPD Classic Europa', carrier: 'dpd', scope: 'international', maxWeightKg: 31.5, tracking: true, rank: 2, allowedCountries: DPD_EUROPA,
    match: (c) => /^dpd:classic(\b|\/|,|$)/i.test(c) },
  { key: 'dhl_paket_int', displayName: 'DHL Paket International', carrier: 'dhl_de', scope: 'international', maxWeightKg: 31.5, tracking: true, rank: 3,
    match: (c) => /^dhl_de:(europaket|weltpaket|paket_international|dhl_paket_international)(\b|\/|,|$)/i.test(c) },
];

module.exports = { ZONE_1, ZONE_2, DPD_EUROPA, FORBIDDEN, PRODUCTS };
