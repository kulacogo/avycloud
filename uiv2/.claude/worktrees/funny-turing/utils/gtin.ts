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
  return {
    all: normalized,
    valid,
    ean,
    gtin,
    hasValid: valid.length > 0,
  };
};

