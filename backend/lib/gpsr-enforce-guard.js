'use strict';

/**
 * gpsr-enforce-guard.js — dritte Sperre gegen die Registry-Verschmierung.
 *
 * VORFALL 2026-09-03 (Produkt 371fce64 / SKU-1698488489, Marke "BBQ-Toro"):
 * Der Chat recherchierte die richtigen Herstellerangaben (CS-Trading GmbH &
 * Co. KG, Moselweinstraße 55, 54472 Brauneberg) und schrieb sie ins
 * Datenblatt. 400 ms später überschrieb der Registry-Enforce-Block in
 * `lib/firestore.js` sie im SELBEN Speichervorgang mit dem Inhalt von
 * `gpsrManufacturers/bbq-toro` — belegt durch `ops.data_quality.gpsr_backup_v1`
 * am echten Produkt. Ergebnis: deutsche Straße, fremder Ort (Kirchheim unter
 * Teck), fremde Telefonnummer, Sitzland "China" und eine unbeteiligte Firma
 * (Geaplan GmbH) als EU-Verantwortlicher.
 *
 * Die beiden vorhandenen Sperren greifen bauartbedingt nicht:
 *   - `isPlaceholderBrand('BBQ-Toro')` → false, das ist eine echte Marke.
 *   - `isEnforceableRegistryEntry()` → true, denn IRGENDEIN Beleg genügt ihr;
 *     eine Google-Produktübersichtsseite zählt als "Quelle".
 *
 * Diese Datei beantwortet die dritte, bisher ungestellte Frage:
 * *Ist der Registry-Eintrag in sich überhaupt plausibel — und wie scharf darf
 * er auf Produktdaten wirken, die womöglich besser belegt sind als er?*
 *
 * Drei Grundsätze:
 *
 *  1. EINE ANSCHRIFT IST ATOMAR. Straße aus Quelle A und Ort/PLZ aus Quelle B
 *     ergeben eine Adresse, die es nirgends gibt. Genau so entstand der
 *     Vorfall. Die Anschrift wird deshalb nur KOMPLETT übernommen oder gar
 *     nicht — nie feldweise.
 *  2. WIDERSPRUCH SCHLÄGT BELEG. Ein Eintrag mit deutscher Telefonnummer,
 *     deutscher Domain, zwei verschiedenen Postleitzahlen und Sitzland China
 *     ist unbrauchbar, egal welche Konfidenz danebensteht.
 *  3. IM ZWEIFEL BLEIBT DAS PRODUKT STEHEN. Ein verpasster Registry-Abgleich
 *     kostet Einheitlichkeit; ein falscher Überschreib kostet die richtige
 *     Angabe — und die steht rechtlich haftend im Angebot.
 *
 * Reine Rechen-Bibliothek: kein Firestore, kein Netz, keine Seiteneffekte.
 */

const EU_COUNTRY_CODES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

/** Anschrift des Herstellers — wird ausschliesslich als Block behandelt. */
const MANUFACTURER_ADDRESS_KEYS = [
  'manufacturer_address',
  'manufacturer_city',
  'manufacturer_postalcode',
  'manufacturer_state_province',
  'entity_country',
  'country_code',
];

/**
 * Ohne diese drei Angaben ist eine Anschrift keine Anschrift. Das Land steht
 * bewusst NICHT drin: viele ehrliche Einträge führen nur die Postanschrift.
 * Dass Land und Anschrift zusammenpassen, prüft stattdessen die
 * Ergebniskontrolle in `planRegistryEnforce` — sie ist schärfer, weil sie den
 * FERTIGEN Datensatz bewertet statt die Vollständigkeit der Quelle.
 */
const REQUIRED_ADDRESS_KEYS = ['manufacturer_address', 'manufacturer_city', 'manufacturer_postalcode'];

const IDENTITY_KEYS = ['manufacturer_name'];
const CONTACT_KEYS = ['manufacturer_phone', 'email', 'url'];
const EU_RESPONSIBLE_PREFIX = 'eu_responsible_';

/** Produkteigene Belege, die einen Registry-Eintrag immer schlagen. */
const PRODUCT_EVIDENCE_BEATS_REGISTRY = new Set([
  'product_image', // vom Etikett gelesen (Bestandsverhalten seit 2026-07-17)
  'manual',        // Mensch hat es eingetippt
  'operator',
  'human',
  'chat_verified', // Chat-Recherche mit bestandenem Beleg-Gate
]);

