'use strict';

// Allowlist: future finance fields must not leak into the operational dashboard.
function operationalDashboardMetrics(metrics) {
  const { generated_at_iso, range, orders, volume_7d } = metrics;
  return {
    generated_at_iso, range, orders,
    volume_7d: volume_7d ? {
      window_days: volume_7d.window_days,
      days: (volume_7d.days || []).map(({ date, orders: count }) => ({ date, orders: count })),
    } : undefined,
  };
}
module.exports = { operationalDashboardMetrics };
