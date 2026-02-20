
export type View =
  | 'dashboard'
  | 'home'
  | 'search'
  | 'admin'
  | 'categories'
  | 'operations'
  | 'operations-identify'
  | 'operations-stow'
  | 'operations-pick'
  | 'operations-pack'
  | 'ebay-listings'
  | 'input'
  | 'sheet'
  | 'inventory'
  | 'products'
  | 'warehouse';

export const ALLOWED_VIEWS: View[] = [
  'dashboard',
  'home',
  'search',
  'admin',
  'categories',
  'operations',
  'operations-identify',
  'operations-stow',
  'operations-pick',
  'operations-pack',
  'ebay-listings',
  'input',
  'sheet',
  'inventory',
  'products',
  'warehouse',
];

export const VIEW_STORAGE_KEY = 'avystock:view';
export const VIEW_PRODUCT_KEY = 'avystock:view:productId';

export const parseHash = (): { view: View; productId: string | null } => {
  if (typeof window === 'undefined') return { view: 'dashboard', productId: null };
  const raw = window.location.hash.replace(/^#/, '').replace(/^\/+/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const [first, second] = segments;

  if (first === 'sheet') {
    const productId = segments[1] || new URLSearchParams(queryPart || '').get('productId') || null;
    return { view: 'sheet', productId };
  }

  if (first === 'operations') {
    const opMap: Record<string, View> = {
      identify: 'operations-identify',
      stow: 'operations-stow',
      pick: 'operations-pick',
      pack: 'operations-pack',
    };
    const mapped = opMap[second || ''] || 'operations';
    return { view: mapped, productId: null };
  }

  if (first === 'ebay') {
    return { view: 'ebay-listings', productId: null };
  }

  if (first && ALLOWED_VIEWS.includes(first as View)) {
    return { view: first as View, productId: null };
  }

  return { view: 'dashboard', productId: null };
};

export const parseHashQuery = (): URLSearchParams => {
  if (typeof window === 'undefined') return new URLSearchParams();
  const raw = window.location.hash.replace(/^#/, '').replace(/^\/+/, '');
  const queryPart = raw.split('?')[1] || '';
  return new URLSearchParams(queryPart);
};

export const viewToHashPath = (view: View, productId?: string | null) => {
  switch (view) {
    case 'home':
      return '/home';
    case 'search':
      return '/search';
    case 'admin':
      return '/admin';
    case 'operations-identify':
      return '/operations/identify';
    case 'operations-stow':
      return '/operations/stow';
    case 'operations-pick':
      return '/operations/pick';
    case 'operations-pack':
      return '/operations/pack';
    case 'operations':
      return '/operations';
    case 'ebay-listings':
      return '/ebay';
    case 'sheet':
      return productId ? `/sheet/${productId}` : '/sheet';
    default:
      return `/${view}`;
  }
};

export const VIEW_MIGRATIONS: Partial<Record<string, View>> = {
  // Historical: "admin" used to be the product list; keep behavior stable.
  admin: 'products',
  // Historical: "inventory" used to be the full product list; keep behavior stable.
  inventory: 'products',
  home: 'home',
  search: 'search',
  ebay: 'ebay-listings',
};

export const readInitialView = (): { view: View; productId: string | null } => {
  if (typeof window === 'undefined') return { view: 'dashboard', productId: null };
  const fromHash = parseHash();
  if (fromHash.view !== 'dashboard' || fromHash.productId) return fromHash;
  const stored = window.localStorage.getItem(VIEW_STORAGE_KEY) as View | string | null;
  if (stored) {
    const migrated = VIEW_MIGRATIONS[stored] || stored;
    if (ALLOWED_VIEWS.includes(migrated as View)) {
      return { view: migrated as View, productId: null };
    }
  }
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  return { view: isMobile ? 'home' : 'dashboard', productId: null };
};
