import React, { useEffect, useMemo, useState } from 'react';
import { Product, WarehouseLayout } from '../types';
import { fetchWarehouseZones } from '../api/client';
import { WarehouseIcon, TableIcon, SyncIcon } from './icons/Icons';

interface DashboardProps {
  products: Product[];
  onSelectProduct: (productId: string) => void;
}

const formatCurrency = (value: number, currency: string) => {
  try {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
};

const DashboardCard: React.FC<{
  label: string;
  value: string;
  sublabel?: string;
}> = ({ label, value, sublabel }) => (
  <div className="bg-slate-800 rounded-2xl p-5 border border-white/5 shadow-lg shadow-black/20">
    <p className="text-sm uppercase tracking-wide text-slate-400">{label}</p>
    <p className="text-3xl font-semibold text-white mt-2">{value}</p>
    {sublabel && <p className="text-xs text-slate-400 mt-1">{sublabel}</p>}
  </div>
);

export const Dashboard: React.FC<DashboardProps> = ({ products, onSelectProduct }) => {
  const [zones, setZones] = useState<WarehouseLayout[]>([]);
  const [zonesError, setZonesError] = useState<string | null>(null);
  const [isLoadingZones, setIsLoadingZones] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadZones = async () => {
      setIsLoadingZones(true);
      try {
        const data = await fetchWarehouseZones();
        if (!cancelled) {
          setZones(data);
          setZonesError(null);
        }
      } catch (error: any) {
        if (!cancelled) {
          setZonesError(error?.message || 'Zonen konnten nicht geladen werden.');
        }
      } finally {
        if (!cancelled) {
          setIsLoadingZones(false);
        }
      }
    };
    loadZones();
    return () => {
      cancelled = true;
    };
  }, []);

  const {
    totalProducts,
    unsavedCount,
    savedPercentage,
    syncCounts,
    inventoryQuantity,
    inventoryValue,
    primaryCurrency,
    valueByCurrency,
    topCategories,
    topProducts,
    recentProducts,
  } = useMemo(() => {
    const total = products.length;
    const unsaved = products.filter((p) => !p.ops?.last_saved_iso).length;
    const savedPct = total === 0 ? 0 : Math.round(((total - unsaved) / total) * 100);
    const syncBuckets = { synced: 0, pending: 0, failed: 0 };
    let qty = 0;
    const valueMap = new Map<string, number>();
    const categoryMap = new Map<string, number>();

    const topProductList = products
      .map((product) => {
        const quantity = product.inventory?.quantity ?? 0;
        const price = product.details?.pricing?.lowest_price;
        const itemValue = quantity * (price?.amount ?? 0);
        const currency = price?.currency || 'EUR';

        qty += quantity;
        const prev = valueMap.get(currency) ?? 0;
        valueMap.set(currency, prev + itemValue);

        const category = product.identification?.category || 'Unbekannt';
        categoryMap.set(category, (categoryMap.get(category) ?? 0) + 1);

        const syncStatus = product.ops?.sync_status ?? 'pending';
        if (syncStatus in syncBuckets) {
          syncBuckets[syncStatus as keyof typeof syncBuckets] += 1;
        }

        return {
          id: product.id,
          name: product.identification?.name || product.id,
          sku: product.identification?.sku || product.details?.identifiers?.sku || '—',
          quantity,
          value: itemValue,
          currency,
        };
      })
      .sort((a, b) => b.value - a.value);

    const mostCommonCurrency =
      [...valueMap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'EUR';
    const combinedValue = valueMap.get(mostCommonCurrency) ?? 0;

    const topCategoryList = [...categoryMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, count]) => ({
        name,
        count,
        percent: total === 0 ? 0 : Math.round((count / total) * 100),
      }));

    const recentList = [...products]
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
      unsavedCount: unsaved,
      savedPercentage: savedPct,
      syncCounts: syncBuckets,
      inventoryQuantity: qty,
      inventoryValue: combinedValue,
      primaryCurrency: mostCommonCurrency,
      valueByCurrency: valueMap,
      topCategories: topCategoryList,
      topProducts: topProductList.slice(0, 5),
      recentProducts: recentList,
    };
  }, [products]);

  const warehouseStats = useMemo(() => {
    const totalBins = zones.reduce((sum, zone) => sum + (zone.binCount || 0), 0);
    const occupiedBins = new Set(
      products.map((p) => p.storage?.binCode).filter(Boolean) as string[]
    ).size;
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
  }, [zones, products]);

  const warehouseMeterLabel = warehouseStats.totalBins
    ? `${warehouseStats.occupiedBins} / ${warehouseStats.totalBins} belegte Bins`
    : 'Noch keine Bins angelegt';

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold text-white mb-2">Operations Dashboard</h1>
        <p className="text-slate-400">
          Überblick über Produktbestand, Status, Lagerauslastung und jüngste Aktivitäten.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <DashboardCard
          label="Produkte gesamt"
          value={totalProducts.toString()}
          sublabel={`${unsavedCount} ohne Speichernachweis`}
        />
        <DashboardCard
          label="Bestandseinheiten"
          value={inventoryQuantity.toString()}
          sublabel="Aufsummierte Lager­menge"
        />
        <DashboardCard
          label="Bestandswert"
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

