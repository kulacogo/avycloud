import React, { useEffect, useState } from "react";

import { starteVersionsUeberwachung, eigeneEinstiegsdatei } from "../utils/versionWatch";
import { meldeErfolgreichenStart } from "../utils/chunkReload";

/**
 * Unaufdringlicher Hinweis, dass eine neuere Fassung von avycloud online ist.
 *
 * Ohne diesen Hinweis merkt man eine Veröffentlichung erst, wenn ein
 * Programmteil fehlt — und dann ist es schon passiert (siehe Vorfall
 * 17.08.2026: sechs Veröffentlichungen in 25 Minuten, „Unexpected token '<'").
 *
 * Bewusst KEIN automatisches Neuladen: Ein offenes Datenblatt mit
 * ungespeicherten Änderungen ginge sonst ohne Rückfrage verloren. Der Mensch
 * entscheidet, wann es passt.
 */
export const VersionsHinweis: React.FC = () => {
  const [neueFassung, setNeueFassung] = useState(false);
  const [weggeklickt, setWeggeklickt] = useState(false);

  useEffect(() => {
    // Im Entwicklungsserver gibt es keine Prüfsummen — dort schlüge der
    // Wächter dauernd an.
    if (!import.meta.env.PROD) return;
    // Aus dem Dokument gelesen, nicht aus import.meta.url — welcher
    // Programmteil diesen Code aufnimmt, entscheidet das Bauwerkzeug.
    const eigeneDatei = eigeneEinstiegsdatei();
    return starteVersionsUeberwachung(() => setNeueFassung(true), { eigeneDatei });
  }, []);

  if (!neueFassung || weggeklickt) return null;

  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-3 rounded-xl border border-app-border bg-app-elevated px-4 py-3 shadow-xl"
      role="status"
      aria-live="polite"
    >
      <span className="text-sm text-txt-primary">Es gibt eine neuere Fassung von avycloud.</span>
      <button
        type="button"
        onClick={() => {
          // Ein Klick des Menschen darf den Neulade-Zähler zurücksetzen.
          meldeErfolgreichenStart({ sofort: true });
          window.location.reload();
        }}
        className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:bg-accent/80 transition-colors"
      >
        Jetzt neu laden
      </button>
      <button
        type="button"
        onClick={() => setWeggeklickt(true)}
        aria-label="Hinweis ausblenden"
        className="text-txt-muted hover:text-txt-primary transition-colors px-1"
      >
        ✕
      </button>
    </div>
  );
};

export default VersionsHinweis;
