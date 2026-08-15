import React from "react";

type Props = {
  children: React.ReactNode;
  /** Voll überschreibbare Typo-Klassen (die Sichtbarkeits-Regel bleibt immer erhalten). */
  className?: string;
};

/**
 * Seitentitel, der NUR dort erscheint, wo die Topbar ihn nicht ohnehin zeigt.
 *
 * Die Topbar (`components/Topbar.tsx`, `VIEW_TITLES`) rendert den Seitennamen —
 * aber erst ab Desktop-Breite. Darunter läuft die mobile Leiste
 * (`components/Header.tsx`), die nur Nav-Icons hat; dort ist diese Überschrift
 * die einzige Orientierung. Der Breakpoint spiegelt exakt `App.tsx`:
 * `matchMedia('(max-width: 768px)')` = mobil, ab 769px übernimmt die Topbar.
 *
 * Für Abschnitts-Überschriften INNERHALB einer Seite nicht verwenden — die sind
 * keine Duplikate (siehe `PageHeader`).
 */
export const PageTitle: React.FC<Props> = ({
  children,
  className = "text-2xl font-bold text-txt-primary",
}) => <h1 className={`${className} min-[769px]:hidden`}>{children}</h1>;
