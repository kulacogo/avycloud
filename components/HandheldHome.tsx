import React, { useEffect, useState } from 'react';
import { fetchOperationalMetrics, fetchPickWork, type OperationalMetrics } from '../api/client';
import { useAuth } from '../context/AuthContext';
import type { Order } from '../types';
import { PageTitle } from './ui/PageTitle';
import './operations/handheld.css';

export default function HandheldHome({ onNavigate }: { onNavigate: (view: string) => void }) {
  const { hasPermission } = useAuth();
  const [metrics, setMetrics] = useState<OperationalMetrics | null>(null);
  const [current, setCurrent] = useState<Order | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const [next, work] = await Promise.all([fetchOperationalMetrics({ preset: 'today' }),
          hasPermission('orders', 'pick') ? fetchPickWork() : Promise.resolve(null)]);
        if (!stopped) { setMetrics(next); setCurrent(work); setError(false); }
      } catch { if (!stopped) setError(true); }
    };
    void refresh();
    const timer = window.setInterval(refresh, 30000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [hasPermission]);
  const resumable = current?.pickWork && ['confirmed', 'picking'].includes(current.omsStatus || current.status);
  return <section className="handheld-home">
    <PageTitle>Übersicht</PageTitle>
    <div className="handheld-home-status"><span>Heute versendet</span><b>{metrics?.live.shipped_today ?? '—'}</b></div>
    {error && <p role="alert" className="text-danger">Zahlen gerade nicht aktuell</p>}
    {resumable && <button className="handheld-secondary text-left" onClick={() => onNavigate('operations-pick')}>
      Auftrag fortsetzen <span className="block text-sm text-txt-secondary">{current.marketplaceOrderId || current.number}</span>
    </button>}
    <div className="handheld-home-actions">
      {hasPermission('orders', 'pick') && <button onClick={() => onNavigate('operations-pick')}>
        <strong className="text-accent">{metrics?.statusCounts.confirmed ?? '—'}</strong><span>Picken →</span><small>Aufträge bereit</small>
      </button>}
      {hasPermission('orders', 'pack') && <button onClick={() => onNavigate('operations-pack')}>
        <strong className="text-success">{metrics?.statusCounts.picked ?? '—'}</strong><span>Packen →</span><small>Aufträge bereit</small>
      </button>}
    </div>
  </section>;
}
