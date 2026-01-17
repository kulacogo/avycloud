import React, { useEffect, useMemo, useState } from 'react';
import { DashboardMetrics, Product, WarehouseLayout } from '../types';
import { fetchDashboardMetrics, fetchWarehouseZones } from '../api/client';
import { WarehouseIcon, TableIcon, SyncIcon } from './icons/Icons';
import { getProductAvailableQuantity, getProductPhysicalQuantity, getProductReservedQuantity, normalizeSyncStatus } from '../utils/product';

interface DashboardProps {
  products: Product[];
  onSelectProduct: (productId: string) => void;
  onRefreshProducts?: () => void | Promise<void>;
}

const safeCurrency = (code?: string) => {
  const c = (code || '').toString().trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : 'EUR';
};

const formatCurrency = (value: number, currency: string) => {
  const cur = safeCurrency(currency);
  try {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: cur }).format(value);
  } catch {
    return `${value.toFixed(2)} ${cur}`;
  }
};

const DashboardCard: React.FC<{
  label: string;
  value: string;
  sublabel?: string;
}> = ({ label, value, sublabel }) => (
  <div className="bg-slate-800 rounded-lg p-5 border border-white/5 shadow-lg shadow-black/20">
    <p className="text-sm uppercase tracking-wide text-slate-400">{label}</p>
    <p className="text-3xl font-semibold text-white mt-2">{value}</p>
    {sublabel && <p className="text-xs text-slate-400 mt-1">{sublabel}</p>}
  </div>
);

