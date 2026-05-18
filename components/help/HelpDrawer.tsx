import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  fetchHelpArticle,
  fetchHelpIndex,
  type HelpArticle,
  type HelpIndexEntry,
  type HelpIndex,
} from "../../api/help";

interface HelpDrawerProps {
  open: boolean;
  onClose: () => void;
}

type ViewMode = "welcome" | "topic" | "article" | "profi";

interface TopicDef {
  key: string;
  label: string;
  icon: string;
  blurb: string;
}

const TOPICS: TopicDef[] = [
  { key: "produkte", label: "Produkte erfassen & pflegen", icon: "📷", blurb: "Bilder hochladen, KI-Erkennung, Datenblatt." },
  { key: "marktplaetze", label: "Marktplätze & Listings", icon: "🛒", blurb: "eBay und Kaufland live bringen." },
  { key: "bestellungen", label: "Bestellungen & Status", icon: "📦", blurb: "Pipeline, Status, Bearbeitung." },
  { key: "versand", label: "Versand & Labels", icon: "🚚", blurb: "SendCloud, Tracking, Carrier." },
  { key: "retouren", label: "Retouren", icon: "↩️", blurb: "Anfragen, Erstattung, Restock." },
  { key: "rechnungen", label: "Rechnungen", icon: "🧾", blurb: "PDFs, Korrekturen, SevDesk." },
  { key: "lager", label: "Lager & Bestand", icon: "🏷️", blurb: "BINs, Stock-in, Inventur." },
  { key: "erweitert", label: "Erweiterte Workflows", icon: "⚡", blurb: "Bulk-Edits, Profi-Tools." },
];

