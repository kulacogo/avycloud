import { useEffect, useRef } from "react";

import { scrollListToTop, shouldScrollToTop } from "../utils/listPaging";

/**
 * Nach dem Blättern oben in der Liste stehen.
 *
 * Fünf Ansichten haben je eine eigene Paginierung; alle ließen die
 * Bildlaufposition beim Seitenwechsel stehen. Wer am Fuß der Tabelle auf
 * "Weiter" klickt, landet mitten in der neuen Seite und muss von Hand hoch,
 * um zu sehen, was gekommen ist.
 *
 * Rückgabe ist ein Anker, den die Ansicht an den Listenanfang hängt
 * (`<div ref={listeOben} />`). Ohne Anker wird der Seitenanfang angesteuert.
 */
export function useListPaging<T extends HTMLElement = HTMLDivElement>(page: number) {
  const anchorRef = useRef<T | null>(null);
  const previousPage = useRef<number | null>(null);

  useEffect(() => {
    if (shouldScrollToTop(previousPage.current, page)) {
      scrollListToTop(anchorRef.current);
    }
    previousPage.current = page;
  }, [page]);

  return anchorRef;
}