/** Ab dieser Konfidenz darf ein Eintrag vorhandene Werte ÜBERSCHREIBEN. */
const STRONG_CONFIDENCE = 0.8;

/**
 * Hosts, die nichts belegen: Suchmaschinen und ihre Produktseiten. Der
 * BBQ-Toro-Eintrag führte "google.co.in/intl/de/about/products" als Quelle.
 */
const NON_EVIDENCE_HOST_PATTERNS = [
  /(^|\.)google\./i,
  /(^|\.)bing\./i,
  /(^|\.)yahoo\./i,
  /(^|\.)duckduckgo\./i,
  /(^|\.)baidu\./i,
  /(^|\.)yandex\./i,
  /(^|\.)ecosia\./i,
  /(^|\.)startpage\./i,
];

// Telefon-Landesvorwahlen (längster Treffer gewinnt). Bewusst ohne "+1":
// USA/Kanada teilen sie, das wäre kein eindeutiger Hinweis.
const DIAL_CODES = {
  30: 'GR', 31: 'NL', 32: 'BE', 33: 'FR', 34: 'ES', 36: 'HU', 39: 'IT',
  40: 'RO', 41: 'CH', 43: 'AT', 44: 'GB', 45: 'DK', 46: 'SE', 47: 'NO',
  48: 'PL', 49: 'DE', 81: 'JP', 82: 'KR', 84: 'VN', 86: 'CN', 90: 'TR', 91: 'IN',
  212: 'MA', 351: 'PT', 352: 'LU', 353: 'IE', 356: 'MT', 357: 'CY', 358: 'FI',
  359: 'BG', 370: 'LT', 371: 'LV', 372: 'EE', 380: 'UA', 385: 'HR', 386: 'SI',
  420: 'CZ', 421: 'SK', 852: 'HK', 886: 'TW', 971: 'AE',
};
const DIAL_PREFIXES = Object.keys(DIAL_CODES).sort((a, b) => b.length - a.length);

// Länder-TLDs. Generische Endungen (.com/.eu/.net/.io) sagen nichts.
const TLD_CODES = {
  de: 'DE', at: 'AT', ch: 'CH', fr: 'FR', it: 'IT', es: 'ES', nl: 'NL', be: 'BE',
  pt: 'PT', ie: 'IE', lu: 'LU', dk: 'DK', se: 'SE', fi: 'FI', no: 'NO', pl: 'PL',
  cz: 'CZ', sk: 'SK', hu: 'HU', ro: 'RO', bg: 'BG', hr: 'HR', si: 'SI', ee: 'EE',
  lv: 'LV', lt: 'LT', gr: 'GR', cy: 'CY', mt: 'MT', uk: 'GB', cn: 'CN', hk: 'HK',
  tw: 'TW', jp: 'JP', kr: 'KR', tr: 'TR', in: 'IN', us: 'US', ua: 'UA',
};

const GERMAN_STATES = [
  'baden-württemberg', 'baden-wuerttemberg', 'bayern', 'berlin', 'brandenburg',
  'bremen', 'hamburg', 'hessen', 'mecklenburg-vorpommern', 'niedersachsen',
  'nordrhein-westfalen', 'rheinland-pfalz', 'saarland', 'sachsen',
  'sachsen-anhalt', 'schleswig-holstein', 'thüringen', 'thueringen',
];

