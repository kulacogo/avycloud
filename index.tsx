
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/main.css';
import { I18nProvider } from './i18n';
import { InventoryProvider } from './context/InventoryContext';

const container = document.getElementById('root');
if (container) {
  const root = ReactDOM.createRoot(container);
  root.render(
    <React.StrictMode>
      <I18nProvider>
        <InventoryProvider>
          <App />
        </InventoryProvider>
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
