export const normalizeBarcode = (value: string): string =>
  (value || '').replace(/[^\d]/g, '');

const GTIN_LENGTHS = [8, 12, 13, 14];

const computeCheckDigit = (code: string): number => {
  const digits = code.split('').map((char) => parseInt(char, 10));
  if (digits.some((digit) => Number.isNaN(digit))) {
    return -1;
  }
  let sum = 0;
  for (let i = digits.length - 2, weightIdx = 0; i >= 0; i -= 1, weightIdx += 1) {
    const weight = weightIdx % 2 === 0 ? 3 : 1;
    sum += digits[i] * weight;
  }
  return (10 - (sum % 10)) % 10;
};

export const isValidGtin = (value?: string | null): boolean => {
  if (!value) return false;
  const digits = normalizeBarcode(value);
  if (!GTIN_LENGTHS.includes(digits.length)) {
    return false;
  }
  if (!/^\d+$/.test(digits)) {
    return false;
  }
  const expected = computeCheckDigit(digits);
  const actual = parseInt(digits.slice(-1), 10);
  return expected === actual;
};

export const isValidEan13 = (value?: string | null): boolean => {
  const digits = normalizeBarcode(value || '');
  return digits.length === 13 && isValidGtin(digits);
};

export const isValidGtin14 = (value?: string | null): boolean => {
  const digits = normalizeBarcode(value || '');
  return digits.length === 14 && isValidGtin(digits);
};

export type GtinType = "ean13" | "ean8" | "upc12" | "gtin14" | null;

export const getGtinType = (value?: string | null): GtinType => {
  const digits = normalizeBarcode(value || "");
  if (!isValidGtin(digits)) return null;
  switch (digits.length) {
    case 13: return "ean13";
    case 14: return "gtin14";
    case 12: return "upc12";
    case 8: return "ean8";
    default: return null;
  }
};

export const getGtinLabel = (value?: string | null): string => {
  const type = getGtinType(value);
  switch (type) {
    case "ean13": return "EAN";
    case "ean8": return "EAN-8";
    case "upc12": return "UPC";
    case "gtin14": return "GTIN-14";
    default: return "Barcode";
  }
};

export type IdentifierField = "ean" | "upc" | "gtin";

// Erlaubte Stellenzahlen je kanonischem Feld (GS1). Spiegelt backend/lib/product-identifiers.js.
const IDENTIFIER_FIELD_LENGTHS: Record<IdentifierField, number[]> = {
  ean: [13, 8],
  upc: [12],
  gtin: [14],
};

export const identifierFieldLabel: Record<IdentifierField, string> = {
  ean: "EAN",
  upc: "UPC",
  gtin: "GTIN",
};

export type IdentifierValidation = {
  ok: boolean;
  empty: boolean;
  reason?: "length" | "checkdigit";
  expected: number[];
};

// Validiert einen Wert, der gezielt in ein Feld (EAN/UPC/GTIN) getippt wurde.
// Leer = ok (Feld leeren). Sonst exakte Stellenzahl + Prüfziffer.
export const validateIdentifierField = (
  field: IdentifierField,
  value?: string | null
): IdentifierValidation => {
  const digits = normalizeBarcode(value || "");
  const expected = IDENTIFIER_FIELD_LENGTHS[field];
  if (!digits) return { ok: true, empty: true, expected };
  if (!expected.includes(digits.length)) return { ok: false, empty: false, reason: "length", expected };
  if (!isValidGtin(digits)) return { ok: false, empty: false, reason: "checkdigit", expected };
  return { ok: true, empty: false, expected };
};

// Ordnet eine rohe Barcode-Liste den drei Feldern nach Stellenzahl zu (erster Treffer).
export const classifyBarcodesByLength = (codes: string[] = []): Record<IdentifierField, string> => {
  const norm = Array.from(new Set(codes.map(normalizeBarcode).filter(Boolean)));
  return {
    ean: norm.find((c) => c.length === 13 || c.length === 8) || "",
    upc: norm.find((c) => c.length === 12) || "",
    gtin: norm.find((c) => c.length === 14) || "",
  };
};

export const summarizeBarcodes = (values: string[] = []) => {
  const normalized = Array.from(
    new Set(
      values
        .map((value) => normalizeBarcode(value))
        .filter((value) => value.length > 0)
    )
  );
  const valid = normalized.filter((value) => isValidGtin(value));
  const ean = valid.find((value) => value.length === 13) || null;
  const gtin = valid.find((value) => value.length === 14) || null;
  const upc = valid.find((value) => value.length === 12) || null;
  const primaryBarcode = ean || upc || gtin || valid[0] || null;
  const primaryLabel = primaryBarcode ? getGtinLabel(primaryBarcode) : null;
  return {
    all: normalized,
    valid,
    ean,
    gtin,
    upc,
    primaryBarcode,
    primaryLabel,
    hasValid: valid.length > 0,
  };
};