// Ausgeschriebene Ländernamen → ISO. Nur, was wir sicher zuordnen können.
const COUNTRY_NAMES = {
  deutschland: 'DE', germany: 'DE', allemagne: 'DE',
  österreich: 'AT', oesterreich: 'AT', austria: 'AT',
  schweiz: 'CH', switzerland: 'CH', suisse: 'CH',
  frankreich: 'FR', france: 'FR',
  italien: 'IT', italy: 'IT', italia: 'IT',
  spanien: 'ES', spain: 'ES', españa: 'ES', espana: 'ES',
  niederlande: 'NL', netherlands: 'NL', holland: 'NL',
  belgien: 'BE', belgium: 'BE',
  polen: 'PL', poland: 'PL', polska: 'PL',
  tschechien: 'CZ', czechia: 'CZ', 'czech republic': 'CZ',
  slowakei: 'SK', slovakia: 'SK',
  ungarn: 'HU', hungary: 'HU',
  rumänien: 'RO', rumaenien: 'RO', romania: 'RO',
  bulgarien: 'BG', bulgaria: 'BG',
  kroatien: 'HR', croatia: 'HR',
  slowenien: 'SI', slovenia: 'SI',
  dänemark: 'DK', daenemark: 'DK', denmark: 'DK',
  schweden: 'SE', sweden: 'SE',
  finnland: 'FI', finland: 'FI',
  norwegen: 'NO', norway: 'NO',
  irland: 'IE', ireland: 'IE',
  portugal: 'PT',
  griechenland: 'GR', greece: 'GR',
  luxemburg: 'LU', luxembourg: 'LU',
  estland: 'EE', estonia: 'EE',
  lettland: 'LV', latvia: 'LV',
  litauen: 'LT', lithuania: 'LT',
  zypern: 'CY', cyprus: 'CY',
  malta: 'MT',
  china: 'CN', 'volksrepublik china': 'CN', 'p.r. china': 'CN', prc: 'CN',
  hongkong: 'HK', 'hong kong': 'HK',
  taiwan: 'TW',
  japan: 'JP',
  südkorea: 'KR', suedkorea: 'KR', 'south korea': 'KR', korea: 'KR',
  indien: 'IN', india: 'IN',
  türkei: 'TR', tuerkei: 'TR', turkey: 'TR', türkiye: 'TR',
  usa: 'US', 'u.s.a.': 'US', 'united states': 'US',
  'vereinigte staaten': 'US', 'vereinigte staaten von amerika': 'US',
  'united states of america': 'US',
  grossbritannien: 'GB', großbritannien: 'GB', 'united kingdom': 'GB',
  england: 'GB', uk: 'GB',
  kanada: 'CA', canada: 'CA',
  vietnam: 'VN', ukraine: 'UA', marokko: 'MA', morocco: 'MA',
};

const PLACEHOLDER_VALUES = new Set([
  'unbekannt', 'unknown', 'n/a', 'na', 'k.a.', 'ka', 'keine angabe', 'none',
  'null', 'undefined', '-', '–', '—', '', 'tbd', 'todo',
]);

function safeString(v) {
  if (typeof v === 'string') return v.trim();
  if (v == null) return '';
  return String(v).trim();
}

function isBlank(v) {
  const s = safeString(v);
  if (!s) return true;
  return PLACEHOLDER_VALUES.has(s.toLowerCase());
}

function normalizeKeyish(v) {
  return safeString(v).toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
}

/** Ausgeschriebener Name oder Code → ISO-2, sonst ''. */
function toCountryCode(value) {
  const raw = safeString(value);
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  if (/^[A-Z]{3}$/.test(upper)) {
    const alpha3 = { DEU: 'DE', AUT: 'AT', CHE: 'CH', CHN: 'CN', USA: 'US', GBR: 'GB', FRA: 'FR', ITA: 'IT', ESP: 'ES', NLD: 'NL', POL: 'PL', TUR: 'TR', IND: 'IN', JPN: 'JP', KOR: 'KR', TWN: 'TW', HKG: 'HK', CZE: 'CZ', PRT: 'PT', SWE: 'SE', DNK: 'DK', FIN: 'FI', NOR: 'NO', IRL: 'IE', BEL: 'BE', ROU: 'RO', BGR: 'BG', HRV: 'HR', SVN: 'SI', SVK: 'SK', HUN: 'HU', GRC: 'GR', LUX: 'LU', EST: 'EE', LVA: 'LV', LTU: 'LT', CYP: 'CY', MLT: 'MT', CAN: 'CA', VNM: 'VN', UKR: 'UA', MAR: 'MA' };
    if (alpha3[upper]) return alpha3[upper];
  }
  return COUNTRY_NAMES[raw.toLowerCase()] || '';
}

/** Das erklärte Sitzland des Herstellers (Code hat Vorrang, dann Klartext). */
function declaredCountryCode(gpsr) {
  const g = gpsr && typeof gpsr === 'object' ? gpsr : {};
  return toCountryCode(g.country_code) || toCountryCode(g.entity_country) || '';
}

