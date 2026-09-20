export function describeImageReferenceIssue(reason: string): string | null {
  if (reason === "referenz_laden_fehlgeschlagen") return "Bild konnte nicht geladen werden; es wurde nicht von der KI bewertet";
  if (reason === "vorlagen_nicht_vollstaendig_geladen") return "Referenzbilder konnten nicht vollständig geladen werden. Bitte Bildzugriff prüfen und erneut starten";
  if (reason === "keine_brauchbare_vorlage") return "Unter den geladenen Bildern wurde keine geeignete Produktansicht erkannt. Ein klares Produktbild aus dem Web oder ein eigenes Foto verwenden";
  return null;
}

export function imageReferenceNextStep(entries: Array<{ reason: string }>): string {
  return entries.some(e => e.reason === "referenz_laden_fehlgeschlagen" || e.reason === "vorlagen_nicht_vollstaendig_geladen")
    ? "Nicht erreichbare Bildquellen prüfen und erneut starten. Alternativ das betreffende Produktbild hochladen."
    : "Fehlende Produkt- oder Detailansichten als Foto oder passende Web-Bild-URL ergänzen.";
}
