import type { LowestPrice } from "../types";

/** Kennzeichnet den von Hand eingetragenen Marktpreis in der Quellenliste. */
export const MANUAL_SOURCE_URL = "manual://ui";

function safeCurrency(code?: string): string {
  const c = (code || "").toString().trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : "EUR";
}

/**
 * Übernimmt eine Eingabe aus dem Feld "Marktpreis (niedrigster)".
 *
 * Gibt `null` zurück, wenn sich nichts geändert hat — der Aufrufer schreibt
 * dann NICHTS. Das ist der Kern der Reparatur: `onBlur` feuert bei jedem
 * Fokusverlust, auch beim bloßen Durchtabben. Vorher baute jeder dieser
 * Fokusverluste `lowest_price` neu auf und ersetzte die recherchierten Belege
 * durch einen einzigen Eintrag "Manuell" — die Preisrecherche war weg, sobald
 * jemand im Bearbeiten-Modus am Feld vorbeikam.
 *
 * Bei einer ECHTEN Änderung bleiben die recherchierten Quellen stehen. Sie
 * tragen ihren eigenen Preis und ihr eigenes Prüfdatum, damit bleibt erkennbar,
 * dass sie zu einem älteren Stand gehören. Auch `last_checked_iso` bleibt
 * unangetastet: eine Handeingabe ist keine Preisprüfung.
 */
export function applyManualMarketPrice(
  current: LowestPrice | undefined,
  rawValue: string
): LowestPrice | null {
  const parsed = parseFloat(String(rawValue ?? "").replace(",", "."));
  const currentAmount = typeof current?.amount === "number" && Number.isFinite(current.amount) ? current.amount : 0;

  // Leeres oder unlesbares Feld ist keine Ansage "der Marktpreis ist 0".
  if (!Number.isFinite(parsed)) return null;

  const amount = Math.round(parsed * 100) / 100;
  if (amount === currentAmount) return null;

  const researched = (current?.sources || []).filter((s) => s && s.url !== MANUAL_SOURCE_URL);

  return {
    amount,
    currency: safeCurrency(current?.currency),
    sources: [
      { name: "Manuell", url: MANUAL_SOURCE_URL, price: amount, checked_at: new Date().toISOString() },
      ...researched,
    ],
    last_checked_iso: current?.last_checked_iso,
  };
}
