import type { EbayListingSyncHealth } from "../api/client";

/**
 * Banner-Text für den eBay-Angebots-Abgleich (Vorfall 2026-10-08).
 *
 * Vorher zeigte ein gestörter Abgleich IMMER „eBay neu verbinden" — auch wenn
 * nur das eBay-Tageskontingent (5.000 Trading-Aufrufe) leer war. Neu
 * verbinden heilt kein Kontingent; der Bediener muss wissen, ob er warten
 * (Reset 09:00 Uhr MESZ) oder die Anmeldung erneuern soll.
 *
 * Reine Funktion, getestet mit node --test.
 */

export type EbaySyncBanner =
  | { kind: "none" }
  | {
      kind: "quota" | "broken";
      title: string;
      lines: string[];
      showReconnect: boolean;
    };

function formatDe(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
}

export function describeEbayListingSync(sync: EbayListingSyncHealth | null | undefined): EbaySyncBanner {
  if (!sync || sync.healthy !== false) return { kind: "none" };

  const lastOk = formatDe(sync.lastSuccessAtIso);
  const lastOkLine = lastOk
    ? `Letzter erfolgreicher Abruf: ${lastOk}.`
    : "Es gab noch keinen erfolgreichen Abruf.";

  if (sync.errorKind === "quota") {
    const budget = sync.budget || null;
    const reset = formatDe(budget?.resetAtIso ?? null);
    const lines: string[] = [`${lastOkLine} Die angezeigten eBay-Angebote können veraltet sein.`];
    if (budget && typeof budget.remaining === "number") {
      lines.push(`Rest des Tageskontingents: ${budget.remaining} von ${budget.limit} Aufrufen.`);
    }
    // Kontingent WIEDER FREI (Stufe ok, z. B. direkt nach dem Reset): der
    // Abgleich holt beim nächsten Takt nach — kein Folgetags-Reset nennen.
    if (budget != null && budget.level === "ok") {
      lines.push("Das Kontingent ist wieder frei; der Angebots-Abgleich holt beim nächsten Takt (spätestens in 15 Minuten) von selbst nach. Neu verbinden hilft hier nicht.");
      return { kind: "quota", title: "eBay-Kontingent wieder frei", lines, showReconnect: false };
    }
    // Nur PAUSIERT (Reserve für die kritischen Aufrufe erreicht, Kontingent
    // aber nicht leer): das ist Absicht, kein Ausfall — und so steht es da.
    if (budget != null && budget.level === "tight") {
      lines.push(
        `Der Rest ist für Oversell-Schutz, Auftrags-Import und Versandmeldungen reserviert; der Angebots-Abgleich läuft ${reset ? `nach dem Reset um ${reset}` : "nach dem täglichen Reset (Mitternacht US-Pazifik, in Deutschland 08:00 oder 09:00 Uhr)"} von selbst weiter. Neu verbinden hilft hier nicht.`
      );
      return { kind: "quota", title: "eBay-Abgleich pausiert (Tagesbudget geschont)", lines, showReconnect: false };
    }
    lines.push(
      reset
        ? `eBay setzt das Kontingent um ${reset} zurück; der Abgleich läuft danach von selbst weiter. Neu verbinden hilft hier nicht.`
        : "eBay setzt das Kontingent täglich um Mitternacht US-Pazifik zurück (in Deutschland 08:00 oder 09:00 Uhr, je nach Sommerzeit); der Abgleich läuft danach von selbst weiter. Neu verbinden hilft hier nicht."
    );
    return { kind: "quota", title: "eBay-Tageskontingent erschöpft", lines, showReconnect: false };
  }

  const lines: string[] = [`${lastOkLine} Die angezeigten eBay-Angebote können veraltet sein.`];
  if (sync.lastError?.message) lines.push(`Letzter Fehler: ${sync.lastError.message}`);
  // „Neu verbinden" nur, wenn es plausibel hilft: bei Anmeldefehlern — und bei
  // Alt-Antworten ohne Fehlertyp (Abwärtskompatibilität). Bei Netz-/eBay-
  // Fehlern oder blossem Altern (Worker stand) heilt ein neuer Token nichts;
  // der Knopf würde nur Vertrauen kosten (Gegenlese).
  const showReconnect = sync.errorKind === "auth" || sync.errorKind === undefined;
  if (!showReconnect) {
    lines.push("Hält der Zustand länger als eine Stunde an: Shop-Gesundheit und Protokoll prüfen; die eBay-Verbindung selbst ist nicht die Ursache.");
  }
  return {
    kind: "broken",
    title: "Angebots-Abgleich mit eBay gestört",
    lines,
    showReconnect,
  };
}
