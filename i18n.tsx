import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

export type Locale = 'de' | 'en' | 'tr';

type Dict = Record<string, string>;

interface I18nContextValue {
  t: (key: string, vars?: Record<string, string | number>) => string;
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
    'ops.mode.stow.subtitle': 'Produkte scannen und Lagerplatz zuweisen',
    'ops.mode.pick': 'Kommissionieren',
    'ops.mode.pick.subtitle': 'Bin zuerst scannen, Menge entnehmen',
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
    'ops.orders.desc': 'Offene Bestellungen für die Kommissionierung.',
    'ops.orders.sync': 'Aufträge synchronisieren',
    'ops.orders.auto': 'Auto',
    'ops.orders.open': 'Offene Aufträge',
    'ops.orders.total': 'Gesamt',
    'ops.orders.today': 'Heute kommissioniert',
    'ops.orders.none': 'Keine offenen Aufträge vorhanden.',
    'ops.orders.more': 'Alle anzeigen',
    'ops.orders.less': 'Weniger anzeigen',
    'ops.orders.show': 'Aufträge anzeigen',
    'ops.orders.hide': 'Aufträge ausblenden',
    'ops.orders.loading': 'Lade Aufträge …',
    'ops.orders.complete': 'Kommissioniert',
    'ops.orders.status.label': 'Status',
    'ops.identify.barcode': 'Barcode / SKU',
    'ops.identify.images': 'Bilder hinzufügen',
    'ops.identify.run': 'Identifizieren',
    'ops.identify.result.none': 'Kein Produkt gefunden',
    'inventory.title': 'Inventar',
    'inventory.subtitle': 'Behalte den Überblick über alle Bestände und führe Sammelaktionen aus.',
    'table.search': 'Suchen...',
    'table.status.all': 'Alle Status',
    'table.status.pending': 'Ausstehend',
    'table.status.synced': 'Synchronisiert',
    'table.status.failed': 'Fehlgeschlagen',
    'table.categories.all': 'Alle Kategorien',
    'table.actions.syncSelected': 'Sync ausgewählte',
    'table.actions.priceRefresh': 'Price Refresh',
    'table.actions.exportCsv': 'Export CSV',
    'table.actions.printLabel': 'Label drucken',
    'table.actions.deleteSelected': 'Lösche Auswahl',
    'table.actions.delete': 'Löschen',
    'table.actions.deleteConfirm': 'Soll(en) {count} Produkt(e) gelöscht werden? Dies kann nicht rückgängig gemacht werden.',
    'table.actions.deleteOne': 'Produkt "{name}" löschen?',
    'table.actions.label': 'Aktionen',
    'table.thumbnail': 'Thumbnail',
    'table.nameBrand': 'Name / Brand',
    'table.category': 'Kategorie',
    'table.identifiers': 'SKU / EAN',
    'table.price': 'Preis',
    'table.inventory': 'Bestand',
    'table.storage': 'Lagerplatz',
    'table.lastSold': 'Zuletzt verkauft',
    'table.syncStatus': 'Sync-Status',
    'table.saveStatus': 'Speicherstatus',
    'table.lastSaved': 'Zuletzt gespeichert',
    'table.lastSynced': 'Zuletzt synchronisiert',
    'table.revision': 'Revision',
    'table.presets.standard': 'Standard',
    'table.presets.warehouse': 'Lager',
    'table.presets.pricing': 'Pricing',
    'table.presets.minimal': 'Minimal',
    'table.columns.edit': 'Spalten anpassen',
    'table.columns.visible': 'Sichtbare Spalten',
    'table.columns.reset': 'Zurücksetzen',
    'actions.refresh': 'Neu laden',
    'table.noBin': 'Kein BIN zugewiesen',
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
    'ops.mode.stow.subtitle': 'Scan products and assign BIN',
    'ops.mode.pick': 'Pick',
    'ops.mode.pick.subtitle': 'Scan bin first, take quantity',
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
    'ops.orders.desc': 'Sync open orders for picking.',
    'ops.orders.sync': 'Sync orders',
    'ops.orders.auto': 'Auto',
    'ops.orders.open': 'Open orders',
    'ops.orders.total': 'Total',
    'ops.orders.today': 'Picked today',
    'ops.orders.none': 'No open orders.',
    'ops.orders.more': 'Show all',
    'ops.orders.less': 'Show less',
    'ops.orders.show': 'Show orders',
    'ops.orders.hide': 'Hide orders',
    'ops.orders.loading': 'Loading orders…',
    'ops.orders.complete': 'Picked',
    'ops.orders.status.label': 'Status',
    'ops.identify.barcode': 'Barcode / SKU',
    'ops.identify.images': 'Add images',
    'ops.identify.run': 'Identify',
    'ops.identify.result.none': 'No product found',
    'inventory.title': 'Inventory',
    'inventory.subtitle': 'Keep track of all stock and run bulk actions.',
    'table.search': 'Search...',
    'table.status.all': 'All statuses',
    'table.status.pending': 'Pending',
    'table.status.synced': 'Synced',
    'table.status.failed': 'Failed',
    'table.categories.all': 'All categories',
    'table.actions.syncSelected': 'Sync selected',
    'table.actions.priceRefresh': 'Price refresh',
    'table.actions.exportCsv': 'Export CSV',
    'table.actions.printLabel': 'Print label',
    'table.actions.deleteSelected': 'Delete selected',
    'table.actions.delete': 'Delete',
    'table.actions.deleteConfirm': 'Delete {count} product(s)? This cannot be undone.',
    'table.actions.deleteOne': 'Delete product "{name}"?',
    'table.actions.label': 'Actions',
    'table.thumbnail': 'Thumbnail',
    'table.nameBrand': 'Name / Brand',
    'table.category': 'Category',
    'table.identifiers': 'SKU / EAN',
    'table.price': 'Price',
    'table.inventory': 'Stock',
    'table.storage': 'Location',
    'table.lastSold': 'Last sold',
    'table.syncStatus': 'Sync status',
    'table.saveStatus': 'Save status',
    'table.lastSaved': 'Last saved',
    'table.lastSynced': 'Last synced',
    'table.revision': 'Revision',
    'table.presets.standard': 'Standard',
    'table.presets.warehouse': 'Warehouse',
    'table.presets.pricing': 'Pricing',
    'table.presets.minimal': 'Minimal',
    'table.columns.edit': 'Edit columns',
    'table.columns.visible': 'Visible columns',
    'table.columns.reset': 'Reset',
    'actions.refresh': 'Hard refresh',
    'table.noBin': 'No BIN assigned',
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
    'ops.mode.stow.subtitle': 'Ürün tara, rafa ata',
    'ops.mode.pick': 'Topla',
    'ops.mode.pick.subtitle': 'Önce BIN tara, miktarı al',
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
    'ops.orders.desc': 'Açık siparişleri toplama için senkronize et.',
    'ops.orders.sync': 'Siparişleri senkronize et',
    'ops.orders.auto': 'Oto',
    'ops.orders.open': 'Açık siparişler',
    'ops.orders.total': 'Toplam',
    'ops.orders.today': 'Bugün toplanan',
    'ops.orders.none': 'Açık sipariş yok.',
    'ops.orders.more': 'Hepsini göster',
    'ops.orders.less': 'Daha az göster',
    'ops.orders.show': 'Siparişleri göster',
    'ops.orders.hide': 'Siparişleri gizle',
    'ops.orders.loading': 'Siparişler yükleniyor…',
    'ops.orders.complete': 'Toplandı',
    'ops.orders.status.label': 'Durum',
    'ops.identify.barcode': 'Barkod / SKU',
    'ops.identify.images': 'Görsel ekle',
    'ops.identify.run': 'Tanımla',
    'ops.identify.result.none': 'Ürün bulunamadı',
    'inventory.title': 'Envanter',
    'inventory.subtitle': 'Stokları takip et ve toplu işlemler yap.',
    'table.search': 'Ara...',
    'table.status.all': 'Tüm durumlar',
    'table.status.pending': 'Beklemede',
    'table.status.synced': 'Senkronize',
    'table.status.failed': 'Başarısız',
    'table.categories.all': 'Tüm kategoriler',
    'table.actions.syncSelected': 'Seçilenleri senkronize et',
    'table.actions.priceRefresh': 'Fiyat güncelle',
    'table.actions.exportCsv': 'CSV indir',
    'table.actions.printLabel': 'Etiket yazdır',
    'table.actions.deleteSelected': 'Seçilenleri sil',
    'table.actions.delete': 'Sil',
    'table.actions.deleteConfirm': '{count} ürün silinsin mi? Geri alınamaz.',
    'table.actions.deleteOne': '"{name}" ürününü sil?',
    'table.actions.label': 'İşlemler',
    'table.thumbnail': 'Küçük resim',
    'table.nameBrand': 'İsim / Marka',
    'table.category': 'Kategori',
    'table.identifiers': 'SKU / EAN',
    'table.price': 'Fiyat',
    'table.inventory': 'Stok',
    'table.storage': 'Depo yeri',
    'table.lastSold': 'Son satış',
    'table.syncStatus': 'Sync durumu',
    'table.saveStatus': 'Kayıt durumu',
    'table.lastSaved': 'Son kaydedildi',
    'table.lastSynced': 'Son senkron',
    'table.revision': 'Revizyon',
    'table.presets.standard': 'Standart',
    'table.presets.warehouse': 'Depo',
    'table.presets.pricing': 'Fiyat',
    'table.presets.minimal': 'Minimal',
    'table.columns.edit': 'Sütunları düzenle',
    'table.columns.visible': 'Görünen sütunlar',
    'table.columns.reset': 'Sıfırla',
    'actions.refresh': 'Yeniden yükle',
    'table.noBin': 'BIN atanmadı',
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
    return (key: string, vars?: Record<string, string | number>) => {
      const template = dict[key] || key;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (match, k) => {
        return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : match;
      });
    };
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
