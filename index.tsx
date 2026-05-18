
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

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js')
      .catch((err) => console.error('Service worker registration failed:', err));
  });
}
