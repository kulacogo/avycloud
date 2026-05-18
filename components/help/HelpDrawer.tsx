import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  fetchHelpArticle,
  fetchHelpIndex,
  type HelpArticle,
  type HelpIndex,
  type HelpIndexEntry,
} from "../../api/help";

interface HelpDrawerProps {
  open: boolean;
  onClose: () => void;
}

type PersonaKey = "user" | "dev" | "agent" | "admin" | "manager";

const PERSONAS: { key: PersonaKey; label: string }[] = [
  { key: "user", label: "User" },
  { key: "manager", label: "Manager" },
  { key: "admin", label: "Admin" },
  { key: "dev", label: "Dev" },
  { key: "agent", label: "Agent" },
];

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

const readHelpSlugFromHash = (): string | null => {
  if (typeof window === "undefined") return null;
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return null;
  const directMatch = raw.match(/^help=([^&/?]+)/i);
  if (directMatch) return decodeURIComponent(directMatch[1]);
  const queryPart = raw.split("?")[1];
  if (queryPart) {
    try {
      const params = new URLSearchParams(queryPart);
      const helpSlug = params.get("help");
      if (helpSlug) return decodeURIComponent(helpSlug);
    } catch {
      // ignore malformed query
    }
  }
  return null;
};

const matchesQuery = (entry: HelpIndexEntry, section: string, query: string): boolean => {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    entry.title.toLowerCase().includes(q) ||
    section.toLowerCase().includes(q) ||
    entry.slug.toLowerCase().includes(q)
  );
};

const matchesPersona = (entry: HelpIndexEntry, persona: PersonaKey | null): boolean => {
  if (!persona) return true;
  if (!Array.isArray(entry.for) || entry.for.length === 0) return true;
  return entry.for.includes(persona);
};

