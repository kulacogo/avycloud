import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';

/* -------------------------------------------------------
   Types
   ------------------------------------------------------- */
export interface CommandItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  action: () => void;
  group?: string;
  kbd?: string;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  items: CommandItem[];
  placeholder?: string;
}

/* -------------------------------------------------------
   CommandPalette
   ------------------------------------------------------- */
export const CommandPalette: React.FC<CommandPaletteProps> = React.memo(
  ({ open, onClose, items, placeholder = 'Befehl eingeben...' }) => {
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    /* ---- Filter items ---- */
    const filteredItems = useMemo(() => {
      if (!query.trim()) return items;
      const q = query.toLowerCase();
      return items.filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          item.group?.toLowerCase().includes(q)
      );
    }, [items, query]);

    /* ---- Group filtered items ---- */
    const grouped = useMemo(() => {
      const map = new Map<string, CommandItem[]>();
      for (const item of filteredItems) {
        const group = item.group || '';
        if (!map.has(group)) map.set(group, []);
        map.get(group)!.push(item);
      }
      return map;
    }, [filteredItems]);

    /* ---- Reset on open/close ---- */
    useEffect(() => {
      if (open) {
        setQuery('');
        setActiveIndex(0);
        setTimeout(() => inputRef.current?.focus(), 0);
        document.body.style.overflow = 'hidden';
      } else {
        document.body.style.overflow = '';
      }
      return () => {
        document.body.style.overflow = '';
      };
    }, [open]);

    /* ---- Cmd+K global shortcut ---- */
    useEffect(() => {
      const handler = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
          e.preventDefault();
          if (open) {
            onClose();
          }
        }
      };
      document.addEventListener('keydown', handler);
      return () => document.removeEventListener('keydown', handler);
    }, [open, onClose]);

    /* ---- Keyboard nav ---- */
    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
          onClose();
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActiveIndex((prev) =>
            prev < filteredItems.length - 1 ? prev + 1 : 0
          );
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActiveIndex((prev) =>
            prev > 0 ? prev - 1 : filteredItems.length - 1
          );
          return;
        }
        if (e.key === 'Enter' && filteredItems[activeIndex]) {
          e.preventDefault();
          filteredItems[activeIndex].action();
          onClose();
        }
      },
      [filteredItems, activeIndex, onClose]
    );

    /* ---- Scroll active into view ---- */
    useEffect(() => {
      const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    }, [activeIndex]);

    /* ---- Overlay click ---- */
    const handleOverlayClick = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) onClose();
      },
      [onClose]
    );

    if (!open) return null;

    let flatIndex = -1;

    return (
      <div
        onClick={handleOverlayClick}
        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[200] flex items-start justify-center pt-[15vh] animate-fade-in"
      >
        <div
          className="
            bg-[var(--surface)] border border-[var(--border)]
            rounded-2xl shadow-lg
            max-w-[560px] w-[90vw] overflow-hidden
            animate-slide-down
          "
          onKeyDown={handleKeyDown}
        >
          {/* Search input */}
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--border)]">
            <svg
              className="w-4.5 h-4.5 text-[var(--text-tertiary)] flex-shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              placeholder={placeholder}
              className="
                flex-1 bg-transparent text-sm text-[var(--text-primary)]
                placeholder:text-[var(--text-tertiary)]
                outline-none border-none
              "
            />
            <kbd className="hidden sm:inline-flex text-2xs text-[var(--text-tertiary)] bg-[var(--surface-secondary)] border border-[var(--border)] rounded px-1.5 py-0.5 font-mono">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <div ref={listRef} className="max-h-[320px] overflow-y-auto py-2">
            {filteredItems.length === 0 ? (
              <p className="px-4 py-6 text-sm text-[var(--text-tertiary)] text-center">
                Keine Ergebnisse gefunden
              </p>
            ) : (
              Array.from(grouped.entries()).map(([group, groupItems]) => (
                <div key={group}>
                  {group && (
                    <p className="px-4 pt-3 pb-1.5 text-2xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
                      {group}
                    </p>
                  )}
                  {groupItems.map((item) => {
                    flatIndex++;
                    const idx = flatIndex;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-index={idx}
                        onClick={() => {
                          item.action();
                          onClose();
                        }}
                        onMouseEnter={() => setActiveIndex(idx)}
                        className={`
                          w-full flex items-center gap-2.5 px-4 py-2 rounded-none
                          text-left text-sm transition-colors duration-100
                          ${
                            idx === activeIndex
                              ? 'bg-[var(--surface-secondary)] text-[var(--text-primary)]'
                              : 'text-[var(--text-secondary)]'
                          }
                        `.trim()}
                      >
                        {item.icon && (
                          <span className="flex-shrink-0 [&>svg]:w-4 [&>svg]:h-4 text-[var(--text-tertiary)]">
                            {item.icon}
                          </span>
                        )}
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.kbd && (
                          <kbd className="text-2xs text-[var(--text-tertiary)] bg-[var(--surface-secondary)] border border-[var(--border)] rounded px-1.5 py-0.5 font-mono">
                            {item.kbd}
                          </kbd>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          {/* Footer hints */}
          <div className="flex items-center gap-4 px-4 py-2.5 border-t border-[var(--border)] bg-[var(--surface-secondary)]">
            <span className="inline-flex items-center gap-1 text-2xs text-[var(--text-tertiary)]">
              <kbd className="bg-[var(--surface)] border border-[var(--border)] rounded px-1 py-0.5 font-mono text-2xs">
                &uarr;&darr;
              </kbd>
              Navigieren
            </span>
            <span className="inline-flex items-center gap-1 text-2xs text-[var(--text-tertiary)]">
              <kbd className="bg-[var(--surface)] border border-[var(--border)] rounded px-1 py-0.5 font-mono text-2xs">
                &crarr;
              </kbd>
              Auswaehlen
            </span>
            <span className="inline-flex items-center gap-1 text-2xs text-[var(--text-tertiary)]">
              <kbd className="bg-[var(--surface)] border border-[var(--border)] rounded px-1 py-0.5 font-mono text-2xs">
                Esc
              </kbd>
              Schliessen
            </span>
          </div>
        </div>
      </div>
    );
  }
);

CommandPalette.displayName = 'CommandPalette';