export const Dashboard: React.FC<DashboardProps> = ({ products, onSelectProduct, onRefreshProducts }) => {
  const [zones, setZones] = useState<WarehouseLayout[]>([]);
  const [zonesError, setZonesError] = useState<string | null>(null);
  const [isLoadingZones, setIsLoadingZones] = useState(false);
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);

  const loadZones = React.useCallback(async () => {
      setIsLoadingZones(true);
      try {
        const data = await fetchWarehouseZones();
          setZones(data);
          setZonesError(null);
      } catch (error: any) {
          setZonesError(error?.message || 'Zonen konnten nicht geladen werden.');
      } finally {
          setIsLoadingZones(false);
        }
  }, []);

  const loadMetrics = React.useCallback(async () => {
    setMetricsLoading(true);
    try {
      const data = await fetchDashboardMetrics(7, { timeoutMs: 25000 });
      setMetrics(data);
      setMetricsError(null);
    } catch (error: any) {
      setMetricsError(error?.message || 'Dashboard-Metriken konnten nicht geladen werden.');
      setMetrics(null);
    } finally {
      setMetricsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadZones();
    loadMetrics();
  }, [loadZones, loadMetrics]);

  // lightweight auto-refresh every 60s to keep dashboard fresh
  useEffect(() => {
    const interval = setInterval(() => {
      loadMetrics();
      if (onRefreshProducts) onRefreshProducts();
    }, 60000);
    return () => clearInterval(interval);
  }, [loadMetrics, onRefreshProducts]);

  const allProducts = products;
  const stockedProducts = useMemo(
    () => allProducts.filter((p) => getProductPhysicalQuantity(p) > 0),
    [allProducts]
  );

  const orderMetrics = useMemo(() => {
    const breakdown = metrics?.orders?.status_breakdown || null;
    const chartDays = metrics?.volume_7d?.days || [];
    const maxChartCount = Math.max(1, ...chartDays.map((d) => Number(d?.orders || 0) || 0));
    const chart = chartDays.map((d) => {
      const label = (() => {
        try {
          const dt = new Date(d.date);
          return dt.toLocaleDateString('de-DE', { weekday: 'short' });
        } catch {
          return d.date;
        }
      })();
      return { key: d.date, label, count: Number(d?.orders || 0) || 0 };
    });
    return {
      neu: breakdown?.neu ?? 0,
      kommissioniert: breakdown?.kommissioniert ?? 0,
      versendet: breakdown?.versendet ?? 0,
      zugestellt: breakdown?.zugestellt ?? 0,
      cancelled: breakdown?.cancelled ?? 0,
      other: breakdown?.other ?? 0,
      open: breakdown?.neu ?? 0,
      total:
        (breakdown?.neu ?? 0) +
        (breakdown?.kommissioniert ?? 0) +
        (breakdown?.versendet ?? 0) +
        (breakdown?.zugestellt ?? 0) +
        (breakdown?.other ?? 0),
      chart,
      maxChartCount,
      revenueAllNonCancelled: metrics?.revenue?.all_non_cancelled_total ?? 0,
      revenueWindowNonCancelled: metrics?.revenue?.window_non_cancelled_total ?? 0,
      currency: safeCurrency(metrics?.currency || 'EUR'),
    };
  }, [metrics]);

  const {
    totalProducts,
    totalStocked,
    unsavedCount,
    savedPercentage,
    syncCounts,
    inventoryQuantity,
    inventoryValue,
    inventoryPhysicalQuantity,
    inventoryReservedQuantity,
    primaryCurrency,
    valueByCurrency,
    topCategories,
    topProducts,
    recentProducts,
  } = useMemo(() => {
    const total = allProducts.length;
    const totalInStock = stockedProducts.length;
    const unsaved = allProducts.filter((p) => !p.ops?.last_saved_iso).length;
    const savedPct = total === 0 ? 0 : Math.round(((total - unsaved) / total) * 100);
    const syncBuckets = { synced: 0, pending: 0, failed: 0 };
    let physicalQty = 0;
    let reservedQty = 0;
    let availableQty = 0;
    const valueMap = new Map<string, number>();
    const categoryMap = new Map<string, number>();

    const topProductList = allProducts
      .map((product) => {
        const quantityPhysical = getProductPhysicalQuantity(product);
        const quantityReserved = getProductReservedQuantity(product);
        const quantityAvailable = getProductAvailableQuantity(product);
        const price = product.details?.pricing?.lowest_price;
        // Use available quantity for value (sellable stock). Physical can be higher due to reservations.
        const itemValue = quantityAvailable * (price?.amount ?? 0);
        const currency = (price?.currency || 'EUR').toUpperCase();

        physicalQty += quantityPhysical;
        reservedQty += quantityReserved;
        availableQty += quantityAvailable;
        valueMap.set(currency, (valueMap.get(currency) ?? 0) + itemValue);

        const category = product.identification?.category || 'Unbekannt';
        categoryMap.set(category, (categoryMap.get(category) ?? 0) + 1);

        const syncStatus = normalizeSyncStatus(
          product.ops?.sync_status ?? 'pending',
          product.ops?.last_synced_iso
        );
        syncBuckets[syncStatus] += 1;

        return {
          id: product.id,
          name: product.identification?.name || product.id,
          sku: product.identification?.sku || product.details?.identifiers?.sku || '—',
          quantity: quantityAvailable,
          value: itemValue,
          currency,
        };
      })
      .sort((a, b) => b.value - a.value);

    const mostCommonCurrency =
      [...valueMap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'EUR';
    const combinedValue = [...valueMap.values()].reduce((sum, value) => sum + value, 0);

    const topCategoryList = [...categoryMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, count]) => ({
        name,
        count,
        percent: total === 0 ? 0 : Math.round((count / total) * 100),
      }));

    const recentList = [...allProducts]
      .filter((p) => p.ops?.last_saved_iso)
      .sort((a, b) => {
        const aDate = a.ops?.last_saved_iso ? new Date(a.ops.last_saved_iso).getTime() : 0;
        const bDate = b.ops?.last_saved_iso ? new Date(b.ops.last_saved_iso).getTime() : 0;
        return bDate - aDate;
      })
      .slice(0, 5)
      .map((p) => ({
        id: p.id,
        name: p.identification?.name,
        brand: p.identification?.brand,
        savedAt: p.ops?.last_saved_iso ? new Date(p.ops.last_saved_iso) : null,
      }));

  return {
      totalProducts: total,
      totalStocked: totalInStock,
      unsavedCount: unsaved,
      savedPercentage: savedPct,
      syncCounts: syncBuckets,
      inventoryQuantity: availableQty,
      inventoryPhysicalQuantity: physicalQty,
      inventoryReservedQuantity: reservedQty,
      inventoryValue: combinedValue,
      primaryCurrency: mostCommonCurrency,
      valueByCurrency: valueMap,
      topCategories: topCategoryList,
      topProducts: topProductList.slice(0, 5),
      recentProducts: recentList,
    };
  }, [allProducts, stockedProducts]);

  const warehouseStats = useMemo(() => {
    // Fallback: wenn Zonen kein verlässliches binCount liefern, nutze real belegte BINs aus Produkten.
    const occupiedBins = new Set(
      allProducts
        .map((p) => p.storage?.binCode)
        .filter(Boolean) as string[]
    ).size;
    const totalBinsFromZones = zones.reduce((sum, zone) => sum + (zone.binCount || 0), 0);
    const totalBins = totalBinsFromZones > 0 ? totalBinsFromZones : occupiedBins;
    const fillPercent =
      totalBins === 0 ? 0 : Math.min(100, Math.round((occupiedBins / totalBins) * 100));
    return {
      totalBins,
      occupiedBins,
      fillPercent,
      topZone: [...zones]
        .sort((a, b) => (b.totalProducts || 0) - (a.totalProducts || 0))
        .slice(0, 2),
    };
  }, [zones, allProducts]);

  const warehouseMeterLabel = warehouseStats.totalBins
    ? `${warehouseStats.occupiedBins} / ${warehouseStats.totalBins} belegte Bins`
    : 'Noch keine Bins angelegt';

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div>
          <h1 className="text-3xl font-semibold text-white mb-1">Operations Dashboard</h1>
        <p className="text-slate-400">
          Überblick über Produktbestand, Status, Lagerauslastung und jüngste Aktivitäten.
        </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              loadMetrics();
              loadZones();
              if (onRefreshProducts) onRefreshProducts();
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-100 border border-slate-600 hover:bg-slate-700 transition"
          >
            <SyncIcon className="w-4 h-4" />
            Aktualisieren
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <DashboardCard
          label="Produkte gesamt"
          value={totalProducts.toString()}
          sublabel={`${unsavedCount} ohne Speichernachweis · ${totalStocked} mit Bestand`}
        />
        <DashboardCard
          label="Bestandseinheiten (verfügbar)"
          value={inventoryQuantity.toString()}
          sublabel={`physisch ${inventoryPhysicalQuantity} · reserviert ${inventoryReservedQuantity}`}
        />
        <DashboardCard
          label="Bestandswert (verfügbar)"
          value={formatCurrency(inventoryValue, primaryCurrency)}
          sublabel={
            valueByCurrency.size > 1
              ? `weitere Währungen: ${[...valueByCurrency.entries()]
                  .filter(([currency]) => currency !== primaryCurrency)
                  .map(([currency, amount]) => `${currency} ${amount.toFixed(0)}`)
                  .join(', ')}`
              : undefined
          }
        />
        <DashboardCard
          label="Gespeicherte Produkte"
          value={`${savedPercentage}%`}
          sublabel={`${totalProducts - unsavedCount} gespeichert`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-slate-800 rounded-2xl p-5 border border-white/5 shadow-inner shadow-black/20 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm uppercase tracking-wide text-slate-400">Auftragsstatus</p>
              <h2 className="text-xl font-semibold text-white">Kommissionierung</h2>
            </div>
            <SyncIcon className="w-6 h-6 text-slate-400" />
          </div>
          {metricsError && <p className="text-sm text-rose-300">{metricsError}</p>}
          {metricsLoading ? (
            <p className="text-sm text-slate-400">Lade Auftragszahlen …</p>
          ) : (
            <>
              <div className="grid grid-cols-4 gap-3">
                <div>
                  <p className="text-xs uppercase tracking-widest text-slate-400">Neue Bestellung</p>
                  <p className="text-2xl font-semibold text-white mt-1">{orderMetrics.neu}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-widest text-slate-400">Kommissioniert</p>
                  <p className="text-2xl font-semibold text-white mt-1">{orderMetrics.kommissioniert}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-widest text-slate-400">Versendet</p>
                  <p className="text-2xl font-semibold text-white mt-1">{orderMetrics.versendet}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-widest text-slate-400">Zugestellt</p>
                  <p className="text-2xl font-semibold text-white mt-1">{orderMetrics.zugestellt}</p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs uppercase tracking-widest text-slate-400">Offen (nur neu)</p>
                  <p className="text-2xl font-semibold text-white mt-1">{orderMetrics.open}</p>
                  <p className="text-xs text-slate-400 mt-1">Gesamt aktiv (ohne storniert): {orderMetrics.total}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs uppercase tracking-widest text-slate-400">Gesamtumsatz (alle, ohne Storniert)</p>
                  <p className="text-2xl font-semibold text-white mt-1">
                    {formatCurrency(orderMetrics.revenueAllNonCancelled, orderMetrics.currency)}
                  </p>
                  <p className="text-xs text-slate-400 mt-1">
                    letzte {metrics?.revenue?.window_days || 7} Tage (ohne Storno): {formatCurrency(orderMetrics.revenueWindowNonCancelled, orderMetrics.currency)}
                  </p>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="bg-slate-800 rounded-2xl p-5 border border-white/5 shadow-inner shadow-black/20 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm uppercase tracking-wide text-slate-400">Auftragsvolumen</p>
              <h2 className="text-xl font-semibold text-white">Letzte 7 Tage</h2>
            </div>
          </div>
          {metricsLoading ? (
            <p className="text-sm text-slate-400">Synchronisiere Diagramm …</p>
          ) : (
            <div className="overflow-x-auto">
              <div className="grid grid-cols-7 gap-3 min-w-[560px]">
                {orderMetrics.chart.map((day) => (
                  <div key={day.key} className="flex flex-col items-center gap-2">
                    <div className="w-full h-24 bg-slate-900 rounded-full overflow-hidden flex items-end">
                      <span
                        className="w-full bg-sky-500 rounded-full transition-all"
                        style={{ height: `${(day.count / orderMetrics.maxChartCount) * 100 || 4}%` }}
                      />
                    </div>
                    <span className="text-xs text-slate-400">{day.label}</span>
                    <span className="text-xs font-semibold text-white">{day.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-slate-800 rounded-2xl p-5 border border-white/5 shadow-inner shadow-black/20 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm uppercase tracking-wide text-slate-400">Sync-Status</p>
              <h2 className="text-xl font-semibold text-white">Produkt-Pipeline</h2>
            </div>
            <SyncIcon className="w-6 h-6 text-slate-400" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {(['synced', 'pending', 'failed'] as const).map((status) => {
              const value = syncCounts[status];
              const percent = totalProducts === 0 ? 0 : Math.round((value / totalProducts) * 100);
              const colors: Record<typeof status, string> = {
                synced: 'bg-emerald-500',
                pending: 'bg-amber-400',
                failed: 'bg-rose-500',
              };
              return (
                <div key={status} className="bg-slate-900/40 rounded-xl p-4 border border-white/5">
                  <p className="text-xs uppercase tracking-widest text-slate-400">{status}</p>
                  <p className="text-2xl font-semibold text-white mt-1">{value}</p>
                  <div className="mt-3 h-2 w-full bg-slate-700 rounded-full">
                    <div className={`h-2 rounded-full ${colors[status]}`} style={{ width: `${percent}%` }} />
                  </div>
                  <p className="text-xs text-slate-400 mt-1">{percent}% des Bestands</p>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-slate-800 rounded-2xl p-5 border border-white/5 shadow-inner shadow-black/20">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm uppercase tracking-wide text-slate-400">Lagerfüllstand</p>
              <h2 className="text-xl font-semibold text-white">Warehouse</h2>
            </div>
            <WarehouseIcon className="w-6 h-6 text-slate-400" />
          </div>
          {zonesError && (
            <p className="text-sm text-rose-300 mb-3">{zonesError}</p>
          )}
          {isLoadingZones ? (
            <p className="text-slate-400 text-sm">Lade Zonen …</p>
          ) : (
            <>
              <meter
                min={0}
                max={100}
                value={warehouseStats.fillPercent}
                className="w-full h-3 mb-2"
              />
              <p className="text-sm text-slate-300">{warehouseMeterLabel}</p>
              <p className="text-2xl font-semibold text-white mt-2">
                {warehouseStats.fillPercent}%
              </p>
              <ul className="mt-4 space-y-2 text-sm text-slate-300">
                {warehouseStats.topZone.map((zone) => (
                  <li key={zone.id} className="flex items-center justify-between">
                    <span>
                      Zone {zone.zone}/{zone.etage}
                    </span>
                    <span className="text-slate-400">
                      {zone.totalProducts || 0} Produkte
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-slate-800 rounded-2xl p-5 border border-white/5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm uppercase tracking-wide text-slate-400">Kategorien</p>
              <h2 className="text-xl font-semibold text-white">Top-Segmente</h2>
            </div>
            <TableIcon className="w-6 h-6 text-slate-400" />
          </div>
          {topCategories.length === 0 ? (
            <p className="text-slate-400 text-sm">Noch keine Produkte vorhanden.</p>
          ) : (
            <ul className="space-y-3">
              {topCategories.map((cat) => (
                <li key={cat.name}>
                  <div className="flex items-center justify-between text-sm text-white">
                    <span>{cat.name}</span>
                    <span className="text-slate-400">{cat.count} Produkte · {cat.percent}%</span>
                  </div>
                  <div className="h-2 bg-slate-700 rounded-full mt-1">
                    <div className="h-2 bg-sky-500 rounded-full" style={{ width: `${cat.percent}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-slate-800 rounded-2xl p-5 border border-white/5">
          <p className="text-sm uppercase tracking-wide text-slate-400">Aktivitäten</p>
          <h2 className="text-xl font-semibold text-white mb-4">Zuletzt aktualisiert</h2>
          {recentProducts.length === 0 ? (
            <p className="text-slate-400 text-sm">Noch keine gespeicherten Produkte.</p>
          ) : (
            <ul className="space-y-3">
              {recentProducts.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between bg-slate-900/40 rounded-xl px-3 py-2 cursor-pointer hover:border-sky-500 border border-transparent"
                  onClick={() => onSelectProduct(item.id)}
                >
                  <div>
                    <p className="text-sm text-white">{item.name}</p>
                    <p className="text-xs text-slate-400">{item.brand}</p>
                  </div>
                  <p className="text-xs text-slate-400">
                    {item.savedAt ? item.savedAt.toLocaleString('de-DE') : '--'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="bg-slate-800 rounded-2xl p-5 border border-white/5">
        <p className="text-sm uppercase tracking-wide text-slate-400 mb-1">High-Value Produkte</p>
        <h2 className="text-xl font-semibold text-white mb-4">Top 5 nach Bestandswert</h2>
        {topProducts.length === 0 ? (
          <p className="text-slate-400 text-sm">Keine Produkte mit Bestandswert gefunden.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-slate-400 border-b border-slate-700 text-xs uppercase tracking-wide">
                <tr>
                  <th className="py-2 pr-3">Produkt</th>
                  <th className="py-2 pr-3">SKU</th>
                  <th className="py-2 pr-3 text-right">Menge</th>
                  <th className="py-2 pr-3 text-right">Wert</th>
                </tr>
              </thead>
              <tbody>
                {topProducts.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b border-slate-800 hover:bg-slate-900/40 cursor-pointer"
                    onClick={() => onSelectProduct(item.id)}
                  >
                    <td className="py-2 pr-3 text-white">{item.name}</td>
                    <td className="py-2 pr-3 text-slate-400 font-mono">{item.sku}</td>
                    <td className="py-2 pr-3 text-right text-slate-200">{item.quantity}</td>
                    <td className="py-2 pr-3 text-right text-slate-200">
                      {formatCurrency(item.value, item.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
};

export default Dashboard;