const VIEW_HINTS: Record<string, string[]> = {
  orders: ["00-quickstart/bestellung-bearbeiten", "00-quickstart/bestellstatus-erklart"],
  "orders-shipping": ["00-quickstart/versand-erstellen"],
  "orders-returns": ["00-quickstart/retoure-bearbeiten"],
  "orders-invoices": ["00-quickstart/rechnung-versenden"],
  shipping: ["00-quickstart/versand-erstellen"],
  returns: ["00-quickstart/retoure-bearbeiten"],
  invoices: ["00-quickstart/rechnung-versenden"],
  inventory: ["00-quickstart/bestand-verwalten"],
  warehouse: ["00-quickstart/bestand-verwalten"],
  input: ["00-quickstart/produkt-erfassen", "00-quickstart/bilder-hochladen"],
  capture: ["00-quickstart/produkt-erfassen"],
  products: ["00-quickstart/produkt-bearbeiten", "00-quickstart/bulk-bearbeitung"],
  sheet: ["00-quickstart/produkt-bearbeiten", "00-quickstart/chat-assistent-nutzen"],
  "marketplace-ebay": ["00-quickstart/auf-ebay-listen"],
  "marketplace-kaufland": ["00-quickstart/auf-kaufland-listen"],
  duplicates: ["00-quickstart/produkt-bearbeiten"],
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
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

const readCurrentAppView = (): string | null => {
  if (typeof window === "undefined") return null;
  const raw = window.location.hash.replace(/^#/, "");
  const m = raw.match(/^\/([\w-]+)/);
  return m ? m[1] : null;
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

// Order quickstart articles by `order` field (frontmatter); fall back to slug.
const sortByOrder = (a: HelpIndexEntry, b: HelpIndexEntry) => {
  const ao = typeof a.order === "number" ? a.order : 999;
  const bo = typeof b.order === "number" ? b.order : 999;
  if (ao !== bo) return ao - bo;
  return a.slug.localeCompare(b.slug);
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
  const [article, setArticle] = useState<HelpArticle | null>(null);
  const [articleLoading, setArticleLoading] = useState(false);
  const [articleError, setArticleError] = useState<string | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  const [view, setView] = useState<ViewMode>("welcome");
  const [activeTopic, setActiveTopic] = useState<string | null>(null);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [permalinkCopied, setPermalinkCopied] = useState(false);
  const [feedbackGiven, setFeedbackGiven] = useState<string | null>(null);

  // Flatten index entries for searching
  const flatEntries = useMemo(() => {
    if (!index) return [] as HelpIndexEntry[];
    const out: HelpIndexEntry[] = [];
    for (const entries of Object.values(index)) {
      if (!Array.isArray(entries)) continue;
      for (const e of entries) {
        if (e && typeof e.slug === "string") out.push(e);
      }
    }
    return out;
  }, [index]);

  // All quickstart entries (user-facing). Always shown in user mode.
  const quickstartEntries = useMemo(() => {
    return flatEntries.filter((e) => e.section === "00-quickstart").sort(sortByOrder);
  }, [flatEntries]);

  // Entries per topic (for the welcome cards + topic view)
  const entriesByTopic = useMemo(() => {
    const map: Record<string, HelpIndexEntry[]> = {};
    for (const e of quickstartEntries) {
      const t = (e.topic || "").trim() || "erweitert";
      if (!map[t]) map[t] = [];
      map[t].push(e);
    }
    for (const k of Object.keys(map)) {
      map[k].sort(sortByOrder);
    }
    return map;
  }, [quickstartEntries]);

  // Contextual suggestions based on current app view (URL hash)
  const contextualHints = useMemo(() => {
    const currentView = readCurrentAppView();
    if (!currentView) return [] as HelpIndexEntry[];
    const slugs = VIEW_HINTS[currentView] || [];
    if (!slugs.length) return [];
    const seen = new Set<string>();
    const out: HelpIndexEntry[] = [];
    for (const slug of slugs) {
      const match = flatEntries.find((e) => e.slug === slug);
      if (match && !seen.has(slug)) {
        seen.add(slug);
        out.push(match);
      }
    }
    return out;
  }, [flatEntries, open]);

  // Search hits across quickstart (or all in profi mode)
  const searchHits = useMemo(() => {
    if (!searchQuery.trim()) return [] as HelpIndexEntry[];
    const q = searchQuery.toLowerCase();
    const source = view === "profi" ? flatEntries : quickstartEntries;
    return source
      .filter((e) =>
        e.title.toLowerCase().includes(q) ||
        (e.topic || "").toLowerCase().includes(q) ||
        e.slug.toLowerCase().includes(q)
      )
      .slice(0, 20);
  }, [searchQuery, flatEntries, quickstartEntries, view]);

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
    setFeedbackGiven(null);
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

  // Load index when drawer opens
  useEffect(() => {
    if (!open) return;
    if (!hasLoadedOnce) {
      void loadIndex();
    }
  }, [open, hasLoadedOnce, loadIndex]);

  // Hash-based deep-link
  useEffect(() => {
    if (!open) return;
    const slugFromHash = readHelpSlugFromHash();
    if (slugFromHash && slugFromHash !== activeSlug) {
      setActiveSlug(slugFromHash);
      setView("article");
    }
  }, [open, activeSlug]);

  // Auto-load article when slug changes
  useEffect(() => {
    if (!open || !activeSlug) return;
    void loadArticle(activeSlug);
  }, [open, activeSlug, loadArticle]);

  // Focus management
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

  // ESC + focus trap
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

  // Body scroll lock
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
      // ignore
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(absolute);
      } else {
        const ta = document.createElement("textarea");
        ta.value = absolute;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setPermalinkCopied(true);
      window.setTimeout(() => setPermalinkCopied(false), 1800);
    } catch {
      setPermalinkCopied(false);
    }
  }, [activeSlug]);

  const handleSelectArticle = useCallback((slug: string) => {
    setActiveSlug(slug);
    setView("article");
    setSearchQuery("");
  }, []);

  const handleSelectTopic = useCallback((topic: string) => {
    setActiveTopic(topic);
    setView("topic");
    setSearchQuery("");
  }, []);

  const handleBackToWelcome = useCallback(() => {
    setView("welcome");
    setActiveTopic(null);
    setActiveSlug(null);
    setArticle(null);
  }, []);

  const handleBackToTopic = useCallback(() => {
    if (activeTopic) {
      setView("topic");
      setActiveSlug(null);
      setArticle(null);
    } else {
      handleBackToWelcome();
    }
  }, [activeTopic, handleBackToWelcome]);

  const togglePremium = useCallback(() => {
    setView((current) => (current === "profi" ? "welcome" : "profi"));
    setActiveTopic(null);
    setActiveSlug(null);
    setArticle(null);
    setSearchQuery("");
  }, []);

  if (!open) return null;

  const showingSearchResults = searchQuery.trim().length > 0 && view !== "article";

  return (
    <div className="fixed inset-0 z-[60] flex justify-end" role="presentation">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-full w-full max-w-[640px] flex-col bg-app-bg text-txt-primary shadow-2xl animate-slide-in-right"
      >
        {/* Top bar: minimal */}
        <header className="relative flex items-center justify-between gap-3 border-b border-app-border px-6 py-3.5">
          {(view === "topic" || view === "article" || view === "profi") && (
            <button
              type="button"
              onClick={view === "article" ? handleBackToTopic : handleBackToWelcome}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-txt-secondary transition-colors hover:bg-app-elevated hover:text-txt-primary focus:outline-none focus:ring-2 focus:ring-accent"
              aria-label="Zurück"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
              <span>Zurück</span>
            </button>
          )}
          {view === "welcome" && (
            <h2 id={titleId} className="text-sm font-medium uppercase tracking-[0.2em] text-txt-muted">
              Hilfe
            </h2>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {view !== "profi" && (
              <button
                type="button"
                onClick={togglePremium}
                className="hidden rounded-md border border-app-border bg-transparent px-2.5 py-1 text-xs font-medium text-txt-secondary transition-colors hover:bg-app-elevated hover:text-txt-primary focus:outline-none focus:ring-2 focus:ring-accent sm:inline-flex"
                title="Erweiterte KB für Entwickler / Admins"
              >
                Profi-Modus
              </button>
            )}
            {view === "profi" && (
              <button
                type="button"
                onClick={handleBackToWelcome}
                className="rounded-md border border-accent/40 bg-accent-dim px-2.5 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent hover:text-white focus:outline-none focus:ring-2 focus:ring-accent"
              >
                Zurück zum User-Modus
              </button>
            )}
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label="Hilfe schließen"
              className="flex h-9 w-9 items-center justify-center rounded-md text-txt-secondary transition-colors hover:bg-app-elevated hover:text-txt-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 6l12 12M6 18L18 6" />
              </svg>
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          {indexLoading && !hasLoadedOnce && (
            <div className="px-6 py-12 text-center text-sm text-txt-muted">Hilfe wird geladen…</div>
          )}

          {indexError && !indexLoading && (
            <div className="m-6 rounded-lg border border-danger/30 bg-danger-dim p-4 text-sm">
              <p className="font-semibold text-danger">Hilfe konnte nicht geladen werden</p>
              <p className="mt-1 text-txt-secondary">{indexError}</p>
              <button
                type="button"
                onClick={() => void loadIndex()}
                className="mt-3 rounded-md border border-app-border bg-app-elevated px-3 py-1.5 text-xs font-semibold text-txt-primary hover:bg-app-bg"
              >
                Erneut versuchen
              </button>
            </div>
          )}

          {!indexError && hasLoadedOnce && (
            <>
              {/* === WELCOME VIEW === */}
              {view === "welcome" && !showingSearchResults && (
                <WelcomeView
                  topics={TOPICS}
                  entriesByTopic={entriesByTopic}
                  contextualHints={contextualHints}
                  searchInputRef={searchInputRef}
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  onSelectTopic={handleSelectTopic}
                  onSelectArticle={handleSelectArticle}
                  onOpenProfi={togglePremium}
                  quickstartCount={quickstartEntries.length}
                  totalCount={flatEntries.length}
                />
              )}

              {/* === SEARCH RESULTS (visible in welcome + topic + profi when searching) === */}
              {showingSearchResults && (
                <SearchResultsView
                  searchInputRef={searchInputRef}
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  hits={searchHits}
                  onSelect={handleSelectArticle}
                  totalSearchedIn={view === "profi" ? flatEntries.length : quickstartEntries.length}
                  profi={view === "profi"}
                />
              )}

              {/* === TOPIC VIEW === */}
              {view === "topic" && activeTopic && !showingSearchResults && (
                <TopicView
                  topic={TOPICS.find((t) => t.key === activeTopic) || null}
                  entries={entriesByTopic[activeTopic] || []}
                  onSelectArticle={handleSelectArticle}
                />
              )}

              {/* === ARTICLE VIEW === */}
              {view === "article" && (
                <ArticleView
                  loading={articleLoading}
                  error={articleError}
                  article={article}
                  slug={activeSlug}
                  onRetry={() => activeSlug && void loadArticle(activeSlug)}
                  permalinkCopied={permalinkCopied}
                  onPermalinkCopy={handlePermalinkCopy}
                  feedbackGiven={feedbackGiven}
                  onFeedback={setFeedbackGiven}
                />
              )}

              {/* === PROFI MODE (full KB) === */}
              {view === "profi" && !showingSearchResults && (
                <ProfiView
                  index={index}
                  searchInputRef={searchInputRef}
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  onSelectArticle={handleSelectArticle}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

/* ============================================================================
   WELCOME VIEW — Hero + Search + Topic Cards + Contextual Hints
============================================================================ */

interface WelcomeViewProps {
  topics: TopicDef[];
  entriesByTopic: Record<string, HelpIndexEntry[]>;
  contextualHints: HelpIndexEntry[];
  searchInputRef: React.RefObject<HTMLInputElement>;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onSelectTopic: (topic: string) => void;
  onSelectArticle: (slug: string) => void;
  onOpenProfi: () => void;
  quickstartCount: number;
  totalCount: number;
}

const WelcomeView: React.FC<WelcomeViewProps> = ({
  topics,
  entriesByTopic,
  contextualHints,
  searchInputRef,
  searchQuery,
  onSearchChange,
  onSelectTopic,
  onSelectArticle,
  onOpenProfi,
  quickstartCount,
  totalCount,
}) => {
  return (
    <div className="px-6 pb-12 pt-2">
      {/* Hero */}
      <section className="pb-6 pt-6">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-accent">Schnellstart</p>
        <h1 className="mt-2 text-3xl font-semibold leading-tight text-txt-primary">
          Hallo. Wie können wir helfen?
        </h1>
        <p className="mt-2 text-sm text-txt-secondary">
          {quickstartCount} Anleitungen rund um Produkte erfassen, listen, versenden und retournieren.
        </p>

        <div className="relative mt-5">
          <svg
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-txt-muted"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Beschreibe in eigenen Worten was du brauchst…"
            className="w-full rounded-xl border border-app-border bg-app-surface py-3.5 pl-11 pr-4 text-[15px] text-txt-primary placeholder:text-txt-muted shadow-sm transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            aria-label="Hilfe durchsuchen"
          />
        </div>
      </section>

      {/* Contextual hints */}
      {contextualHints.length > 0 && (
        <section className="mb-6 rounded-xl border border-accent/20 bg-accent-dim/40 p-4">
          <div className="flex items-center gap-2">
            <span className="text-base" aria-hidden="true">✨</span>
            <p className="text-xs font-medium uppercase tracking-wide text-accent">
              Für deine aktuelle Seite
            </p>
          </div>
          <ul className="mt-2 divide-y divide-app-border/50">
            {contextualHints.map((entry) => (
              <li key={entry.slug}>
                <button
                  type="button"
                  onClick={() => onSelectArticle(entry.slug)}
                  className="group flex w-full items-center justify-between gap-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span className="flex items-center gap-2.5">
                    <span aria-hidden="true">{entry.icon || "📖"}</span>
                    <span className="text-sm font-medium text-txt-primary group-hover:text-accent">
                      {entry.title}
                    </span>
                  </span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-txt-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Topic cards */}
      <section className="space-y-3">
        <h2 className="px-1 text-xs font-medium uppercase tracking-wide text-txt-muted">
          Themen
        </h2>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {topics.map((topic) => {
            const entries = entriesByTopic[topic.key] || [];
            if (entries.length === 0) return null;
            return (
              <button
                key={topic.key}
                type="button"
                onClick={() => onSelectTopic(topic.key)}
                className="group flex flex-col items-start gap-1.5 rounded-xl border border-app-border bg-app-surface p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-dim text-lg" aria-hidden="true">
                  {topic.icon}
                </span>
                <span className="mt-1 text-sm font-semibold leading-tight text-txt-primary group-hover:text-accent">
                  {topic.label}
                </span>
                <span className="text-xs leading-snug text-txt-secondary">{topic.blurb}</span>
                <span className="mt-auto pt-1.5 text-[11px] font-medium text-txt-muted">
                  {entries.length} {entries.length === 1 ? "Anleitung" : "Anleitungen"}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Profi mode trigger */}
      <section className="mt-8 rounded-xl border border-dashed border-app-border bg-transparent p-4">
        <div className="flex items-start gap-3">
          <span className="text-base" aria-hidden="true">🛠️</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-txt-primary">Du bist Entwickler oder Admin?</p>
            <p className="mt-0.5 text-xs text-txt-secondary">
              Architektur, API-Referenz, Datenmodell, Runbooks — {totalCount} Artikel in der vollständigen Knowledge Base.
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenProfi}
            className="shrink-0 rounded-md border border-app-border bg-app-elevated px-3 py-1.5 text-xs font-semibold text-txt-primary hover:bg-app-surface focus:outline-none focus:ring-2 focus:ring-accent"
          >
            Profi-Modus
          </button>
        </div>
      </section>
    </div>
  );
};

/* ============================================================================
   SEARCH RESULTS
============================================================================ */

interface SearchResultsViewProps {
  searchInputRef: React.RefObject<HTMLInputElement>;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  hits: HelpIndexEntry[];
  onSelect: (slug: string) => void;
  totalSearchedIn: number;
  profi: boolean;
}

const SearchResultsView: React.FC<SearchResultsViewProps> = ({
  searchInputRef,
  searchQuery,
  onSearchChange,
  hits,
  onSelect,
  totalSearchedIn,
  profi,
}) => {
  return (
    <div className="px-6 pb-12 pt-4">
      <div className="relative mb-5">
        <svg
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-txt-muted"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
        <input
          ref={searchInputRef}
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Suche…"
          autoFocus
          className="w-full rounded-xl border border-app-border bg-app-surface py-3 pl-11 pr-4 text-[15px] text-txt-primary placeholder:text-txt-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          aria-label="Hilfe durchsuchen"
        />
        <button
          type="button"
          onClick={() => onSearchChange("")}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-txt-muted hover:bg-app-elevated hover:text-txt-primary focus:outline-none focus:ring-2 focus:ring-accent"
          aria-label="Suche schließen"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 6l12 12M6 18L18 6" />
          </svg>
        </button>
      </div>

      <p className="mb-3 text-xs text-txt-muted">
        {hits.length === 0
          ? `Keine Treffer für „${searchQuery}" in ${totalSearchedIn} ${profi ? "KB-Artikeln" : "Anleitungen"}.`
          : `${hits.length} ${hits.length === 1 ? "Treffer" : "Treffer"} in ${totalSearchedIn} ${profi ? "KB-Artikeln" : "Anleitungen"}.`}
      </p>

      {hits.length === 0 && !profi && (
        <div className="rounded-lg border border-app-border bg-app-surface p-4 text-sm text-txt-secondary">
          Nichts gefunden? Versuche andere Stichworte oder wechsle in den Profi-Modus für die vollständige Knowledge Base.
        </div>
      )}

      <ul className="space-y-1.5">
        {hits.map((entry) => (
          <li key={entry.slug}>
            <button
              type="button"
              onClick={() => onSelect(entry.slug)}
              className="group flex w-full items-start gap-3 rounded-lg border border-transparent bg-app-surface p-3 text-left transition-colors hover:border-accent/40 hover:bg-app-elevated focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <span className="mt-0.5 text-lg" aria-hidden="true">{entry.icon || "📖"}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-txt-primary group-hover:text-accent">
                  {entry.title}
                </p>
                <p className="mt-0.5 truncate text-xs text-txt-muted">
                  {entry.section}{entry.topic ? ` · ${entry.topic}` : ""}
                </p>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

/* ============================================================================
   TOPIC VIEW — single topic, list of articles
============================================================================ */

interface TopicViewProps {
  topic: TopicDef | null;
  entries: HelpIndexEntry[];
  onSelectArticle: (slug: string) => void;
}

const TopicView: React.FC<TopicViewProps> = ({ topic, entries, onSelectArticle }) => {
  if (!topic) {
    return <div className="p-6 text-sm text-txt-muted">Thema nicht gefunden.</div>;
  }
  return (
    <div className="px-6 pb-12 pt-4">
      <section className="pb-5">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-dim text-2xl" aria-hidden="true">
            {topic.icon}
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold text-txt-primary">{topic.label}</h1>
            <p className="text-xs text-txt-secondary">{topic.blurb}</p>
          </div>
        </div>
      </section>

      <ul className="divide-y divide-app-border rounded-xl border border-app-border bg-app-surface">
        {entries.map((entry, idx) => (
          <li key={entry.slug}>
            <button
              type="button"
              onClick={() => onSelectArticle(entry.slug)}
              className="group flex w-full items-start gap-4 px-4 py-3.5 text-left transition-colors hover:bg-app-elevated focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-dim text-base" aria-hidden="true">
                {entry.icon || idx + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold text-txt-primary group-hover:text-accent">
                  {entry.title}
                </p>
                <p className="mt-0.5 truncate text-xs text-txt-muted">
                  Anleitung · {formatDate(entry.lastReviewed) || "aktuell"}
                </p>
              </div>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="mt-2 shrink-0 text-txt-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

/* ============================================================================
   ARTICLE VIEW — render markdown with custom step/callout components
============================================================================ */

interface ArticleViewProps {
  loading: boolean;
  error: string | null;
  article: HelpArticle | null;
  slug: string | null;
  onRetry: () => void;
  permalinkCopied: boolean;
  onPermalinkCopy: () => void;
  feedbackGiven: string | null;
  onFeedback: (v: "yes" | "no") => void;
}

const STEP_HEADING_RE = /^Schritt\s+(\d+)\s*[—\-:]\s*(.+)$/;

const ArticleView: React.FC<ArticleViewProps> = ({
  loading,
  error,
  article,
  slug,
  onRetry,
  permalinkCopied,
  onPermalinkCopy,
  feedbackGiven,
  onFeedback,
}) => {
  if (loading) {
    return (
      <div className="px-6 py-12 text-center text-sm text-txt-muted">Artikel wird geladen…</div>
    );
  }
  if (error) {
    return (
      <div className="m-6 rounded-lg border border-danger/30 bg-danger-dim p-4 text-sm">
        <p className="font-semibold text-danger">Artikel nicht verfügbar</p>
        <p className="mt-1 text-txt-secondary">{error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-md border border-app-border bg-app-elevated px-3 py-1.5 text-xs font-semibold text-txt-primary hover:bg-app-bg"
        >
          Erneut versuchen
        </button>
      </div>
    );
  }
  if (!article) {
    return <div className="p-6 text-sm text-txt-muted">{slug || "Artikel auswählen."}</div>;
  }

  // Strip the H1 from the body if it's identical to title (avoid duplication)
  let body = article.content || "";
  const firstHeadingMatch = body.match(/^\s*#\s+(.+)$/m);
  if (firstHeadingMatch && firstHeadingMatch[1].trim() === (article.title || "").trim()) {
    body = body.replace(/^\s*#\s+.+\n+/, "");
  }

  return (
    <article className="px-6 pb-16 pt-3">
      {/* Title block */}
      <header className="pb-5">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-accent">
          {article.icon ? `${article.icon} ${article.topic || "Anleitung"}` : "Anleitung"}
        </p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight text-txt-primary">
          {article.title}
        </h1>
        {article.lastReviewed && (
          <p className="mt-1.5 text-xs text-txt-muted">
            Zuletzt aktualisiert: {formatDate(article.lastReviewed)}
          </p>
        )}
      </header>

      {/* Permalink */}
      <div className="mb-6 flex items-center gap-2">
        <button
          type="button"
          onClick={onPermalinkCopy}
          className="inline-flex items-center gap-1.5 rounded-md border border-app-border bg-transparent px-2.5 py-1 text-xs font-medium text-txt-secondary transition-colors hover:bg-app-elevated hover:text-txt-primary focus:outline-none focus:ring-2 focus:ring-accent"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
            <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
          </svg>
          {permalinkCopied ? "Link kopiert" : "Link kopieren"}
        </button>
      </div>

      {/* Content */}
      <div className="help-prose">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ node, ...props }) => (
              <h1 className="mb-3 mt-8 text-[22px] font-semibold leading-tight text-txt-primary" {...props} />
            ),
            h2: ({ node, children, ...props }) => {
              const text = React.Children.toArray(children).join(" ").trim();
              const stepMatch = typeof text === "string" ? text.match(STEP_HEADING_RE) : null;
              if (stepMatch) {
                const stepNum = stepMatch[1];
                const stepLabel = stepMatch[2];
                return (
                  <div className="mb-3 mt-8 flex items-start gap-3.5" {...(props as any)}>
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-white shadow-sm">
                      {stepNum}
                    </span>
                    <h2 className="text-[18px] font-semibold leading-tight text-txt-primary">
                      {stepLabel}
                    </h2>
                  </div>
                );
              }
              return (
                <h2 className="mb-2 mt-7 text-[18px] font-semibold leading-tight text-txt-primary" {...props}>
                  {children}
                </h2>
              );
            },
            h3: ({ node, ...props }) => (
              <h3 className="mb-2 mt-5 text-[15px] font-semibold leading-tight text-txt-primary" {...props} />
            ),
            p: ({ node, ...props }) => (
              <p className="mb-3.5 text-[15px] leading-[1.7] text-txt-primary" {...props} />
            ),
            a: ({ node, href, ...props }) => (
              <a
                href={href}
                target={href && /^https?:\/\//i.test(href) ? "_blank" : undefined}
                rel={href && /^https?:\/\//i.test(href) ? "noopener noreferrer" : undefined}
                className="text-accent underline-offset-4 hover:underline"
                {...props}
              />
            ),
            strong: ({ node, ...props }) => (
              <strong className="font-semibold text-txt-primary" {...props} />
            ),
            em: ({ node, ...props }) => <em className="italic text-txt-primary" {...props} />,
            ul: ({ node, ...props }) => (
              <ul className="mb-4 ml-5 list-disc space-y-1.5 text-[15px] leading-[1.7] text-txt-primary marker:text-txt-muted" {...props} />
            ),
            ol: ({ node, ...props }) => (
              <ol className="mb-4 ml-5 list-decimal space-y-1.5 text-[15px] leading-[1.7] text-txt-primary marker:text-txt-muted" {...props} />
            ),
            li: ({ node, ...props }) => <li className="pl-1" {...props} />,
            blockquote: ({ node, children, ...props }) => {
              // Detect callout type by first text content
              const raw = React.Children.toArray(children).map((c: any) => {
                if (typeof c === "string") return c;
                return "";
              }).join(" ");
              // We also need to look inside <p> children
              let kind: "tip" | "warning" | "info" = "info";
              const stringified = JSON.stringify(children || "");
              if (/💡|Tipp:/i.test(stringified)) kind = "tip";
              else if (/⚠️|Achtung:|Warnung:/i.test(stringified)) kind = "warning";

              const styles =
                kind === "tip"
                  ? "border-l-4 border-success bg-success-dim/40 text-txt-primary"
                  : kind === "warning"
                  ? "border-l-4 border-warning bg-warning-dim/40 text-txt-primary"
                  : "border-l-4 border-accent bg-accent-dim/40 text-txt-primary";
              return (
                <blockquote
                  className={`my-4 rounded-r-md px-4 py-3 text-[14px] leading-[1.6] ${styles}`}
                  {...props}
                >
                  {children}
                </blockquote>
              );
            },
            code: ({ node, className, children, ...props }: any) => {
              const isBlock = typeof className === "string" && className.startsWith("language-");
              if (isBlock) {
                return (
                  <code
                    className={`block overflow-x-auto rounded-md border border-app-border bg-app-elevated px-3 py-2 font-mono text-[12.5px] leading-[1.6] text-txt-primary ${className || ""}`}
                    {...props}
                  >
                    {children}
                  </code>
                );
              }
              return (
                <code className="rounded bg-app-elevated px-1.5 py-0.5 font-mono text-[12.5px] text-txt-primary" {...props}>
                  {children}
                </code>
              );
            },
            pre: ({ node, ...props }) => (
              <pre className="mb-4 overflow-x-auto rounded-md border border-app-border bg-app-elevated p-3 text-[12.5px] text-txt-primary" {...props} />
            ),
            table: ({ node, ...props }) => (
              <div className="mb-4 overflow-x-auto rounded-lg border border-app-border">
                <table className="min-w-full border-collapse text-sm" {...props} />
              </div>
            ),
            thead: ({ node, ...props }) => <thead className="bg-app-elevated" {...props} />,
            th: ({ node, ...props }) => (
              <th className="border-b border-app-border px-3 py-2 text-left text-[12px] font-semibold text-txt-primary" {...props} />
            ),
            td: ({ node, ...props }) => (
              <td className="border-b border-app-border px-3 py-2 text-[13px] text-txt-primary last:border-b-0" {...props} />
            ),
            tr: ({ node, ...props }) => <tr className="last:[&_td]:border-b-0" {...props} />,
            hr: ({ node, ...props }) => <hr className="my-6 border-app-border" {...props} />,
          }}
        >
          {body}
        </ReactMarkdown>
      </div>

      {/* Feedback footer */}
      <footer className="mt-10 border-t border-app-border pt-6">
        {feedbackGiven === null && (
          <div className="flex flex-col items-center gap-3 text-center sm:flex-row sm:justify-center sm:gap-4">
            <p className="text-sm text-txt-secondary">War das hilfreich?</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onFeedback("yes")}
                className="flex items-center gap-1.5 rounded-md border border-app-border bg-app-surface px-3 py-1.5 text-sm font-medium text-txt-primary transition-colors hover:border-success/50 hover:bg-success-dim focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <span aria-hidden="true">👍</span>
                <span>Ja</span>
              </button>
              <button
                type="button"
                onClick={() => onFeedback("no")}
                className="flex items-center gap-1.5 rounded-md border border-app-border bg-app-surface px-3 py-1.5 text-sm font-medium text-txt-primary transition-colors hover:border-warning/50 hover:bg-warning-dim focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <span aria-hidden="true">👎</span>
                <span>Nein</span>
              </button>
            </div>
          </div>
        )}
        {feedbackGiven === "yes" && (
          <p className="text-center text-sm text-txt-secondary">Schön! Wir freuen uns, wenn es geholfen hat. 🙏</p>
        )}
        {feedbackGiven === "no" && (
          <p className="text-center text-sm text-txt-secondary">
            Danke für das Feedback. Sag dem Team gerne, was unklar war — wir bessern nach.
          </p>
        )}
      </footer>
    </article>
  );
};

/* ============================================================================
   PROFI VIEW — full KB grouped by section (advanced users only)
============================================================================ */

interface ProfiViewProps {
  index: HelpIndex | null;
  searchInputRef: React.RefObject<HTMLInputElement>;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onSelectArticle: (slug: string) => void;
}

const ProfiView: React.FC<ProfiViewProps> = ({
  index,
  searchInputRef,
  searchQuery,
  onSearchChange,
  onSelectArticle,
}) => {
  const sections = useMemo(() => {
    if (!index) return [] as { section: string; entries: HelpIndexEntry[] }[];
    return Object.entries(index)
      .filter(([section]) => section !== "00-quickstart")
      .map(([section, entries]) => ({ section, entries: Array.isArray(entries) ? entries : [] }))
      .filter((s) => s.entries.length > 0)
      .sort((a, b) => a.section.localeCompare(b.section));
  }, [index]);

  return (
    <div className="px-6 pb-12 pt-2">
      <section className="pb-4 pt-4">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-accent">Profi-Modus</p>
        <h1 className="mt-2 text-2xl font-semibold leading-tight text-txt-primary">
          Vollständige Knowledge Base
        </h1>
        <p className="mt-1.5 text-sm text-txt-secondary">
          Architektur, API, Datenmodell, Rules &amp; Invariants, Runbooks.
        </p>
        <div className="relative mt-4">
          <svg
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-txt-muted"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Durchsuche die gesamte KB…"
            className="w-full rounded-xl border border-app-border bg-app-surface py-3 pl-11 pr-4 text-[15px] text-txt-primary placeholder:text-txt-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            aria-label="Knowledge Base durchsuchen"
          />
        </div>
      </section>

      {sections.map(({ section, entries }) => (
        <details
          key={section}
          className="group mb-2 rounded-lg border border-app-border bg-app-surface"
        >
          <summary className="flex cursor-pointer items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-txt-primary marker:hidden">
            <span className="font-mono text-xs uppercase tracking-wider text-txt-muted">{section}</span>
            <span className="text-xs text-txt-muted">{entries.length}</span>
          </summary>
          <ul className="divide-y divide-app-border border-t border-app-border">
            {entries.map((entry) => (
              <li key={entry.slug}>
                <button
                  type="button"
                  onClick={() => onSelectArticle(entry.slug)}
                  className="block w-full px-4 py-2.5 text-left text-sm text-txt-secondary transition-colors hover:bg-app-elevated hover:text-txt-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {entry.title}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
};

export default HelpDrawer;
