import React, { useEffect, useState, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { PriceHistoryEntry } from "../types";
import { fetchCompetitorHistory } from "../api/client";

interface CompetitorPriceChartProps {
  productId: string;
  days?: number;
}

interface ChartDataPoint {
  date: string;
  ebay_min?: number;
  ebay_avg?: number;
  kaufland_min?: number;
  kaufland_avg?: number;
}

const MARKETPLACE_COLORS = {
  ebay: "#E53238",
  kaufland: "#D4001A",
} as const;

const formatEur = (v: number) => `${v.toFixed(2)} €`;

const CustomTooltip: React.FC<any> = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-lg border px-3 py-2 text-xs shadow-md"
      style={{
        background: "var(--surface)",
        borderColor: "var(--border)",
        color: "var(--text-primary)",
      }}
    >
      <p className="font-semibold mb-1" style={{ color: "var(--text-secondary)" }}>
        {label}
      </p>
      {payload.map((entry: any) => (
        <p key={entry.dataKey} className="flex items-center gap-1.5">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span style={{ color: "var(--text-secondary)" }}>{entry.name}:</span>
          <span className="font-medium">{formatEur(entry.value)}</span>
        </p>
      ))}
    </div>
  );
};

const CompetitorPriceChart: React.FC<CompetitorPriceChartProps> = ({
  productId,
  days = 30,
}) => {
  const [history, setHistory] = useState<PriceHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!productId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchCompetitorHistory(productId, days)
      .then((data) => {
        if (!cancelled) setHistory(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || "Fehler beim Laden");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [productId, days]);

  // Aggregate entries by date + marketplace → min/avg per day.
  const chartData = useMemo<ChartDataPoint[]>(() => {
    if (!history.length) return [];

    const byDate = new Map<
      string,
      { ebay: number[]; kaufland: number[] }
    >();

    for (const entry of history) {
      const date = entry.timestamp?.slice(0, 10) || "unknown";
      if (!byDate.has(date)) byDate.set(date, { ebay: [], kaufland: [] });
      const bucket = byDate.get(date)!;
      const mp = (entry.marketplace || entry.source || "").toLowerCase();
      if (mp.includes("ebay") && entry.price > 0) bucket.ebay.push(entry.price);
      if (mp.includes("kaufland") && entry.price > 0) bucket.kaufland.push(entry.price);
    }

    const sorted = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    return sorted.map(([date, { ebay, kaufland }]) => {
      const point: ChartDataPoint = {
        date: new Date(date).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }),
      };
      if (ebay.length) {
        point.ebay_min = Math.min(...ebay);
        point.ebay_avg = Math.round((ebay.reduce((s, v) => s + v, 0) / ebay.length) * 100) / 100;
      }
      if (kaufland.length) {
        point.kaufland_min = Math.min(...kaufland);
        point.kaufland_avg =
          Math.round((kaufland.reduce((s, v) => s + v, 0) / kaufland.length) * 100) / 100;
      }
      return point;
    });
  }, [history]);

  const hasEbay = chartData.some((d) => d.ebay_min !== undefined);
  const hasKaufland = chartData.some((d) => d.kaufland_min !== undefined);

  if (loading) {
    return (
      <div
        className="rounded-xl border p-5"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <div className="h-48 flex items-center justify-center">
          <div className="animate-pulse text-sm" style={{ color: "var(--text-tertiary)" }}>
            Preisverlauf wird geladen…
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="rounded-xl border p-5"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <div className="h-48 flex items-center justify-center">
          <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
            {error}
          </p>
        </div>
      </div>
    );
  }

  if (!chartData.length) {
    return (
      <div
        className="rounded-xl border p-5"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <div className="h-48 flex items-center justify-center">
          <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
            Keine Preisverlaufsdaten vorhanden. Rufe Konkurrenzpreise ab, um den Verlauf zu starten.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <div
        className="px-5 py-3.5 border-b flex items-center justify-between"
        style={{ borderColor: "var(--border)" }}
      >
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Preisverlauf ({days} Tage)
        </h3>
        <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          {chartData.length} Datenpunkte
        </span>
      </div>
      <div className="p-5">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "var(--text-tertiary)" }}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "var(--text-tertiary)" }}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              tickFormatter={(v: number) => `${v}€`}
              width={50}
            />
            <Tooltip content={<CustomTooltip />} />
            <Legend
              wrapperStyle={{ fontSize: 12, color: "var(--text-secondary)" }}
              iconType="circle"
              iconSize={8}
            />
            {hasEbay && (
              <Line
                type="monotone"
                dataKey="ebay_min"
                name="eBay (min)"
                stroke={MARKETPLACE_COLORS.ebay}
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
                connectNulls
              />
            )}
            {hasEbay && (
              <Line
                type="monotone"
                dataKey="ebay_avg"
                name="eBay (avg)"
                stroke={MARKETPLACE_COLORS.ebay}
                strokeWidth={1}
                strokeDasharray="5 5"
                dot={false}
                connectNulls
              />
            )}
            {hasKaufland && (
              <Line
                type="monotone"
                dataKey="kaufland_min"
                name="Kaufland (min)"
                stroke={MARKETPLACE_COLORS.kaufland}
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
                connectNulls
              />
            )}
            {hasKaufland && (
              <Line
                type="monotone"
                dataKey="kaufland_avg"
                name="Kaufland (avg)"
                stroke={MARKETPLACE_COLORS.kaufland}
                strokeWidth={1}
                strokeDasharray="5 5"
                dot={false}
                connectNulls
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default CompetitorPriceChart;
