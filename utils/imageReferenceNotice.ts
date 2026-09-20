export function describeImageReferenceIssue(reason: string): string | null {
  if (reason === "recherche_missing_views") return "Nur recherchierte Produktansichten werden aufbereitet; unbelegte Perspektiven und Szenen bleiben aus";
  if (reason === "recherche_identity_missing") return "Modell nicht eindeutig identifiziert. Lesbares Kartonetikett mit Hersteller-Artikelnummer oder EAN ergänzen";
  if (reason === "recherche_identity_conflict") return "Kartonbeschriftung und Produktdaten widersprechen sich. Modell und Variante prüfen";
  if (reason === "recherche_no_verified_match") return "Keine Web-Produktbilder mit bestätigtem Modell und passender Variante gefunden";
  if (reason === "recherche_unavailable") return "Web-Recherche derzeit nicht verfügbar. Bitte erneut versuchen";
  if (reason === "recherche_timeout") return "Web-Recherche konnte im Zeitlimit keinen passenden Bildbeleg bestätigen. Bitte erneut versuchen";
  if (reason === "referenz_laden_fehlgeschlagen") return "Bild konnte nicht geladen werden; es wurde nicht von der KI bewertet";
  if (reason === "vorlagen_nicht_vollstaendig_geladen") return "Referenzbilder konnten nicht vollständig geladen werden. Bitte Bildzugriff prüfen und erneut starten";
  if (reason === "keine_brauchbare_vorlage") return "Unter den geladenen Bildern wurde keine geeignete Produktansicht erkannt. Ein klares Produktbild aus dem Web oder ein eigenes Foto verwenden";
  return null;
}

export function imageReferenceNextStep(entries: Array<{ reason: string }>): string {
  if (entries.some(e => e.reason.startsWith("recherche_"))) {
    return entries.some(e => /recherche_(unavailable|timeout)/.test(e.reason))
      ? "Erneut starten oder ein passendes Web-Produktbild ergänzen."
      : "Lesbares Kartonetikett und genaue Variante ergänzen oder ein passendes Web-Produktbild hinterlegen. Aufbau ist nicht erforderlich.";
  }
  return entries.some(e => e.reason === "referenz_laden_fehlgeschlagen" || e.reason === "vorlagen_nicht_vollstaendig_geladen")
    ? "Nicht erreichbare Bildquellen prüfen und erneut starten. Alternativ das betreffende Produktbild hochladen."
    : "Fehlende Produkt- oder Detailansichten als Foto oder passende Web-Bild-URL ergänzen.";
}
