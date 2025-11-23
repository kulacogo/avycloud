import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

export type Locale = 'de' | 'en' | 'tr';

type Dict = Record<string, string>;

interface I18nContextValue {
  t: (key: string) => string;
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const STORAGE_KEY = 'avystock:locale';

const messages: Record<Locale, Dict> = {
  de: {
    'nav.dashboard': 'Dashboard',
    'nav.input': 'Erkennen',
    'nav.inventory': 'Inventar',
    'nav.warehouse': 'Lager',
    'nav.operations': 'Operationen',
    'lang.label': 'Sprache',
    'status.loading.products': 'Produkte werden geladen …',
    'status.loading.hint': 'Einen Moment bitte.',
    'error.reload': 'Erneut laden',
    'error.products': 'Produkte konnten nicht geladen werden.',
    'ops.title': 'Operationen',
    'ops.subtitle': 'Arbeite konzentriert im Einlagerungs- oder Kommissionierungsprozess.',
    'ops.mode.identify': 'Identifizieren',
    'ops.mode.stow': 'Einlagern',
    'ops.mode.pick': 'Kommissionieren',
    'ops.actions.scan.product': 'Produkt scannen',
    'ops.actions.scan.bin': 'Bin scannen',
    'ops.stow.product': 'Artikel / SKU',
    'ops.stow.bin': 'BIN-Code',
    'ops.stow.quantity': 'Menge',
    'ops.stow.submit': 'Einlagern',
    'ops.stow.submit.next': 'Einlagern & Neuer Scan',
    'ops.pick.bin': 'BIN-Code',
    'ops.pick.product': 'Artikel / SKU',
    'ops.pick.quantity': 'Menge',
    'ops.pick.submit': 'Kommissionierung buchen',
    'ops.orders.section': 'Neue Aufträge',
    'ops.orders.sync': 'Aufträge synchronisieren',
    'ops.orders.auto': 'Auto',
    'ops.orders.open': 'Offene Aufträge',
    'ops.orders.total': 'Gesamt',
    'ops.orders.today': 'Heute kommissioniert',
    'ops.orders.none': 'Keine offenen Aufträge vorhanden.',
    'ops.orders.more': 'Alle anzeigen',
    'ops.orders.less': 'Weniger anzeigen',
    'ops.orders.loading': 'Lade Aufträge …',
    'ops.orders.complete': 'Kommissioniert',
    'ops.orders.status.label': 'Status',
    'ops.identify.barcode': 'Barcode / SKU',
    'ops.identify.images': 'Bilder hinzufügen',
    'ops.identify.run': 'Identifizieren',
    'ops.identify.result.none': 'Kein Produkt gefunden',
  },
  en: {
    'nav.dashboard': 'Dashboard',
    'nav.input': 'Identify',
    'nav.inventory': 'Inventory',
    'nav.warehouse': 'Warehouse',
    'nav.operations': 'Operations',
    'lang.label': 'Language',
    'status.loading.products': 'Loading products…',
    'status.loading.hint': 'One moment please.',
    'error.reload': 'Reload',
    'error.products': 'Products could not be loaded.',
    'ops.title': 'Operations',
    'ops.subtitle': 'Focused inbound and outbound workflows.',
    'ops.mode.identify': 'Identify',
    'ops.mode.stow': 'Stow',
    'ops.mode.pick': 'Pick',
    'ops.actions.scan.product': 'Scan product',
    'ops.actions.scan.bin': 'Scan bin',
    'ops.stow.product': 'Item / SKU',
    'ops.stow.bin': 'BIN code',
    'ops.stow.quantity': 'Qty',
    'ops.stow.submit': 'Stow',
    'ops.stow.submit.next': 'Stow & Next',
    'ops.pick.bin': 'BIN code',
    'ops.pick.product': 'Item / SKU',
    'ops.pick.quantity': 'Qty',
    'ops.pick.submit': 'Book pick',
    'ops.orders.section': 'New orders',
    'ops.orders.sync': 'Sync orders',
    'ops.orders.auto': 'Auto',
    'ops.orders.open': 'Open orders',
    'ops.orders.total': 'Total',
    'ops.orders.today': 'Picked today',
    'ops.orders.none': 'No open orders.',
    'ops.orders.more': 'Show all',
    'ops.orders.less': 'Show less',
    'ops.orders.loading': 'Loading orders…',
    'ops.orders.complete': 'Picked',
    'ops.orders.status.label': 'Status',
    'ops.identify.barcode': 'Barcode / SKU',
    'ops.identify.images': 'Add images',
    'ops.identify.run': 'Identify',
    'ops.identify.result.none': 'No product found',
  },
  tr: {
    'nav.dashboard': 'Panel',
    'nav.input': 'Tanımla',
    'nav.inventory': 'Envanter',
    'nav.warehouse': 'Depo',
    'nav.operations': 'Operasyonlar',
    'lang.label': 'Dil',
    'status.loading.products': 'Ürünler yükleniyor…',
    'status.loading.hint': 'Lütfen bekleyin.',
    'error.reload': 'Yenile',
    'error.products': 'Ürünler yüklenemedi.',
    'ops.title': 'Operasyonlar',
    'ops.subtitle': 'Hızlı giriş ve toplama akışları.',
    'ops.mode.identify': 'Tanımla',
    'ops.mode.stow': 'Rafa koy',
    'ops.mode.pick': 'Topla',
    'ops.actions.scan.product': 'Ürün tara',
    'ops.actions.scan.bin': 'Bin tara',
    'ops.stow.product': 'Ürün / SKU',
    'ops.stow.bin': 'BIN kodu',
    'ops.stow.quantity': 'Adet',
    'ops.stow.submit': 'Rafa koy',
    'ops.stow.submit.next': 'Rafa koy & Yeni',
    'ops.pick.bin': 'BIN kodu',
    'ops.pick.product': 'Ürün / SKU',
    'ops.pick.quantity': 'Adet',
    'ops.pick.submit': 'Toplamayı işle',
    'ops.orders.section': 'Yeni siparişler',
    'ops.orders.sync': 'Siparişleri senkronize et',
    'ops.orders.auto': 'Oto',
    'ops.orders.open': 'Açık siparişler',
    'ops.orders.total': 'Toplam',
    'ops.orders.today': 'Bugün toplanan',
    'ops.orders.none': 'Açık sipariş yok.',
    'ops.orders.more': 'Hepsini göster',
    'ops.orders.less': 'Daha az göster',
    'ops.orders.loading': 'Siparişler yükleniyor…',
    'ops.orders.complete': 'Toplandı',
    'ops.orders.status.label': 'Durum',
    'ops.identify.barcode': 'Barkod / SKU',
    'ops.identify.images': 'Görsel ekle',
    'ops.identify.run': 'Tanımla',
    'ops.identify.result.none': 'Ürün bulunamadı',
  },
};

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

const detectLocale = (): Locale => {
  const stored = typeof window !== 'undefined' ? (window.localStorage.getItem(STORAGE_KEY) as Locale | null) : null;
  if (stored === 'de' || stored === 'en' || stored === 'tr') return stored;
  if (typeof navigator !== 'undefined') {
    const lang = navigator.language.toLowerCase();
    if (lang.startsWith('de')) return 'de';
    if (lang.startsWith('tr')) return 'tr';
  }
  return 'en';
};

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [locale, setLocale] = useState<Locale>(() => detectLocale());

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // ignore storage errors
    }
  }, [locale]);

  const t = useMemo(() => {
    const dict = messages[locale] || messages.en;
    return (key: string) => dict[key] || key;
  }, [locale]);

  const value = useMemo(() => ({ t, locale, setLocale }), [t, locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export const useI18n = () => {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return ctx;
};
