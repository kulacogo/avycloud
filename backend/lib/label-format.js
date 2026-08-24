/**
 * Versandetikett-Zielformate je Transporteur.
 *
 * Betreiber-Vorgabe (2026-08-24): DHL und DPD werden auf 103 x 164 mm gedruckt,
 * Deutsche Post auf 62 x 100 mm. Das sind ZWEI verschiedene physische Rollen in
 * zwei verschiedenen Druckern — ein Etikett im falschen Format ist entweder
 * abgeschnitten (gross auf schmale Rolle) oder unnoetig winzig.
 *
 * SendCloud liefert das PDF in seinem eigenen Mass (label_printer ~ A6). Ohne
 * Normalisierung skaliert der Druckertreiber selbst, was Raender erzeugt und den
 * Barcode staucht. Diese Datei ist die EINZIGE Quelle fuer das Zielmass.
 *
 * Reine Entscheidung, kein Netz, kein Firestore — damit sie testbar ist.
 */

/** 103 x 164 mm — Paketrolle (DHL, DPD). */
const PARCEL_FORMAT = Object.freeze({
  key: 'parcel',
  widthMm: 103,
  heightMm: 164,
  /** Rolle des Druckers; der Druck-Agent bildet sie auf einen echten Drucker ab. */
  printerRole: 'parcel',
  displayName: 'Paketetikett 103 x 164 mm',
});

/** 62 x 100 mm — Briefrolle (Deutsche Post). */
const LETTER_FORMAT = Object.freeze({
  key: 'letter',
  widthMm: 62,
  heightMm: 100,
  printerRole: 'letter',
  displayName: 'Briefetikett 62 x 100 mm',
});

const LABEL_FORMATS = Object.freeze({
  parcel: PARCEL_FORMAT,
  letter: LETTER_FORMAT,
});

/**
 * Praefixe des `shippingOptionCode` (Teil vor dem Doppelpunkt).
 *
 * PRAEFIX, NIEMALS `includes()`. `'dp'` steckt in `'dpd'` — ein Teilstring-Test
 * schickt jedes DPD-Paket auf die Briefrolle. Genau dieser Fehler war der
 * Vorfall vom 2026-07-11 („DP-Wahl erzeugte DPD-Label").
 */
const OPTION_PREFIX_TO_FORMAT = Object.freeze({
  dp: 'letter',
  deutsche_post: 'letter',
  dhl_de: 'parcel',
  dhl: 'parcel',
  dhl_express: 'parcel',
  dpd: 'parcel',
});

/**
 * SendCloud `parcel.carrier.code`. Andere Schreibweisen als oben, deshalb eine
 * eigene Tabelle statt einer geteilten — eine Tabelle mit zwei Bedeutungen wird
 * beim naechsten Transporteur still falsch.
 */
const CARRIER_TO_FORMAT = Object.freeze({
  dhl: 'parcel',
  dhl_de: 'parcel',
  dhl_express: 'parcel',
  dhl_germany: 'parcel',
  dpd: 'parcel',
  dpd_de: 'parcel',
  deutsche_post: 'letter',
  deutschepost: 'letter',
  dp: 'letter',
});

const normalize = (value) => String(value == null ? '' : value).trim().toLowerCase();

/**
 * Praefix eines Versandprodukt-Codes: alles vor dem ersten Doppelpunkt.
 * `'dhl_de:dhl_paket'` -> `'dhl_de'`, `'dpd:classic'` -> `'dpd'`.
 */
function optionCodePrefix(shippingOptionCode) {
  const code = normalize(shippingOptionCode);
  if (!code) return '';
  const colon = code.indexOf(':');
  return colon === -1 ? code : code.slice(0, colon);
}

/**
 * Zielformat fuer eine Sendung.
 *
 * Reihenfolge bewusst: der `shippingOptionCode` ist die genauere Angabe (er
 * benennt das gebuchte Produkt), der Transporteur-Code nur die groebere. Nur
 * wenn beide schweigen, gibt es KEIN Zielformat.
 *
 * @param {{ shippingOptionCode?: string|null, carrier?: string|null }} input
 * @returns {{key: string, widthMm: number, heightMm: number, printerRole: string, displayName: string}|null}
 *   `null` = unbekannt. Dann wird NICHT skaliert und das Original durchgereicht.
 *   Ein unveraendertes Etikett ist immer noch ein brauchbares Etikett; ein
 *   geratenes Format kann ein unlesbares erzeugen.
 */
function resolveLabelFormat(input = {}) {
  const prefix = optionCodePrefix(input.shippingOptionCode);
  if (prefix && OPTION_PREFIX_TO_FORMAT[prefix]) {
    return LABEL_FORMATS[OPTION_PREFIX_TO_FORMAT[prefix]];
  }

  const carrier = normalize(input.carrier);
  if (carrier && CARRIER_TO_FORMAT[carrier]) {
    return LABEL_FORMATS[CARRIER_TO_FORMAT[carrier]];
  }

  return null;
}

/**
 * Notbremse. Nur der exakte Wert `'off'` schaltet die Normalisierung ab —
 * gleiche Strenge wie bei `AUTO_INVOICE`/`MARKETPLACE_REFUND_PUSH`: ein
 * Tippfehler in der Konfiguration darf das Druckbild nicht still veraendern.
 */
function labelExactSizeEnabled() {
  return normalize(process.env.LABEL_EXACT_SIZE) !== 'off';
}

module.exports = {
  PARCEL_FORMAT,
  LETTER_FORMAT,
  LABEL_FORMATS,
  optionCodePrefix,
  resolveLabelFormat,
  labelExactSizeEnabled,
};
