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

