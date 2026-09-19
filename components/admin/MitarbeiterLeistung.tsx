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
  sortPerformance,
  userId,
  profileId,
  type MetricKey,
} from "./teamWorkspaceModel";
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
  const [metric, setMetric] = React.useState<MetricKey>("verpackt");
  const [query, setQuery] = React.useState("");
  const [view, setView] = React.useState<"bars" | "table">("bars");
  const [onlyActive, setOnlyActive] = React.useState(false);
  const [localUid, setLocalUid] = React.useState<string | null>(null);
  const [sort, setSort] = React.useState<{
    key: MetricKey | "name";
    descending: boolean;
  }>({ key: "verpackt", descending: true });
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
  const needle = normalizeSearch(query.trim());
  const filtered = rows.filter(
    (row) =>
      (!onlyActive || hasActivity(row)) &&
      normalizeSearch(`${row.name} ${row.email || ""}`).includes(needle),
  );
  const currentMetric = METRICS.find((item) => item.key === metric)!;
  const ordered = sortPerformance(
    filtered,
    view === "bars" ? metric : sort.key,
    view === "bars" ? true : sort.descending,
  );
  const selectedRow = rows.find((row) => row.uid === selected);
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
  const maximum = Math.max(1, ...rows.map((row) => metricValue(row, metric)));
  const roleFor = (uid: string) => {
    const account = directory.data?.find((item) => userId(item) === uid);
    return account ? profileId(account) : "viewer";
  };
  const changeMetric = (key: MetricKey) => {
    setMetric(key);
    setSort({ key, descending: true });
  };
  const changeSort = (key: MetricKey | "name") =>
    setSort((previous) => ({
      key,
      descending: previous.key === key ? !previous.descending : key !== "name",
    }));
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
            Was dein Team bewegt
          </h2>
          <p className="mt-1 text-sm text-txt-secondary">
            Tätigkeit wählen, Zeitraum eingrenzen und einzelne Konten ansehen.
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
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              {METRICS.map((item) => (
                <button
                  type="button"
                  key={item.key}
                  aria-pressed={metric === item.key}
                  onClick={() => changeMetric(item.key)}
                  className={`relative overflow-hidden rounded-2xl border p-4 text-left transition hover:border-accent ${metric === item.key ? "border-accent bg-accent-dim" : "border-app-border bg-app-surface"}`}
                >
                  <span className="text-xs font-medium text-txt-secondary">
                    {item.label}
                  </span>
                  <span className="mt-3 block text-3xl font-semibold tracking-tight tabular-nums">
                    {number(
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
                    className="absolute bottom-0 left-0 h-1 w-full"
                    style={{
                      background: item.color,
                      opacity: metric === item.key ? 1 : 0.25,
                    }}
                  />
                </button>
              ))}
            </div>
            <div
              className={`grid items-start gap-4 ${selectedRow ? "xl:grid-cols-[minmax(0,1fr)_300px]" : ""}`}
            >
              <section className="min-w-0 overflow-hidden rounded-2xl border border-app-border bg-app-surface">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-app-border p-5">
                  <div>
                    <h3 className="font-semibold">
                      {view === "bars"
                        ? currentMetric.label
                        : "Alle Tätigkeiten"}{" "}
                      im Team
                    </h3>
                    <p className="mt-1 text-xs text-txt-muted">
                      {view === "bars"
                        ? currentMetric.detail
                        : "Spalten anklicken, um die Reihenfolge zu ändern."}
                    </p>
                  </div>
                  <div className="flex rounded-lg bg-app-bg p-1">
                    {(
                      [
                        ["bars", "Balken"],
                        ["table", "Tabelle"],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        type="button"
                        key={id}
                        aria-pressed={view === id}
                        onClick={() => setView(id)}
                        className={`rounded-md px-3 py-1.5 text-xs font-medium ${view === id ? "bg-app-elevated text-txt-primary" : "text-txt-muted"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3 px-5 pt-4">
                  <label className="relative min-w-[160px] flex-1">
                    <SearchIcon className="absolute left-3 top-3 h-4 w-4 text-txt-muted" />
                    <input
                      aria-label="Leistung nach Name oder E-Mail filtern"
                      placeholder="Konto suchen …"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      className={`${fieldClass} pl-10`}
                    />
                  </label>
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
                    <TeamEmpty title="Keine passenden Tätigkeiten">
                      {query || onlyActive
                        ? "Passe die Suche oder den Tätigkeitsfilter an."
                        : "In diesem Zeitraum liegen keine zugeordneten Tätigkeiten vor."}
                    </TeamEmpty>
                  </div>
                ) : view === "bars" ? (
                  <div className="space-y-1 p-3">
                    {ordered.map((row) => (
                      <button
                        type="button"
                        key={row.uid}
                        aria-pressed={selected === row.uid}
                        aria-label={`Details ansehen: ${row.name}`}
                        onClick={() =>
                          select(selected === row.uid ? null : row.uid)
                        }
                        className={`flex w-full items-center gap-3 rounded-xl p-3 text-left transition hover:bg-app-elevated ${selected === row.uid ? "bg-accent-dim ring-1 ring-inset ring-accent" : ""}`}
                      >
                        <TeamAvatar
                          name={row.name}
                          role={roleFor(row.uid)}
                          small
                        />
                        <span className="min-w-0 flex-1">
                          <span className="mb-2 flex items-baseline justify-between gap-3">
                            <span className="truncate text-sm font-medium">
                              {row.name}
                            </span>
                            <span className="shrink-0 text-sm font-semibold tabular-nums">
                              {number(metricValue(row, metric))}
                              <span className="ml-1 hidden text-xs font-normal text-txt-muted sm:inline">
                                {currentMetric.unit}
                              </span>
                            </span>
                          </span>
                          <span className="block h-2 overflow-hidden rounded-full bg-app-elevated">
                            <span
                              className="block h-full rounded-full motion-safe:transition-[width] motion-safe:duration-300"
                              style={{
                                width: `${(metricValue(row, metric) / maximum) * 100}%`,
                                background: currentMetric.color,
                              }}
                            />
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="overflow-x-auto p-5">
                    <table className="w-full text-sm">
                      <caption className="sr-only">
                        Tätigkeiten je Konto, {periodLabel}
                      </caption>
                      <thead>
                        <tr>
                          {(
                            [
                              { key: "name", label: "Mitarbeiter" },
                              ...METRICS,
                            ] as const
                          ).map((item) => (
                            <th
                              key={item.key}
                              scope="col"
                              aria-sort={
                                sort.key === item.key
                                  ? sort.descending
                                    ? "descending"
                                    : "ascending"
                                  : "none"
                              }
                              className={`pb-3 ${item.key === "name" ? "text-left" : "text-right"}`}
                            >
                              <button
                                type="button"
                                onClick={() => changeSort(item.key)}
                                className="whitespace-nowrap px-2 text-xs font-medium text-txt-muted hover:text-accent"
                              >
                                {item.label}
                                {sort.key === item.key
                                  ? sort.descending
                                    ? " ↓"
                                    : " ↑"
                                  : " ↕"}
                              </button>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {ordered.map((row) => (
                          <tr
                            key={row.uid}
                            className={`border-t border-app-border ${selected === row.uid ? "bg-accent-dim" : ""}`}
                          >
                            <th
                              scope="row"
                              className="py-3 text-left font-medium"
                            >
                              <button
                                type="button"
                                className="px-2 text-accent hover:underline"
                                onClick={() =>
                                  select(selected === row.uid ? null : row.uid)
                                }
                              >
                                {row.name}
                              </button>
                            </th>
                            {METRICS.map((item) => (
                              <td
                                key={item.key}
                                className={`px-2 py-3 text-right tabular-nums ${metricValue(row, item.key) ? "text-txt-primary" : "text-txt-muted"}`}
                              >
                                {number(metricValue(row, item.key))}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="border-t border-app-border px-5 py-3 text-xs text-txt-muted">
                  {filtered.length} von {rows.length} Konten · Konto auswählen
                  für Details
                </p>
              </section>
              {selectedRow && (
                <aside
                  ref={detailRef}
                  tabIndex={-1}
                  aria-label={`Leistungsdetails ${selectedRow.name}`}
                  className="order-first rounded-2xl border border-accent bg-app-surface p-5 outline-none xl:sticky xl:top-4 xl:order-last"
                >
                  <div className="flex items-start justify-between gap-3">
                    <TeamAvatar
                      name={selectedRow.name}
                      role={roleFor(selectedRow.uid)}
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
                  <h3 className="mt-4 font-semibold">{selectedRow.name}</h3>
                  <p className="mt-1 break-all text-xs text-txt-muted">
                    {selectedRow.email}
                  </p>
                  <p className="mt-4 border-t border-app-border pt-4 text-xs text-txt-secondary">
                    {periodLabel}
                  </p>
                  <dl className="mt-2 divide-y divide-app-border">
                    {METRICS.map((item) => (
                      <div
                        key={item.key}
                        className="flex items-baseline justify-between gap-3 py-3"
                      >
                        <dt className="text-sm text-txt-secondary">
                          {item.label}
                        </dt>
                        <dd className="text-right font-semibold tabular-nums">
                          {number(metricValue(selectedRow, item.key))}
                          <span className="mt-0.5 block text-[11px] font-normal text-txt-muted">
                            {item.unit}
                          </span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {!hasActivity(selectedRow) && (
                    <p className="mt-3 rounded-xl bg-app-elevated p-3 text-xs text-txt-secondary">
                      Für dieses Konto sind im gewählten Zeitraum keine
                      Tätigkeiten erfasst.
                    </p>
                  )}
                </aside>
              )}
              {selected && !selectedRow && (
                <p role="status" className="text-sm text-txt-muted">
                  Für das ausgewählte Konto liegen in diesem Zeitraum keine
                  zugeordneten Daten vor.
                </p>
              )}
            </div>
            <details className="rounded-xl border border-app-border px-4 py-3 text-xs text-txt-muted">
              <summary className="cursor-pointer font-medium text-txt-secondary">
                Wie werden die Zahlen gezählt?
              </summary>
              <div className="mt-3 max-w-3xl space-y-2 leading-relaxed">
                <p>
                  Erfasst und Produktpflege zählen eindeutige Produkte je Konto.
                  Eingelagert zählt Buchungen; Kommissioniert und Verpackt
                  zählen Vorgänge. Diese Einheiten werden nicht zu einer
                  Gesamtpunktzahl zusammengezählt.
                </p>
                <p>
                  Die Zahlen zeigen dokumentierte Tätigkeiten, keine Arbeitszeit
                  oder Arbeitsqualität. Ältere Vorgänge ohne Kontozuordnung
                  fehlen; automatische Systemvorgänge sind ausgeblendet.
                  Historische Buchungen gemeinsamer Konten bleiben bei diesen
                  Konten.
                </p>
                <p>
                  Die Auswertung basiert auf begrenzt abrufbaren Protokollen.
                  Ein Wert von 0 bedeutet, dass im ausgewerteten Datenbestand
                  keine passende Tätigkeit gefunden wurde; er beweist keine
                  Untätigkeit.
                </p>
              </div>
            </details>
          </>
        )
      )}
    </div>
  );
};