const formatDate = (value: string | undefined): string => {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  try {
    return parsed.toLocaleDateString("de-DE", { year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return parsed.toISOString().slice(0, 10);
  }
};

export const HelpDrawer: React.FC<HelpDrawerProps> = ({ open, onClose }) => {
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const lastActiveRef = useRef<HTMLElement | null>(null);
  const titleId = React.useId();

  const [index, setIndex] = useState<HelpIndex | null>(null);
  const [indexLoading, setIndexLoading] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [article, setArticle] = useState<HelpArticle | null>(null);
  const [articleLoading, setArticleLoading] = useState(false);
  const [articleError, setArticleError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activePersona, setActivePersona] = useState<PersonaKey | null>(null);
  const [permalinkCopied, setPermalinkCopied] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  const flatEntries = useMemo(() => {
    if (!index) return [] as { section: string; entry: HelpIndexEntry }[];
    const out: { section: string; entry: HelpIndexEntry }[] = [];
    for (const [section, entries] of Object.entries(index)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (entry && typeof entry.slug === "string") {
          out.push({ section, entry });
        }
      }
    }
    return out;
  }, [index]);

  const filteredBySection = useMemo(() => {
    const sections: { section: string; entries: HelpIndexEntry[] }[] = [];
    if (!index) return sections;
    for (const [section, entries] of Object.entries(index)) {
      if (!Array.isArray(entries)) continue;
      const visible = entries.filter(
        (entry) => matchesPersona(entry, activePersona) && matchesQuery(entry, section, searchQuery)
      );
      if (visible.length > 0) {
        sections.push({ section, entries: visible });
      }
    }
    return sections;
  }, [index, activePersona, searchQuery]);

  const loadIndex = useCallback(async () => {
    setIndexLoading(true);
    setIndexError(null);
    try {
      const result = await fetchHelpIndex();
      setIndex(result || {});
      setHasLoadedOnce(true);
    } catch (err: any) {
      setIndex({});
      setIndexError(err?.message || "Hilfe-Index konnte nicht geladen werden.");
    } finally {
      setIndexLoading(false);
    }
  }, []);

  const loadArticle = useCallback(async (slug: string) => {
    setArticleLoading(true);
    setArticleError(null);
    try {
      const result = await fetchHelpArticle(slug);
      setArticle(result);
    } catch (err: any) {
      setArticle(null);
      setArticleError(err?.message || `Artikel "${slug}" konnte nicht geladen werden.`);
    } finally {
      setArticleLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    if (!hasLoadedOnce) {
      void loadIndex();
    }
  }, [open, hasLoadedOnce, loadIndex]);

  useEffect(() => {
    if (!open) return;
    const slugFromHash = readHelpSlugFromHash();
    if (slugFromHash && slugFromHash !== activeSlug) {
      setActiveSlug(slugFromHash);
    }
  }, [open, activeSlug]);

  useEffect(() => {
    if (!open) return;
    if (activeSlug) return;
    if (!flatEntries.length) return;
    const first = flatEntries[0];
    if (first) setActiveSlug(first.entry.slug);
  }, [open, activeSlug, flatEntries]);

  useEffect(() => {
    if (!open) return;
    if (!activeSlug) return;
    void loadArticle(activeSlug);
  }, [open, activeSlug, loadArticle]);

  useEffect(() => {
    if (!open) return;
    lastActiveRef.current = (document.activeElement as HTMLElement) || null;
    const timer = window.setTimeout(() => {
      const target = searchInputRef.current || closeButtonRef.current;
      target?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.setTimeout(() => lastActiveRef.current?.focus?.(), 0);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const container = drawerRef.current;
      if (!container) return;
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => !el.hasAttribute("disabled") && el.tabIndex >= 0 && !el.getAttribute("aria-hidden")
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (!active || active === first || !container.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (!active || active === last || !container.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  const handlePermalinkCopy = useCallback(async () => {
    if (!activeSlug) return;
    const permalink = `#help=${encodeURIComponent(activeSlug)}`;
    let absolute = permalink;
    try {
      if (typeof window !== "undefined" && window.location) {
        const base = `${window.location.origin}${window.location.pathname}`;
        absolute = `${base}${permalink}`;
      }
    } catch {
      // keep relative permalink
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(absolute);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = absolute;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "absolute";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setPermalinkCopied(true);
      window.setTimeout(() => setPermalinkCopied(false), 1800);
    } catch (err) {
      setPermalinkCopied(false);
    }
  }, [activeSlug]);

  const handleSelectArticle = useCallback((slug: string) => {
    setActiveSlug(slug);
  }, []);

  const handlePersonaToggle = useCallback((persona: PersonaKey) => {
    setActivePersona((current) => (current === persona ? null : persona));
  }, []);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex justify-end"
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-black/40 transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-full w-full max-w-5xl flex-col border-l border-app-border bg-app-surface text-txt-primary shadow-app animate-slide-in-right"
      >
        <header className="flex items-center justify-between gap-3 border-b border-app-border bg-app-bg px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-lg font-semibold text-txt-primary">
              Hilfe & Wissensdatenbank
            </h2>
            <p className="truncate text-xs text-txt-muted">
              Anleitungen, Architektur und Workflows aus der AvyCloud Knowledge Base.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Hilfe schließen"
            className="flex h-9 w-9 items-center justify-center rounded-md text-txt-secondary hover:bg-app-elevated hover:text-txt-primary focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 6l12 12M6 18L18 6" />
            </svg>
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="flex w-full flex-col border-b border-app-border bg-app-bg md:w-80 md:min-w-[16rem] md:max-w-sm md:border-b-0 md:border-r">
            <div className="space-y-3 border-b border-app-border px-4 py-3">
              <label className="block">
                <span className="sr-only">Hilfe durchsuchen</span>
                <input
                  ref={searchInputRef}
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Suche in der Hilfe…"
                  className="w-full rounded-md border border-app-border bg-app-elevated px-3 py-2 text-sm text-txt-primary placeholder:text-txt-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                  aria-label="Hilfe durchsuchen"
                />
              </label>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Nach Persona filtern">
                {PERSONAS.map((persona) => {
                  const active = activePersona === persona.key;
                  return (
                    <button
                      key={persona.key}
                      type="button"
                      onClick={() => handlePersonaToggle(persona.key)}
                      aria-pressed={active}
                      className={
                        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-accent " +
                        (active
                          ? "border-accent bg-accent text-white"
                          : "border-app-border bg-app-elevated text-txt-secondary hover:bg-accent-dim hover:text-txt-primary")
                      }
                    >
                      {persona.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <nav
              className="flex-1 overflow-y-auto px-2 py-2"
              aria-label="Hilfe-Artikelverzeichnis"
            >
              {indexLoading && !hasLoadedOnce && (
                <div className="px-3 py-2 text-sm text-txt-muted">Lade Hilfe…</div>
              )}
              {indexError && (
                <div className="m-2 rounded-md border border-danger/30 bg-danger-dim p-3 text-xs text-txt-primary">
                  <p className="font-semibold text-danger">Index nicht verfügbar</p>
                  <p className="mt-1 text-txt-secondary">{indexError}</p>
                  <button
                    type="button"
                    onClick={() => void loadIndex()}
                    className="mt-2 rounded-md border border-app-border bg-app-elevated px-2 py-1 text-xs font-semibold text-txt-primary hover:bg-app-bg"
                  >
                    Erneut versuchen
                  </button>
                </div>
              )}
              {!indexLoading && !indexError && filteredBySection.length === 0 && hasLoadedOnce && (
                <div className="px-3 py-2 text-sm text-txt-muted">Keine Treffer.</div>
              )}
              {filteredBySection.map(({ section, entries }) => (
                <div key={section} className="mb-2">
                  <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-txt-muted">
                    {section}
                  </div>
                  <ul className="space-y-0.5">
                    {entries.map((entry) => {
                      const active = entry.slug === activeSlug;
                      return (
                        <li key={entry.slug}>
                          <button
                            type="button"
                            onClick={() => handleSelectArticle(entry.slug)}
                            aria-current={active ? "true" : undefined}
                            className={
                              "block w-full truncate rounded-md px-3 py-1.5 text-left text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-accent " +
                              (active
                                ? "bg-accent-dim text-txt-primary"
                                : "text-txt-secondary hover:bg-app-elevated hover:text-txt-primary")
                            }
                            title={entry.title}
                          >
                            {entry.title}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </nav>
          </aside>

          <section className="flex min-h-0 flex-1 flex-col bg-app-surface">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-app-border bg-app-bg px-5 py-3">
              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold text-txt-primary">
                  {article?.title || (activeSlug ? activeSlug : "Artikel auswählen")}
                </h3>
                <p className="text-xs text-txt-muted">
                  {article?.lastReviewed
                    ? `Zuletzt geprüft: ${formatDate(article.lastReviewed)}`
                    : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {Array.isArray(article?.for) && article!.for.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {article!.for.map((persona) => (
                      <span
                        key={persona}
                        className="rounded-full border border-app-border bg-app-elevated px-2 py-0.5 text-[11px] text-txt-secondary"
                      >
                        {persona}
                      </span>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void handlePermalinkCopy()}
                  disabled={!activeSlug}
                  className="inline-flex items-center gap-1.5 rounded-md border border-app-border bg-app-elevated px-2.5 py-1 text-xs font-semibold text-txt-secondary hover:bg-app-bg hover:text-txt-primary focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
                  aria-label="Permalink zu diesem Artikel kopieren"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
                    <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
                  </svg>
                  {permalinkCopied ? "Kopiert" : "Permalink"}
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-5">
              {!activeSlug && !articleLoading && (
                <div className="text-sm text-txt-muted">
                  Wähle links einen Artikel aus oder verwende die Suche.
                </div>
              )}
              {articleLoading && (
                <div className="text-sm text-txt-muted">Lade Artikel…</div>
              )}
              {articleError && !articleLoading && (
                <div className="rounded-md border border-danger/30 bg-danger-dim p-3 text-sm">
                  <p className="font-semibold text-danger">Artikel nicht verfügbar</p>
                  <p className="mt-1 text-txt-secondary">{articleError}</p>
                  {activeSlug && (
                    <button
                      type="button"
                      onClick={() => void loadArticle(activeSlug)}
                      className="mt-2 rounded-md border border-app-border bg-app-elevated px-2 py-1 text-xs font-semibold text-txt-primary hover:bg-app-bg"
                    >
                      Erneut versuchen
                    </button>
                  )}
                </div>
              )}
              {!articleLoading && !articleError && article?.content && (
                <article className="help-drawer-prose max-w-none text-sm leading-relaxed text-txt-primary">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({ node, ...props }) => (
                        <h1 className="mb-3 mt-4 text-xl font-semibold text-txt-primary" {...props} />
                      ),
                      h2: ({ node, ...props }) => (
                        <h2 className="mb-2 mt-4 text-lg font-semibold text-txt-primary" {...props} />
                      ),
                      h3: ({ node, ...props }) => (
                        <h3 className="mb-2 mt-3 text-base font-semibold text-txt-primary" {...props} />
                      ),
                      p: ({ node, ...props }) => (
                        <p className="mb-3 text-sm text-txt-primary" {...props} />
                      ),
                      a: ({ node, href, ...props }) => (
                        <a
                          href={href}
                          target={href && /^https?:\/\//i.test(href) ? "_blank" : undefined}
                          rel={href && /^https?:\/\//i.test(href) ? "noopener noreferrer" : undefined}
                          className="text-accent underline-offset-2 hover:underline"
                          {...props}
                        />
                      ),
                      ul: ({ node, ...props }) => (
                        <ul className="mb-3 ml-5 list-disc text-sm text-txt-primary" {...props} />
                      ),
                      ol: ({ node, ...props }) => (
                        <ol className="mb-3 ml-5 list-decimal text-sm text-txt-primary" {...props} />
                      ),
                      li: ({ node, ...props }) => <li className="mb-1" {...props} />,
                      blockquote: ({ node, ...props }) => (
                        <blockquote
                          className="my-3 border-l-4 border-accent bg-accent-dim/30 px-3 py-2 text-sm text-txt-secondary"
                          {...props}
                        />
                      ),
                      code: ({ node, className, children, ...props }) => {
                        const isBlock = typeof className === "string" && className.startsWith("language-");
                        if (isBlock) {
                          return (
                            <code
                              className={
                                "block overflow-x-auto rounded-md bg-app-elevated px-3 py-2 font-mono text-xs text-txt-primary " +
                                (className || "")
                              }
                              {...props}
                            >
                              {children}
                            </code>
                          );
                        }
                        return (
                          <code
                            className="rounded bg-app-elevated px-1 py-0.5 font-mono text-[12px] text-txt-primary"
                            {...props}
                          >
                            {children}
                          </code>
                        );
                      },
                      pre: ({ node, ...props }) => (
                        <pre className="mb-3 overflow-x-auto rounded-md bg-app-elevated p-3 text-xs text-txt-primary" {...props} />
                      ),
                      table: ({ node, ...props }) => (
                        <div className="mb-3 overflow-x-auto">
                          <table className="min-w-full border-collapse text-sm" {...props} />
                        </div>
                      ),
                      th: ({ node, ...props }) => (
                        <th
                          className="border border-app-border bg-app-elevated px-2 py-1 text-left text-xs font-semibold text-txt-primary"
                          {...props}
                        />
                      ),
                      td: ({ node, ...props }) => (
                        <td className="border border-app-border px-2 py-1 text-xs text-txt-primary" {...props} />
                      ),
                      hr: ({ node, ...props }) => (
                        <hr className="my-4 border-app-border" {...props} />
                      ),
                    }}
                  >
                    {article.content}
                  </ReactMarkdown>
                </article>
              )}
              {!articleLoading && !articleError && article && !article.content && (
                <div className="text-sm text-txt-muted">Artikel ist leer.</div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default HelpDrawer;
