/**
 * Server-Schranken für Massenaktionen an Aufträgen — hier gespiegelt, damit die
 * Oberfläche sie EINHÄLT statt sie zu erraten.
 *
 * Vorher wählte das Kopf-Häkchen alle gefilterten Aufträge (gemessen: 481) statt
 * der sichtbaren Seite. Jeder Statusknopf lief danach in die Server-Grenze und
 * brach komplett ab: kein Auftrag wurde umgestellt, die Auswahl blieb stehen,
 * jeder weitere Versuch scheiterte gleich. Die einzige Abhilfe war, 50 Zeilen
 * von Hand anzuhaken.
 *
 * BEWUSST KEIN automatisches Stückeln: ein Statuswechsel löst je Auftrag
 * Reservierungs-Freigabe, Bestands-Sync und Marktplatz-Meldung aus (CLAUDE.md
 * Punkt 10). Ein Lauf, der bei Block 6 von 10 abbricht, hinterlässt die Blöcke
 * 1–5 bereits umgestellt — schwerer zu durchschauen als eine klare Absage.
 *
 * Diese Werte sind ein SCHUTZ, kein Stilproblem: sie dürfen die Schranken im
 * Backend (`routes/orders.js`) niemals anheben oder angleichen.
 */
export const BULK_TRANSITION_LIMIT = 50;
export const ADDRESS_LABEL_LIMIT = 100;

/**
 * Gibt eine Meldung zurück, wenn die Auswahl zu groß ist — sonst `null`.
 * Die Meldung nennt Ist- und Grenzwert sowie die Aktion, damit klar ist,
 * welcher Knopf gemeint war.
 */
export function checkBulkLimit(count: number, limit: number, action: string): string | null {
  if (count <= limit) return null;
  return `${action}: höchstens ${limit} Aufträge auf einmal — aktuell ${count} ausgewählt. Bitte die Auswahl verkleinern.`;
}
