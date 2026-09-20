import React from "react";
import { useQuery } from "@tanstack/react-query";
import { adminGetPerformance } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { RefreshIcon, SearchIcon } from "../icons/Icons";
import { useTeamDirectory } from "./useTeamDirectory";
import {
  METRICS,
  normalizeSearch,
  metricValue,
  hasActivity,
  performanceRows,
} from "./teamWorkspaceModel";
import {
  buildContributions,
  creditedCount,
  CONTRIBUTION_WEIGHTS,
  CONTRIBUTION_MODEL_VERSION,
  CONTRIBUTION_STATUS,
} from "./workContribution";
import { roleDisplayName } from "./roleCatalog";
import {
  TeamAvatar,
  TeamEmpty,
  TeamError,
  TeamSkeleton,
  fieldClass,
  secondaryButton,
} from "./TeamPrimitives";

type Range = "today" | "week" | "month";
const RANGES: { id: Range; label: string }[] = [
  { id: "today", label: "Heute" },
  { id: "week", label: "7 Tage" },
  { id: "month", label: "30 Tage" },
];
const number = (value: number) => value.toLocaleString("de-DE");
export const MitarbeiterLeistung: React.FC<{
  active?: boolean;
  selectedUid?: string | null;
  onSelectUser?: (uid: string | null) => void;
}> = ({ active = true, selectedUid, onSelectUser }) => {
  const { user } = useAuth();
  const directory = useTeamDirectory();
  const [range, setRange] = React.useState<Range>("week");
  const [custom, setCustom] = React.useState<{ from: string; to: string }>();
  const [showDates, setShowDates] = React.useState(false);
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [onlyActive, setOnlyActive] = React.useState(false);
  const [localUid, setLocalUid] = React.useState<string | null>(null);
  const [sort, setSort] = React.useState("contribution");
  const detailRef = React.useRef<HTMLElement>(null);
  const focusDetail = React.useRef(false);
  const selected = selectedUid === undefined ? localUid : selectedUid;
  const select = (uid: string | null) => {
    focusDetail.current = Boolean(uid);
    setLocalUid(uid);
    onSelectUser?.(uid);
  };
  const result = useQuery({
    queryKey: ["team-performance", user?.uid, range, custom?.from, custom?.to],
    queryFn: () => adminGetPerformance(range, custom),
    enabled: active && Boolean(user?.uid),
    staleTime: 60000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const rows = React.useMemo(
    () => performanceRows(result.data?.rows || [], directory.data || []),
    [result.data, directory.data],
  );
  const complete =
    result.data?.dataQuality?.complete === true &&
    !result.error &&
    !directory.error &&
    !directory.isPending;
  const contributions = React.useMemo(
    () => buildContributions(rows, directory.data || [], complete),
    [rows, directory.data, complete],
  );
  const needle = normalizeSearch(query.trim());
  const filtered = contributions.filter(
    (row) =>
      (!onlyActive || hasActivity(row)) &&
      normalizeSearch(`${row.name} ${row.email || ""}`).includes(needle),
  );
  const ordered =
    sort === "name"
      ? [...filtered].sort((a, b) => a.name.localeCompare(b.name, "de"))
      : filtered;
  const selectedRow = contributions.find((row) => row.uid === selected);
  React.useEffect(() => {
    if (selectedRow && focusDetail.current) {
      focusDetail.current = false;
      if (window.matchMedia("(max-width: 1279px)").matches) {
        detailRef.current?.focus({ preventScroll: true });
        detailRef.current?.scrollIntoView({
          block: "nearest",
          behavior: "instant",
        });
      }
    }
  }, [selectedRow?.uid]);
  const maximum = Math.max(1, ...contributions.map((row) => row.points || 0));
  const formatShare = (share: number) =>
    share < 0.1
      ? "< 0,1"
      : share.toLocaleString("de-DE", { maximumFractionDigits: 1 });
  const periodLabel = custom
    ? `${new Date(`${custom.from}T12:00:00Z`).toLocaleDateString("de-DE")} – ${new Date(`${custom.to}T12:00:00Z`).toLocaleDateString("de-DE")}`
    : range === "today"
      ? "Heute ab 00:00 UTC"
      : range === "week"
        ? "Letzte 7 Tage"
        : "Letzte 30 Tage";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            Leistungsbeitrag im Überblick
          </h2>
          <p className="mt-1 text-sm text-txt-secondary">
            Gesamten Arbeitsbeitrag vergleichen. Mitarbeiter auswählen, um die
            einzelnen Tätigkeiten zu sehen.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-xl border border-app-border bg-app-surface p-1">
            {RANGES.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-pressed={!custom && range === item.id}
                onClick={() => {
                  setRange(item.id);
                  setCustom(undefined);
                  setShowDates(false);
                }}
                className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${!custom && range === item.id ? "bg-accent-dim text-accent" : "text-txt-muted hover:bg-app-elevated"}`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-expanded={showDates}
            className={secondaryButton}
            onClick={() => setShowDates((value) => !value)}
          >
            Zeitraum
          </button>
          <button
            type="button"
            aria-label="Leistung aktualisieren"
            disabled={result.isFetching}
            className={secondaryButton}
            onClick={() => result.refetch()}
          >
            <RefreshIcon
              className={`h-4 w-4 ${result.isFetching ? "motion-safe:animate-spin" : ""}`}
            />
          </button>
        </div>
      </div>
      {showDates && (
        <form
          className="flex flex-wrap items-end gap-3 rounded-2xl border border-app-border bg-app-surface p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (from && to && from <= to) {
              setCustom({ from, to });
              setShowDates(false);
            }
          }}
        >
          <label className="min-w-[135px] flex-1 text-xs text-txt-secondary">
            Von
            <input
              type="date"
              required
              value={from}
              max={to || undefined}
              onChange={(event) => setFrom(event.target.value)}
              className={`${fieldClass} mt-1`}
            />
          </label>
          <label className="min-w-[135px] flex-1 text-xs text-txt-secondary">
            Bis
            <input
              type="date"
              required
              value={to}
              min={from || undefined}
              onChange={(event) => setTo(event.target.value)}
              className={`${fieldClass} mt-1`}
            />
          </label>
          <button
            type="submit"
            disabled={!from || !to || from > to}
            className={secondaryButton}
          >
            Anwenden
          </button>
          <p className="w-full text-xs text-txt-muted">
            Datumsgrenzen gelten in UTC. Der letzte Tag wird vollständig
            berücksichtigt.
          </p>
        </form>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-txt-muted">
        <span className="font-medium text-txt-secondary">{periodLabel}</span>
        <span aria-live="polite">
          {result.isFetching
            ? "Daten werden geladen …"
            : result.error
              ? "Aktualisierung fehlgeschlagen"
              : result.dataUpdatedAt
                ? `Geladen um ${new Date(result.dataUpdatedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`
                : ""}
        </span>
      </div>
      {result.error && (
        <TeamError
          message={result.error.message}
          onRetry={() => result.refetch()}
        />
      )}
      {directory.error && (
        <TeamError
          message="Kontonamen konnten nicht aktualisiert werden. Vorhandene Tätigkeiten werden weiterhin angezeigt."
          onRetry={() => directory.refetch()}
        />
      )}
      {result.isPending ? (
        <TeamSkeleton />
      ) : (
        result.data && (
          <>
            {!complete && (
              <div
                role="status"
                className="rounded-xl border border-warning/30 bg-warning-dim p-4 text-sm text-warning"
              >
                Die Datenabdeckung ist nicht vollständig bestätigt.
                Gesamtbewertung und Rangfolge bleiben ausgesetzt; verfügbare
                Einzelzahlen sind in den Mitarbeiterdetails sichtbar.
                <button
                  type="button"
                  className="ml-2 font-semibold underline"
                  onClick={() => {
                    result.refetch();
                    directory.refetch();
                  }}
                >
                  Erneut laden
                </button>
              </div>
            )}
            <div className="space-y-2">
              <p className="text-xs font-medium text-txt-muted">
                Erfasste Tätigkeiten im gesamten Team
                {!complete ? " · unvollständig" : ""}
              </p>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                {METRICS.map((item) => (
                  <div
                    key={item.key}
                    className="relative overflow-hidden rounded-2xl border border-app-border bg-app-surface p-4"
                  >
                    <span className="text-xs font-medium text-txt-secondary">
                      {item.label}
                    </span>
                    <span className="mt-3 block text-3xl font-semibold tracking-tight tabular-nums">
                      {result.data?.dataQuality?.sources?.[
                        item.key === "erfasst" || item.key === "angereichert"
                          ? "audit"
                          : item.key === "eingelagert"
                            ? "warehouse"
                            : "orders"
                      ] === "unavailable"
                        ? "—"
                        : number(
                            rows.reduce(
                              (sum, row) => sum + metricValue(row, item.key),
                              0,
                            ),
                          )}
                    </span>
                    <span className="mt-1 block text-xs text-txt-muted">
                      {item.unit}
                    </span>
                    <span
                      className="absolute bottom-0 left-0 h-1 w-full opacity-30"
                      style={{ background: item.color }}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
              <section className="min-w-0 overflow-hidden rounded-2xl border border-app-border bg-app-surface">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-app-border p-5">
                  <div>
                    <h3 className="font-semibold">Gesamtbeitrag im Team</h3>
                    <p className="mt-1 max-w-lg text-xs leading-relaxed text-txt-muted">
                      Alle fünf Tätigkeiten fließen nach ihrer Gewichtung ein.
                      Die Punkte zeigen den erfassten Arbeitsumfang, keine
                      Leistung pro Arbeitsstunde.
                    </p>
                  </div>
                  <span className="rounded-lg bg-accent-dim px-2.5 py-1.5 text-xs font-medium text-accent">
                    {CONTRIBUTION_MODEL_VERSION}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3 px-5 pt-4">
                  <label className="relative min-w-[160px] flex-1">
                    <SearchIcon className="absolute left-3 top-3 h-4 w-4 text-txt-muted" />
                    <input
                      aria-label="Leistung nach Name oder E-Mail filtern"
                      placeholder="Mitarbeiter suchen …"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      className={`${fieldClass} pl-10`}
                    />
                  </label>
                  <select
                    aria-label="Leistungsübersicht sortieren"
                    value={sort}
                    onChange={(event) => setSort(event.target.value)}
                    className={`${fieldClass} sm:!w-44`}
                  >
                    <option value="contribution">Nach Arbeitsbeitrag</option>
                    <option value="name">Nach Name</option>
                  </select>
                  <label className="flex items-center gap-2 text-xs text-txt-secondary">
                    <input
                      type="checkbox"
                      checked={onlyActive}
                      onChange={(event) => setOnlyActive(event.target.checked)}
                      className="accent-accent"
                    />
                    Nur mit Tätigkeit
                  </label>
                </div>
                {ordered.length === 0 ? (
                  <div className="p-5">
                    <TeamEmpty title="Keine passenden Konten">
                      Passe die Suche oder den Tätigkeitsfilter an.
                    </TeamEmpty>
                  </div>
                ) : (
                  <div className="space-y-1 p-3">
                    {ordered.map((row) => (
                      <button
                        type="button"
                        key={row.uid}
                        aria-pressed={selected === row.uid}
                        aria-label={`Leistungsdetails ansehen: ${row.name}`}
                        onClick={() =>
                          select(selected === row.uid ? null : row.uid)
                        }
                        className={`flex w-full items-start gap-3 rounded-xl p-3 text-left transition hover:bg-app-elevated ${selected === row.uid ? "bg-accent-dim ring-1 ring-inset ring-accent" : ""}`}
                      >
                        <TeamAvatar name={row.name} role={row.role} small />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                            <span className="min-w-0">
                              <span className="block break-words text-sm font-semibold">
                                {row.name}
                              </span>
                              <span className="mt-1 block text-[11px] text-txt-muted">
                                {roleDisplayName(row.role)}
                              </span>
                            </span>
                            <span
                              className={`shrink-0 text-right ${row.status === "rated" ? "text-accent" : "text-txt-muted"}`}
                            >
                              {row.status === "rated" ? (
                                <>
                                  <span className="block text-base font-semibold tabular-nums">
                                    {number(row.points!)}{" "}
                                    <span className="text-xs font-medium">
                                      Punkte
                                    </span>
                                  </span>
                                  <span className="mt-0.5 block text-[11px] text-txt-muted">
                                    {formatShare(row.share!)} % Teamanteil
                                  </span>
                                </>
                              ) : (
                                <span className="text-xs">
                                  {CONTRIBUTION_STATUS[row.status]}
                                </span>
                              )}
                            </span>
                          </span>
                          {row.status === "rated" && (
                            <span className="mt-3 block h-2 overflow-hidden rounded-full bg-app-elevated">
                              <span
                                className="block h-full rounded-full bg-accent motion-safe:transition-[width] motion-safe:duration-300"
                                style={{
                                  width: `${(row.points! / maximum) * 100}%`,
                                }}
                              />
                            </span>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <p className="border-t border-app-border px-5 py-3 text-xs leading-relaxed text-txt-muted">
                  {filtered.length} von {rows.length} Konten · Der Teamanteil
                  bezieht sich auf alle bewertbaren Konten im Zeitraum und
                  bleibt beim Filtern unverändert.
                </p>
              </section>
              {selectedRow ? (
                <aside
                  ref={detailRef}
                  tabIndex={-1}
                  aria-label={`Leistungsdetails ${selectedRow.name}`}
                  className="order-first min-w-0 rounded-2xl border border-accent bg-app-surface p-5 outline-none xl:sticky xl:top-4 xl:order-last"
                >
                  <div className="flex items-start justify-between gap-3">
                    <TeamAvatar
                      name={selectedRow.name}
                      role={selectedRow.role}
                    />
                    <button
                      type="button"
                      aria-label="Leistungsdetails schließen"
                      onClick={() => select(null)}
                      className="rounded-lg px-2 py-1 text-txt-muted hover:bg-app-elevated"
                    >
                      ×
                    </button>
                  </div>
                  <h3 className="mt-4 break-words font-semibold">
                    {selectedRow.name}
                  </h3>
                  <p className="mt-1 break-all text-xs text-txt-muted">
                    {selectedRow.email}
                  </p>
                  <div className="my-4 rounded-xl bg-accent-dim p-4">
                    <p className="text-xs text-txt-secondary">
                      Arbeitsbeitrag · {periodLabel}
                    </p>
                    <p className="mt-2 text-2xl font-semibold text-accent">
                      {selectedRow.status === "rated" ? (
                        <>
                          {number(selectedRow.points!)}{" "}
                          <span className="text-sm">Punkte</span>
                        </>
                      ) : (
                        <span className="text-sm">
                          {CONTRIBUTION_STATUS[selectedRow.status]}
                        </span>
                      )}
                    </p>
                    {selectedRow.share !== null && (
                      <p className="mt-1 text-xs text-txt-muted">
                        {formatShare(selectedRow.share)} % des erfassten
                        Teambeitrags
                      </p>
                    )}
                  </div>
                  {Boolean(selectedRow.productCareOverlap) && (
                    <p className="mb-4 text-xs leading-relaxed text-txt-muted">
                      {selectedRow.productCareOverlap} Produkte wurden von
                      diesem Konto im Zeitraum erfasst und gepflegt. Sie zählen
                      nur unter Erfasst; die vollständigen Vorgangszahlen
                      bleiben unten sichtbar.
                    </p>
                  )}
                  <h4 className="text-sm font-semibold">
                    So setzt sich der Beitrag zusammen
                  </h4>
                  <dl className="mt-2 divide-y divide-app-border">
                    {METRICS.map((item) => {
                      const source =
                        item.key === "erfasst" || item.key === "angereichert"
                          ? "audit"
                          : item.key === "eingelagert"
                            ? "warehouse"
                            : "orders";
                      const available =
                        result.data?.dataQuality?.sources?.[source] !==
                        "unavailable";
                      return (
                        <div
                          key={item.key}
                          className="flex items-baseline justify-between gap-3 py-3"
                        >
                          <dt className="text-sm text-txt-secondary">
                            {item.label}
                            <span className="mt-1 block text-[11px] text-txt-muted">
                              {CONTRIBUTION_WEIGHTS[item.key]}{" "}
                              {CONTRIBUTION_WEIGHTS[item.key] === 1
                                ? "Punkt"
                                : "Punkte"}{" "}
                              je{" "}
                              {item.unit === "Produkte"
                                ? "Produkt"
                                : item.unit === "Buchungen"
                                  ? "Buchung"
                                  : "Vorgang"}
                            </span>
                          </dt>
                          <dd className="text-right">
                            <span className="font-semibold tabular-nums">
                              {available
                                ? number(metricValue(selectedRow, item.key))
                                : "—"}
                            </span>
                            <span className="ml-1 text-[11px] text-txt-muted">
                              {item.unit}
                            </span>
                            {selectedRow.status === "rated" && (
                              <span className="mt-1 block text-xs text-accent">
                                {number(
                                  creditedCount(selectedRow, item.key) *
                                    CONTRIBUTION_WEIGHTS[item.key],
                                )}{" "}
                                Punkte
                              </span>
                            )}
                            {!available && (
                              <span className="mt-1 block text-[11px] text-warning">
                                Quelle nicht verfügbar
                              </span>
                            )}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                  {selectedRow.status === "no_activity" && (
                    <p className="mt-3 rounded-xl bg-app-elevated p-3 text-xs text-txt-secondary">
                      Keine zugeordneten Tätigkeiten im Zeitraum. Das ist keine
                      Aussage über Anwesenheit oder die Qualität der Arbeit.
                    </p>
                  )}
                  {selectedRow.status === "historical" && (
                    <p className="mt-3 text-xs text-txt-muted">
                      Historische oder deaktivierte Konten fließen nicht in die
                      persönliche Bewertung ein. Ihre dokumentierten Tätigkeiten
                      bleiben hier sichtbar.
                    </p>
                  )}
                </aside>
              ) : (
                <aside className="hidden rounded-2xl border border-dashed border-app-border bg-app-surface p-7 text-center xl:block">
                  <span className="text-3xl text-accent">↗</span>
                  <h3 className="mt-3 font-semibold">Mitarbeiter auswählen</h3>
                  <p className="mt-2 text-sm leading-relaxed text-txt-muted">
                    Hier siehst du die einzelnen Tätigkeiten und wie sich der
                    Gesamtbeitrag berechnet.
                  </p>
                </aside>
              )}
            </div>
            <details className="rounded-xl border border-app-border px-4 py-3 text-xs text-txt-muted">
              <summary className="cursor-pointer font-medium text-txt-secondary">
                Bewertungsmodell und Datengrundlage
              </summary>
              <div className="mt-4 max-w-4xl space-y-3 leading-relaxed">
                <p>
                  <strong className="text-txt-primary">
                    {CONTRIBUTION_MODEL_VERSION}:
                  </strong>{" "}
                  Erfassen × 5, Produktpflege × 2, Einlagern × 2,
                  Kommissionieren × 1, Verpacken × 3. Die Summe ergibt den
                  Arbeitsbeitrag in Punkten. Teamanteil = persönliche Punkte ÷
                  Punkte aller bewertbaren Konten.
                </p>
                <p>
                  Diese Gewichtung ist eine offengelegte Startannahme zum
                  unterschiedlichen Aufwand, keine gemessene Bearbeitungszeit.
                  Sie ist für alle Personen gleich. Mehr Punkte bedeuten mehr
                  dokumentierten, gewichteten Arbeitsumfang; Arbeitszeit,
                  Schwierigkeit des einzelnen Artikels und Qualität sind damit
                  nicht bewertet.
                </p>
                <p>
                  Erfasst und Produktpflege zählen eindeutige Produkte je Konto;
                  mehrere Speicherungen am selben Produkt erhöhen die Zahl
                  nicht. Erfasst und pflegt dasselbe Konto ein Produkt im
                  gewählten Zeitraum, wird es nur unter Erfasst bepunktet.
                  Einlagern zählt Buchungen, Kommissionieren und Verpacken
                  zählen Vorgänge. Die Balken vergleichen die Punkte mit dem
                  höchsten Beitrag im gewählten Zeitraum und stellen keine
                  Zielerfüllung dar.
                </p>
                <p>
                  Historische oder deaktivierte Konten werden separat ohne
                  Bewertung gezeigt. Ohne dokumentierte Tätigkeiten wird keine
                  negative Note vergeben. Nicht erfasste Arbeit bleibt
                  unsichtbar. Bei fehlenden oder abgeschnittenen Datenquellen
                  wird die Gesamtbewertung ausgesetzt.
                </p>
              </div>
            </details>
          </>
        )
      )}
    </div>
  );
};
