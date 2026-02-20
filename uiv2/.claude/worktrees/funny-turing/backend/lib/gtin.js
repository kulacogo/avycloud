const GTIN_LENGTHS = [8, 12, 13, 14];
const EAN_LENGTH = 13;
const GTIN_LENGTH = 14;

const normalizeDigits = (value = '') => value.replace(/[^\d]/g, '');

const computeCheckDigit = (code = '') => {
  const digits = code.split('').map((char) => parseInt(char, 10));
  if (digits.some((digit) => Number.isNaN(digit))) {
    return null;
  }
  let sum = 0;
  for (let i = digits.length - 2, weightIdx = 0; i >= 0; i -= 1, weightIdx += 1) {
    const weight = weightIdx % 2 === 0 ? 3 : 1;
    sum += digits[i] * weight;
  }
  return (10 - (sum % 10)) % 10;
};

const isValidGtin = (value = '') => {
  if (!value) return false;
  const digitsOnly = normalizeDigits(value);
  if (!GTIN_LENGTHS.includes(digitsOnly.length)) {
    return false;
  }
  if (!/^\d+$/.test(digitsOnly)) {
    return false;
  }
  const expected = computeCheckDigit(digitsOnly);
  const actual = parseInt(digitsOnly.slice(-1), 10);
  return expected === actual;
};

const getGtinType = (value = '') => {
  const digitsOnly = normalizeDigits(value);
  switch (digitsOnly.length) {
    case 13:
      return 'ean13';
    case 14:
      return 'gtin14';
    case 12:
      return 'upc12';
    case 8:
      return 'ean8';
    default:
      return null;
  }
};

module.exports = {
  normalizeDigits,
  computeCheckDigit,
  isValidGtin,
  getGtinType,
  EAN_LENGTH,
  GTIN_LENGTH,
};

