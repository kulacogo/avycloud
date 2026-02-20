
export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'avystock:theme';
export const DASHBOARD_RANGE_PRESET_STORAGE_KEY = 'avystock:dashboard:rangePreset';

export const readInitialTheme = (): Theme => {
  if (typeof window === 'undefined') {
    return 'light';
  }
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }
  // v2.1 Design System is light-first — default to light
  return 'light';
};

export const readInitialDashboardRangePreset = (): string => {
  if (typeof window === 'undefined') return 'last7';
  try {
    const stored = window.localStorage.getItem(DASHBOARD_RANGE_PRESET_STORAGE_KEY);
    const v = (stored || '').toString().trim();
    const allowed = new Set(['last7', 'month_to_date', 'last_month', 'year_to_date', 'last_year', 'today']);
    if (!v) return 'last7';
    return allowed.has(v) ? v : 'last7';
  } catch {
    return 'last7';
  }
};
