import type { WarehouseLotMetrics } from "../types";

/**
 * Darstellung der Los-Kennzahlen.
 *
 * BEWUSST ohne CSS-Klassen: tailwind.config.cjs scannt nur index.html, App.tsx,
 * index.tsx, components/** und hooks/** — eine className, die nur hier steht,
 * wird nie generiert und die Zelle bliebe unformatiert. Hier liegt reine
 * Rechen- und Formatierlogik, das Aussehen bleibt in der Komponente.
 */

/** Einheiten-Anzahl. `null` heisst UNBEKANNT und darf nie als 0 erscheinen. */
export const formatEinheiten = (wert: number | null | undefined): string => {
  if (wert === null || wert === undefined || !Number.isFinite(wert)) return "—";
  return wert.toLocaleString("de-DE");
};

/** Euro-Betrag. `null` = kein Einkaufsbetrag gepflegt, kein erfundener Wert. */
export const formatEuro = (wert: number | null | undefined): string => {
  if (wert === null || wert === undefined || !Number.isFinite(wert)) return "—";
  return wert.toLocaleString("de-DE", { style: "currency", currency: "EUR" });
};

/**
 * Warum ein Los keinen Wert zeigen kann — als Klartext fuer den Bediener.
 * `null`, wenn ein Wert ausgewiesen wird.
 */
export const losWertGrund = (metrics: WarehouseLotMetrics | null | undefined): string | null => {
  if (!metrics) return "Kennzahlen nicht geladen";
  if (metrics.einheitenErfasst <= 0) return "Keine Einlagerung im Lager-Journal";
  if (metrics.ekJeEinheitBrutto === null) return "Kein Einkaufsbetrag am Los gepflegt";
  return null;
};

/**
 * Selbstauskunft der Zeile. Die Bilanz muss aufgehen:
 *
 *   erfasst - verkauft - sonstige Abgaenge == Bestand
 *
 * Geht sie das nicht, ist die Bezugsmenge unsicher und damit auch jeder daraus
 * abgeleitete Wert. Das gehoert sichtbar an die Zeile — eine Zahl, die nicht
 * aufgeht, still auszuweisen ist genau die Klasse Fehler, die monatelang
 * niemand bemerkt.
 */
export const losBilanzHinweis = (metrics: WarehouseLotMetrics | null | undefined): string | null => {
  if (!metrics || metrics.stimmig) return null;

  const teile: string[] = [];
  if (metrics.differenz !== 0) {
    const richtung = metrics.differenz > 0 ? "mehr" : "weniger";
    teile.push(
      `Das Lager-Journal weist ${formatEinheiten(Math.abs(metrics.differenz))} Einheiten ${richtung} aus, als im Bestand stehen.`
    );
  }
  if (metrics.ausreisser > 0) {
    teile.push(
      `${formatEinheiten(metrics.ausreisser)} unplausible Buchung(en) wurden nicht mitgezaehlt (vermutlich eine Artikelnummer im Mengenfeld).`
    );
  }
  teile.push("Die Bezugsmenge und damit der Los-Wert sind hier nur ein Naeherungswert.");
  return teile.join(" ");
};

/**
 * Rechnet die geldwerten Felder nach, wenn der Einkaufsbetrag im Tabellenfeld
 * geaendert wurde.
 *
 * Warum lokal und nicht per Neuladen: die Zeile wird bewusst nur feldweise
 * gemerged (`{ ...l, ekBrutto }`) — ersetzt man sie durch eine Server-Antwort,
 * verliert sie `productCount`, und der Loeschen-Knopf haengt an
 * `productCount !== 0` und waere danach dauerhaft gesperrt.
 *
 * Die Mengen bleiben unberuehrt; der Einkaufsbetrag aendert nur ihre Bewertung.
 * Gerechnet wird als ANTEIL am Einkaufsbetrag — identisch zum Backend
 * (backend/lib/lot-metrics.js), damit Rest- und Abgangswert sich exakt auf den
 * EK summieren statt um die Rundung des Stueckpreises zu driften.
 */
export const mitNeuemEinkaufsbetrag = (
  metrics: WarehouseLotMetrics | null | undefined,
  ekBrutto: number | null
): WarehouseLotMetrics | null => {
  if (!metrics) return null;
  const basis = metrics.einheitenErfasst;
  const hatPreis = ekBrutto !== null && Number.isFinite(ekBrutto) && ekBrutto > 0 && basis > 0;
  const runde2 = (wert: number) => Math.round((wert + Number.EPSILON) * 100) / 100;
  const anteil = (menge: number) => (hatPreis ? runde2(((ekBrutto as number) * menge) / basis) : null);

  return {
    ...metrics,
    ekJeEinheitBrutto: hatPreis ? runde2((ekBrutto as number) / basis) : null,
    restwertBrutto: anteil(metrics.einheitenBestand),
    abgangswertBrutto: anteil(Math.max(0, metrics.einheitenVerkauft)),
  };
};

/** Anteil des Loses, der bereits verkauft ist — 0..1, `null` ohne Bezugsmenge. */
export const losAbverkaufsquote = (metrics: WarehouseLotMetrics | null | undefined): number | null => {
  if (!metrics || metrics.einheitenErfasst <= 0) return null;
  const quote = metrics.einheitenVerkauft / metrics.einheitenErfasst;
  if (!Number.isFinite(quote)) return null;
  return Math.min(1, Math.max(0, quote));
};
