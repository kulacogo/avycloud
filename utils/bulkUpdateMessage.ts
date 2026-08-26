// Meldungstext für "Listings aktualisieren" (eBay-Bulk-Revise).
//
// Vorfall 2026-08-26 (itemId 800315409133): eBay lehnte den Revise ab, weil
// der Artikel in einer Sonderaktion steckte. Der Grund stand im Backend-
// Ergebnis (results[].message), die Oberfläche zeigte aber nur die Zähler
// "0/1 · 1 fehlgeschlagen" — für den Bediener ununterscheidbar von einem
// Systemausfall. Diese Funktion baut Zähler UND Gründe/Hinweise zusammen.

export interface BulkUpdateZeile {
  ok?: boolean;
  skipped?: boolean;
  message?: string | null;
  warnings?: unknown[];
}

export interface BulkUpdateSummary {
  total: number;
  success: number;
  failed: number;
  skipped: number;
}

// Höchstens zwei Klartext-Details — mehr erschlägt die Leiste; der Überhang
// wird gezählt. Kürzung pro Detail, damit eine eBay-Langmeldung das Banner
// nicht sprengt.
const MAX_DETAILS = 2;
const MAX_DETAIL_LAENGE = 220;

export function baueBulkUpdateMeldung(
  summary: BulkUpdateSummary,
  rows?: BulkUpdateZeile[] | null
): string {
  const teile = [`Aktualisiert: ${summary.success}/${summary.total}`];
  if (summary.skipped > 0) teile.push(`${summary.skipped} übersprungen`);
  if (summary.failed > 0) teile.push(`${summary.failed} fehlgeschlagen`);

  const zeilen = Array.isArray(rows) ? rows : [];
  // Echte Fehlgründe (skipped = kein Produkt verknüpft → nur Zähler) …
  const gruende = zeilen
    .filter((r) => r && r.ok === false && !r.skipped && r.message)
    .map((r) => String(r.message));
  // … plus Warnhinweise ERFOLGREICHER Updates (z. B. "Preis nicht
  // aktualisiert: Sonderaktion") — sonst hält der Bediener den Preis für
  // gepusht, obwohl eBay ihn gesperrt hat.
  const hinweise = zeilen
    .flatMap((r) => (r && r.ok && Array.isArray(r.warnings) ? r.warnings : []))
    .map((w) => String(w))
    .filter(Boolean);

  const einmalig = Array.from(new Set([...gruende, ...hinweise]));
  const details = einmalig
    .slice(0, MAX_DETAILS)
    .map((t) => (t.length > MAX_DETAIL_LAENGE ? `${t.slice(0, MAX_DETAIL_LAENGE)}…` : t));
  const rest = einmalig.length - details.length;

  let meldung = teile.join(" · ");
  if (details.length) meldung += ` — ${details.join(" · ")}`;
  if (rest > 0) meldung += ` (+${rest} weitere)`;
  return meldung;
}