function countryFromPhone(phone) {
  const raw = safeString(phone).replace(/[^\d+]/g, '');
  if (!raw) return '';
  let digits = raw.startsWith('+') ? raw.slice(1) : raw.startsWith('00') ? raw.slice(2) : '';
  if (!digits) return '';
  for (const prefix of DIAL_PREFIXES) {
    if (digits.startsWith(prefix)) return DIAL_CODES[prefix];
  }
  return '';
}

function countryFromDomainish(value) {
  const raw = safeString(value).toLowerCase();
  if (!raw) return '';
  const host = raw.includes('@') ? raw.split('@').pop() : raw.replace(/^[a-z]+:\/\//, '').split('/')[0];
  const parts = String(host || '').split('.').filter(Boolean);
  if (parts.length < 2) return '';
  const tld = parts[parts.length - 1];
  return TLD_CODES[tld] || '';
}

function countryFromStateProvince(value) {
  const raw = safeString(value);
  if (!raw) return '';
  const low = raw.toLowerCase();
  if (GERMAN_STATES.some((s) => low === s || low.includes(s))) return 'DE';
  // Postalische Präfix-Schreibweise "D-54472", "A-1010", "CH-8000".
  const m = raw.match(/^([A-Za-z]{1,2})\s*-\s*\d{4,5}\b/);
  if (m) {
    const p = m[1].toUpperCase();
    const map = { D: 'DE', A: 'AT', CH: 'CH', F: 'FR', I: 'IT', E: 'ES', NL: 'NL', B: 'BE', L: 'LU', PL: 'PL', CZ: 'CZ', DK: 'DK', S: 'SE' };
    if (map[p]) return map[p];
  }
  return toCountryCode(raw);
}

/**
 * Welches Land legt die ANSCHRIFT selbst nahe — unabhängig davon, was im
 * Landfeld steht? Telefon und Bundesland sind starke Hinweise (sie hängen
 * physisch am Ort), Domain und E-Mail schwache (die kann jeder haben).
 */
function countryHintsFromGpsr(gpsr) {
  const g = gpsr && typeof gpsr === 'object' ? gpsr : {};
  const hits = [];
  const push = (code, kind, stark) => {
    if (code) hits.push({ code, kind, stark });
  };
  push(countryFromPhone(g.manufacturer_phone), 'telefon', true);
  push(countryFromStateProvince(g.manufacturer_state_province), 'bundesland', true);
  push(countryFromDomainish(g.url), 'domain', false);
  push(countryFromDomainish(g.email), 'email', false);

  const codes = [...new Set(hits.map((h) => h.code))];
  return {
    codes,
    hits,
    total: hits.length,
    strong: hits.filter((h) => h.stark).length,
  };
}

/** Alle 4–5-stelligen Postleitzahl-Kandidaten aus einem Feld. */
function postalCandidates(value) {
  const raw = safeString(value);
  if (!raw) return [];
  return (raw.match(/\b\d{4,5}\b/g) || []).map(String);
}

/**
 * Widersprüche INNERHALB eines GPSR-Blocks. Bewusst konservativ: gemeldet wird
 * nur, was sich nicht wegdiskutieren lässt. Dünne Daten ergeben keinen Befund
 * (fail-open) — sonst würde die Sperre ehrliche, magere Einträge blockieren.
 */
function findGpsrInconsistencies(gpsr) {
  const g = gpsr && typeof gpsr === 'object' ? gpsr : {};
  const probleme = [];

  // 1) Sitzland widerspricht der Anschrift.
  const declared = declaredCountryCode(g);
  const hints = countryHintsFromGpsr(g);
  if (declared && hints.codes.length === 1 && hints.strong >= 1 && hints.total >= 2) {
    const implied = hints.codes[0];
    if (implied !== declared) {
      probleme.push({
        art: 'land_widerspricht_anschrift',
        details: `Sitzland ${declared}, Anschrift deutet auf ${implied} (${hints.hits.map((h) => h.kind).join(', ')})`,
      });
    }
  }

  // 2) Zwei verschiedene Postleitzahlen im selben Block.
  const plzFeld = postalCandidates(g.manufacturer_postalcode);
  const plzSonst = [
    ...postalCandidates(g.manufacturer_state_province),
    ...postalCandidates(g.manufacturer_city),
  ];
  if (plzFeld.length) {
    const fremd = plzSonst.filter((p) => !plzFeld.includes(p));
    if (fremd.length) {
      probleme.push({
        art: 'zwei_postleitzahlen',
        details: `PLZ-Feld ${plzFeld.join('/')}, aber ${fremd.join('/')} in Ort/Bundesland`,
      });
    }
  }

  return probleme;
}

function isInternallyConsistentGpsr(gpsr) {
  return findGpsrInconsistencies(gpsr).length === 0;
}

function credibleSources(reg) {
  const list = Array.isArray(reg?.sources) ? reg.sources : [];
  return list
    .map((s) => safeString(s))
    .filter(Boolean)
    .filter((s) => {
      const host = s.replace(/^[a-z]+:\/\//i, '').split('/')[0];
      return !NON_EVIDENCE_HOST_PATTERNS.some((re) => re.test(host));
    });
}

/**
 * Wie scharf darf dieser Registry-Eintrag wirken?
 *   'reject'    — gar nicht
 *   'fill'      — nur leere Produktfelder füllen, nie überschreiben
 *   'overwrite' — darf vorhandene Werte ersetzen
 */
function registryEnforceLevel(reg) {
  if (!reg || typeof reg !== 'object') return { level: 'reject', grund: 'leer' };
  const gpsr = reg.gpsr && typeof reg.gpsr === 'object' ? reg.gpsr : null;
  if (!gpsr || !Object.keys(gpsr).length) return { level: 'reject', grund: 'leer' };

  const probleme = findGpsrInconsistencies(gpsr);
  if (probleme.length) return { level: 'reject', grund: 'inkonsistent', probleme };

  const confidence = Number(reg.confidence);
  const hasConfidence = Number.isFinite(confidence) && confidence > 0;
  const quellen = credibleSources(reg);
  const hasEvidence = Boolean(reg.evidence && typeof reg.evidence === 'object' && Object.keys(reg.evidence).length);
  if (!hasConfidence && !quellen.length && !hasEvidence) {
    return { level: 'reject', grund: 'kein_beleg' };
  }

  const stark = (Number.isFinite(confidence) && confidence >= STRONG_CONFIDENCE) ||
    (hasEvidence && safeString(reg.evidence.status) === 'verified');
  return { level: stark ? 'overwrite' : 'fill', grund: stark ? 'belegt' : 'schwach_belegt', quellen };
}

function productEvidenceBeatsRegistry(productGpsr) {
  const status = safeString(productGpsr?.evidence?.status).toLowerCase();
  return Boolean(status) && PRODUCT_EVIDENCE_BEATS_REGISTRY.has(status);
}

function hasCompleteAddress(gpsr) {
  const g = gpsr && typeof gpsr === 'object' ? gpsr : {};
  return REQUIRED_ADDRESS_KEYS.every((k) => !isBlank(g[k]));
}

function hasAnyAddress(gpsr) {
  const g = gpsr && typeof gpsr === 'object' ? gpsr : {};
  return MANUFACTURER_ADDRESS_KEYS.some((k) => !isBlank(g[k]));
}

/**
 * Was darf aus dem Registry-Eintrag tatsächlich ins Produkt?
 *
 * @returns {{apply: object, blocked: boolean, level: string, reasons: string[]}}
 *          `apply` ist der EINZIGE Satz Felder, der geschrieben werden darf.
 */
function planRegistryEnforce({ productGpsr, registry, brand, maxLevel } = {}) {
  const reasons = [];
  const apply = {};
  const produkt = productGpsr && typeof productGpsr === 'object' ? productGpsr : {};

  const bewertung = registryEnforceLevel(registry);
  const grund = bewertung.grund;
  // Aufrufer dürfen die Schärfe DECKELN (der Autofill- und der Lese-Pfad dürfen
  // nur füllen), nie erhöhen.
  let level = bewertung.level;
  if (maxLevel === 'fill' && level === 'overwrite') level = 'fill';
  if (level === 'reject') {
    reasons.push(`registry_${grund}`);
    return { apply, blocked: true, level, reasons };
  }

  if (productEvidenceBeatsRegistry(produkt)) {
    reasons.push('produktbeleg_schlaegt_registry');
    return { apply, blocked: true, level, reasons };
  }

  const regGpsr = registry.gpsr;
  const darfUeberschreiben = level === 'overwrite';
  const setze = (key, value) => {
    if (isBlank(value)) return;
    if (!darfUeberschreiben && !isBlank(produkt[key])) return;
    if (safeString(produkt[key]) === safeString(value)) return;
    apply[key] = value;
  };

  // --- Anschrift: alles oder nichts -----------------------------------
  if (hasCompleteAddress(regGpsr)) {
    const produktHatAnschrift = hasAnyAddress(produkt);
    if (darfUeberschreiben || !produktHatAnschrift) {
      for (const key of MANUFACTURER_ADDRESS_KEYS) {
        if (!isBlank(regGpsr[key]) && safeString(produkt[key]) !== safeString(regGpsr[key])) {
          apply[key] = regGpsr[key];
        }
      }
    } else {
      reasons.push('anschrift_vorhanden_nicht_ueberschrieben');
    }
  } else if (hasAnyAddress(regGpsr)) {
    // Teil-Anschrift ist der Chimären-Erzeuger. Niemals feldweise übernehmen.
    reasons.push('anschrift_unvollstaendig_uebersprungen');
  }

  // --- Herstellername --------------------------------------------------
  for (const key of IDENTITY_KEYS) {
    const wert = regGpsr[key];
    if (isBlank(wert)) continue;
    const istMarkenname = Boolean(brand) && normalizeKeyish(wert) === normalizeKeyish(brand);
    const produktHatEigenenNamen = !isBlank(produkt[key]) && normalizeKeyish(produkt[key]) !== normalizeKeyish(wert);
    if (istMarkenname && produktHatEigenenNamen) {
      // Die Marke ist nicht der juristische Hersteller. "Weber" darf
      // "Weber-Stephen Deutschland GmbH" nicht ersetzen.
      reasons.push('markenname_als_hersteller_verworfen');
      continue;
    }
    setze(key, wert);
  }

  // --- Kontakt ---------------------------------------------------------
  for (const key of CONTACT_KEYS) setze(key, regGpsr[key]);

  // --- EU-Verantwortlicher ---------------------------------------------
  const landNachher = toCountryCode(apply.country_code || produkt.country_code) ||
    toCountryCode(apply.entity_country || produkt.entity_country);
  const euKeys = Object.keys(regGpsr).filter((k) => k.startsWith(EU_RESPONSIBLE_PREFIX));
  if (landNachher && EU_COUNTRY_CODES.has(landNachher)) {
    if (euKeys.some((k) => !isBlank(regGpsr[k]))) {
      // Sitzt der Hersteller in der EU, braucht das Produkt keinen
      // EU-Verantwortlichen. Einen fremden hineinzuschreiben ist der
      // Geaplan-Fall aus dem Vorfall.
      reasons.push('eu_vertreter_bei_eu_hersteller_uebersprungen');
    }
  } else {
    for (const key of euKeys) setze(key, regGpsr[key]);
  }

  // ERGEBNISKONTROLLE: Der Enforce darf niemals einen Datensatz HINTERLASSEN,
  // der sich selbst widerspricht — auch dann nicht, wenn Quelle und Ziel je
  // für sich stimmig waren. Genau so entstand der Vorfall: eine deutsche
  // Anschrift traf auf ein stehengebliebenes Sitzland "China".
  const ergebnis = { ...produkt, ...apply };
  if (!isInternallyConsistentGpsr(ergebnis)) {
    for (const key of MANUFACTURER_ADDRESS_KEYS) delete apply[key];
    reasons.push('ergebnis_waere_widerspruechlich');
    if (!isInternallyConsistentGpsr({ ...produkt, ...apply })) {
      // Auch ohne die Anschrift bleibt es widersprüchlich → gar nichts tun.
      return { apply: {}, blocked: true, level, reasons };
    }
  }

  return { apply, blocked: false, level, reasons };
}

module.exports = {
  planRegistryEnforce,
  registryEnforceLevel,
  findGpsrInconsistencies,
  isInternallyConsistentGpsr,
  countryHintsFromGpsr,
  productEvidenceBeatsRegistry,
  declaredCountryCode,
  toCountryCode,
  hasCompleteAddress,
  MANUFACTURER_ADDRESS_KEYS,
  REQUIRED_ADDRESS_KEYS,
  IDENTITY_KEYS,
  CONTACT_KEYS,
  EU_COUNTRY_CODES,
  STRONG_CONFIDENCE,
};
