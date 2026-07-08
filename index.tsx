
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/main.css';
import { I18nProvider } from './i18n';
import HelpProvider from './components/help/HelpProvider';
import HelpButton from './components/help/HelpButton';

const container = document.getElementById('root');
if (container) {
  const root = ReactDOM.createRoot(container);
  root.render(
    <React.StrictMode>
      <I18nProvider>
        <App />
        <HelpButton />
        <HelpProvider />
      </I18nProvider>
    </React.StrictMode>
  );
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
