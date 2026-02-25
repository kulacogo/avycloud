import React, { useMemo } from 'react';

/* -------------------------------------------------------
   Types
   ------------------------------------------------------- */
export interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  badge?: string | number;
}

export interface NavSection {
  title?: string;
  items: NavItem[];
}

export interface SidebarProps {
  currentView: string;
  onNavigate: (viewId: string) => void;
  open?: boolean;
  className?: string;
}

/* -------------------------------------------------------
   Icon components (inline SVGs for sidebar nav)
   ------------------------------------------------------- */
const DashboardIcon = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v18m16.5 0V3m-13.5 0v7.5m4.5-7.5v4.5m4.5-4.5v10.5m-9 0V21m4.5-6v6m4.5-1.5V21" />
  </svg>
);

const SearchNavIcon = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
  </svg>
);

const IdentifyIcon = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 3.75H6A2.25 2.25 0 003.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0120.25 6v1.5m0 9V18A2.25 2.25 0 0118 20.25h-1.5m-9 0H6A2.25 2.25 0 013.75 18v-1.5" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8.25v7.5M9 11.25h6" />
  </svg>
);

const OperationsIcon = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8.25a3.75 3.75 0 103.75 3.75A3.75 3.75 0 0012 8.25zm0-5.25v2.25m0 13.5V21m7.5-9h2.25M2.25 12H4.5m13.182-5.318l1.59-1.59M4.728 19.272l1.59-1.59m0-10.364l-1.59-1.59m13.544 13.544l-1.59-1.59" />
  </svg>
);

const InventoryIcon = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
  </svg>
);

const EbayIcon = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 21v-7.5a.75.75 0 01.75-.75h3a.75.75 0 01.75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349m-16.5 11.65V9.35m0 0a3.001 3.001 0 003.75-.615A2.993 2.993 0 009.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 002.25 1.016c.896 0 1.7-.393 2.25-1.016a3.001 3.001 0 003.75.614m-16.5 0a3.004 3.004 0 01-.621-4.72L4.318 3.44A1.5 1.5 0 015.378 3h13.243a1.5 1.5 0 011.06.44l1.19 1.189a3 3 0 01-.621 4.72m-13.5 8.65h3.75a.75.75 0 00.75-.75V13.5a.75.75 0 00-.75-.75H6.75a.75.75 0 00-.75.75v3.15c0 .415.336.75.75.75z" />
  </svg>
);

const WarehouseIcon = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10l9-7 9 7v10.5a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 20.5V10z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M7 13h3v7H7zM14 13h3v7h-3z" />
  </svg>
);

const SettingsIcon = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

const HelpIcon = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827m0 3.75h.007v.008h-.008V17.25zM21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

/* -------------------------------------------------------
   Default nav sections
   ------------------------------------------------------- */
const defaultSections: NavSection[] = [
  {
    title: 'HAUPTMENÜ',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: <DashboardIcon /> },
      { id: 'input', label: 'Erkennen', icon: <IdentifyIcon />, badge: 'AI' },
      { id: 'search', label: 'Produkte', icon: <SearchNavIcon /> },
      { id: 'operations', label: 'Operationen', icon: <OperationsIcon /> },
    ],
  },
  {
    title: 'VERWALTUNG',
    items: [
      { id: 'inventory', label: 'Inventar', icon: <InventoryIcon /> },
      { id: 'ebay-listings', label: 'eBay Listings', icon: <EbayIcon /> },
      { id: 'warehouse', label: 'Lagerverwaltung', icon: <WarehouseIcon /> },
      { id: 'categories', label: 'Kategorien', icon: <HelpIcon /> },
    ],
  },
  {
    title: 'SYSTEM',
    items: [
      { id: 'admin', label: 'Administration', icon: <SettingsIcon /> },
    ],
  },
];

/* -------------------------------------------------------
   Sidebar
   ------------------------------------------------------- */
export const Sidebar: React.FC<SidebarProps> = React.memo(
  ({ currentView, onNavigate, open = false, className = '' }) => {
    const sections = useMemo(() => defaultSections, []);

    return (
      <aside
        className={`
          fixed left-0 top-0 bottom-0
          w-[248px] bg-[var(--avy-deep)]
          flex flex-col
          z-50
          transition-transform duration-300 ease-avy
          md:translate-x-0
          ${open ? 'translate-x-0' : '-translate-x-full'}
          ${className}
        `.trim()}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-5 h-14 flex-shrink-0">
          <img src="/avy_logo.png" alt="avycloud" className="h-8 w-auto object-contain" draggable={false} />
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-5">
          {sections.map((section, sIdx) => (
            <div key={sIdx}>
              {section.title && (
                <p className="px-3 mb-2 text-[11px] font-semibold text-white/35 uppercase tracking-wider">
                  {section.title}
                </p>
              )}
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const isActive = currentView === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onNavigate(item.id)}
                      className={`
                        w-full flex items-center gap-2.5
                        py-1.5 px-3 rounded-md
                        text-[13.5px] font-medium
                        transition-all duration-150
                        relative
                        ${
                          isActive
                            ? 'text-white bg-white/10'
                            : 'text-white/65 hover:text-white hover:bg-white/[0.06]'
                        }
                      `.trim()}
                    >
                      {/* Active bar */}
                      {isActive && (
                        <span
                          className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 bg-[var(--avy-purple)] rounded-r-full"
                          aria-hidden="true"
                        />
                      )}

                      {/* Icon */}
                      <span className="flex-shrink-0 opacity-80">{item.icon}</span>

                      {/* Label */}
                      <span className="flex-1 text-left truncate">{item.label}</span>

                      {/* Badge */}
                      {item.badge && (
                        <span className="text-2xs font-semibold px-1.5 py-0.5 rounded bg-[rgba(99,91,255,0.2)] text-[var(--avy-purple-light)]">
                          {item.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Divider */}
        <div className="h-px bg-white/[0.08] mx-5" />

        {/* Footer: user */}
        <div className="flex items-center gap-3 px-5 py-4 flex-shrink-0">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#635BFF] to-[#0070F3] flex items-center justify-center flex-shrink-0">
            <span className="text-white text-xs font-bold">OG</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium text-white truncate">Oguz</p>
            <p className="text-2xs text-white/40 truncate">Administrator</p>
          </div>
        </div>
      </aside>
    );
  }
);

Sidebar.displayName = 'Sidebar';
