/** Empty is allowed only when research produced no existing sale price. */
export function validateCaptureSellPrice(value: string, existingPrice?: number): { amount?: number; error?: string } {
  if (!value.trim() && !(Number(existingPrice) > 0)) return {};
  const amount = Number(value);
  if (!value.trim() || !Number.isFinite(amount) || amount < 0.01 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001) {
    return { error: "Bitte einen Verkaufspreis größer als 0 € mit höchstens zwei Nachkommastellen eingeben." };
  }
  return { amount };
}
