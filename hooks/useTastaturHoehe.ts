import { useEffect } from "react";

/**
 * Meldet die Höhe der Android-Bildschirmtastatur als CSS-Variable
 * `--tastatur-hoehe` am Wurzelelement.
 *
 * WOZU: In Pick/Pack/Stow lässt sich die Tastatur nicht immer verhindern — ein
 * IME-Scanner (NETUM Q900) braucht das fokussierte, beschreibbare Fangfeld, und
 * genau dafür zeichnet Android sie. Wo sie bleiben muss, soll sie wenigstens
 * nichts verdecken: der Ziffernblock klebt dann ÜBER der Tastatur statt
 * dahinter zu verschwinden.
 *
 * Es gibt keine CSS-Abfrage für „Tastatur offen". Die einzige verlässliche
 * Quelle ist `window.visualViewport`: die Differenz zwischen Fensterhöhe und
 * sichtbarem Bereich ist genau der verdeckte Teil.
 */
export function useTastaturHoehe(aktiv: boolean = true): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const wurzel = document.documentElement;

    const zuruecksetzen = () => wurzel.style.setProperty("--tastatur-hoehe", "0px");

    if (!aktiv) {
      zuruecksetzen();
      return;
    }

    const sicht = window.visualViewport;
    if (!sicht) {
      // Älterer Browser ohne die Schnittstelle: nichts versprechen, was wir
      // nicht messen können — 0 lässt den Block am unteren Rand wie bisher.
      zuruecksetzen();
      return;
    }

    const messen = () => {
      const verdeckt = window.innerHeight - sicht.height - sicht.offsetTop;
      // Kleine Abweichungen entstehen durch Adressleisten und Rundung. Erst ab
      // einer echten Tastaturhöhe reagieren, sonst zappelt der Block beim
      // Scrollen.
      const hoehe = verdeckt > 120 ? Math.round(verdeckt) : 0;
      wurzel.style.setProperty("--tastatur-hoehe", `${hoehe}px`);
    };

    messen();
    sicht.addEventListener("resize", messen);
    sicht.addEventListener("scroll", messen);
    return () => {
      sicht.removeEventListener("resize", messen);
      sicht.removeEventListener("scroll", messen);
      zuruecksetzen();
    };
  }, [aktiv]);
}

export default useTastaturHoehe;
