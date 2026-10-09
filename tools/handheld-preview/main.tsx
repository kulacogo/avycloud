import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import MobileOperationsView from '../../components/MobileOperationsView';
import { OperationsView } from '../../components/OperationsView';
import HandheldHome from '../../components/HandheldHome';
import { I18nProvider } from '../../i18n';
import { products } from './fixtures';
import '../../styles/main.css';
function Preview() {
  const [view, setView] = useState('home');
  return <I18nProvider><div className="bg-app-bg text-txt-primary min-h-screen">
    <header className="h-16 flex items-center justify-between px-4 border-b border-app-border"><b>avycloud</b><button aria-label="Farbschema wechseln" onClick={() => document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'}>◐</button></header>
    <main className="p-4">{new URLSearchParams(location.search).has('desktop') ? <OperationsView products={products as any} onProductUpdate={() => {}} /> : view === 'home' ? <HandheldHome onNavigate={setView} /> : <MobileOperationsView products={products as any} mode={view as any} onNavigate={setView as any} />}</main>
    <nav className="fixed bottom-0 inset-x-0 h-16 bg-app-surface border-t border-app-border flex justify-around items-center"><button onClick={() => setView('home')}>Übersicht</button><button onClick={() => setView('operations')}>Operationen</button></nav>
  </div></I18nProvider>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
