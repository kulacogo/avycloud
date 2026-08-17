
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/main.css';
import { I18nProvider } from './i18n';
import HelpProvider from './components/help/HelpProvider';
import { sollNeuLaden, meldeErfolgreichenStart } from './utils/chunkReload';
import { ErrorBoundary } from './components/ErrorBoundary';
import { VersionsHinweis } from './components/VersionsHinweis';
import HelpButton from './components/help/HelpButton';

/**
 * Zweiter Weg fuer fehlende Programmteile nach einer Veroeffentlichung.
 *
 * Der ErrorBoundary faengt nur, was WAEHREND des Zeichnens passiert. Ein
 * nachgeladener Teil, der aus einem Klick heraus angefordert wird, scheitert
 * dagegen als unbehandelte Zusage — davon sieht der ErrorBoundary nichts, und
 * fuer den Menschen passiert einfach gar nichts.
 *
 * Beide Wege enden in derselben Regel (utils/chunkReload.ts) samt
 * Schleifenschutz.
 */
// STRENG pruefen: hier landen auch JSON-Fehler aus Klick-Handlern, und V8
// meldet JSON.parse auf eine HTML-Fehlerseite wortgleich als
// "Unexpected token '<'". Ohne die strenge Pruefung wuerde eine
// Backend-Stoerung die Seite neu laden und "Neue Version" behaupten.
window.addEventListener('unhandledrejection', (event) => {
  if (sollNeuLaden(event.reason, { streng: true })) {
    event.preventDefault();
    window.location.reload();
  }
});

// Vite meldet einen fehlgeschlagenen VORLADE-Versuch ueber ein eigenes
// Ereignis. Es ist eindeutig (nur Nachladen loest es aus) und schliesst damit
// die Luecke, die die strenge Pruefung oben bewusst offen laesst: ein
// Chunk-Fehler ausserhalb des Zeichnens traegt in Chrome denselben Wortlaut
// wie ein JSON-Fehler und wird dort deshalb nicht erfasst.
//
// KEIN preventDefault: sonst reicht Vite den Fehler nicht weiter, die
// Fehlergrenze saehe nichts mehr und der Bereich bliebe einfach leer.
window.addEventListener('vite:preloadError', (event) => {
  if (sollNeuLaden((event as unknown as { payload?: unknown }).payload || event)) {
    window.location.reload();
  }
});

// Auch ein klassischer Ladefehler eines <script type="module"> meldet sich hier.
window.addEventListener('error', (event) => {
  if (sollNeuLaden((event as ErrorEvent).error || (event as ErrorEvent).message, { streng: true })) {
    window.location.reload();
  }
});

const container = document.getElementById('root');
if (container) {
  const root = ReactDOM.createRoot(container);
  root.render(
    <React.StrictMode>
      <I18nProvider>
        <App />
        {/* Hilfe und Versions-Hinweis sind Beiwerk und liegen AUSSERHALB der
            Fehlergrenze in App. Faellt hier etwas aus (z. B. ein fehlender
            Programmteil des Hilfe-Fensters), haengt React sonst den kompletten
            Wurzelknoten aus: weisse Seite, keine Meldung, kein Knopf.
            Deshalb eine eigene Grenze, die im Fehlerfall schlicht nichts zeigt. */}
        <ErrorBoundary fallback={null}>
          <HelpButton />
          <HelpProvider />
          <VersionsHinweis />
        </ErrorBoundary>
      </I18nProvider>
    </React.StrictMode>
  );
  // Der Neulade-Zaehler darf NICHT hier zurueckgesetzt werden: das Nachladen
  // einer Datei ist immer asynchron, das Zuruecksetzen liefe also stets VOR
  // dem Fehler — der Schutz existierte nur auf dem Papier. meldeErfolgreichen-
  // Start plant stattdessen einen Timer und loescht erst nach nachgewiesen
  // gesundem Betrieb (siehe utils/chunkReload.ts).
  meldeErfolgreichenStart();
} else {
  console.error('Failed to find the root element');
}

// PWA/Service-Worker ist noch nicht fertig: /service-worker.js existiert nicht,
// die Registrierung liefert HTML (Firebase-SPA-Rewrite) und scheitert. Ein
// bereits (frueher) installierter, kaputter Worker kann fetch-Requests abfangen
// und dabei den Authorization-Header verlieren → alle API-Calls 401. Deshalb:
// NICHT registrieren, sondern jeden vorhandenen Worker + dessen Caches aktiv
// abmelden, bis die PWA-Arbeit abgeschlossen ist.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.getRegistrations()
      .then((regs) => regs.forEach((r) => r.unregister().catch(() => {})))
      .catch(() => {});
    if (typeof caches !== 'undefined' && caches.keys) {
      caches.keys()
        .then((keys) => keys.forEach((k) => caches.delete(k).catch(() => {})))
        .catch(() => {});
    }
  });
}
