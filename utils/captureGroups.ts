/**
 * Erkennt, ob sich die bestätigte Gruppierung im Erfassen-Assistenten
 * tatsächlich geändert hat.
 *
 * Hintergrund: "Zurück" aus dem Prüfen-Schritt hängte den Analyse-Schritt aus
 * und beim Zurückkommen sofort wieder ein. Sein Startschutz lag in einem Ref,
 * das mit der Instanz stirbt — also lief die KI-Erkennung ohne Knopfdruck und
 * ohne Rückfrage erneut. Folge: alle eingetippten Korrekturen wurden durch
 * frische KI-Werte ersetzt, und weil `/api/v2/identify` das Ergebnis immer
 * speichert, lag anschließend ein Doppel-Produkt im Katalog.
 *
 * Die Signatur beantwortet die einzige Frage, die zählt: hat der Mensch an der
 * Gruppierung etwas geändert? Nur dann ist ein zweiter Erkennungslauf gewollt.
 * Die Reihenfolge der Bilder innerhalb einer Gruppe zählt bewusst NICHT als
 * Änderung — sie hat auf die Erkennung keinen Einfluss.
 */
export interface SignableGroup {
  id: string;
  label: string;
  barcodes: string;
  hint?: string | null;
  images: Array<{ name: string; size: number; lastModified: number }>;
}

export function groupsSignature(groups: SignableGroup[]): string {
  const parts = (groups || []).map((g) => {
    const bilder = (g.images || [])
      .map((f) => `${f.name}:${f.size}:${f.lastModified}`)
      .sort()
      .join("|");
    return [g.id, g.label, (g.barcodes || "").trim(), (g.hint || "").trim(), bilder].join("~");
  });
  return `${parts.length}#${parts.join("§")}`;
}
