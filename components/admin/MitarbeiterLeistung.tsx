import React from "react";
import { useQuery } from "@tanstack/react-query";
import { adminGetPerformance, adminGetSupportPerformance } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { RefreshIcon, SearchIcon } from "../icons/Icons";
import { useTeamDirectory } from "./useTeamDirectory";
import {
  METRICS,
  normalizeSearch,
  hasActivity,
  performanceRows,
  userId,
} from "./teamWorkspaceModel";
import {
  buildContributions,
  creditedCount,
  CONTRIBUTION_WEIGHTS,
  SUPPORT_WEIGHT,
  CONTRIBUTION_STATUS,
  attachSupport,
} from "./workContribution";
import { roleDisplayName } from "./roleCatalog";
import { SupportPerformancePanel } from "./SupportPerformancePanel";
import { activityDetails } from "./performancePresentation";
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
  const support = useQuery({
    queryKey: ["team-support-performance", user?.uid, range, custom?.from, custom?.to],
    queryFn: () => adminGetSupportPerformance(range, custom),
    enabled: active && Boolean(user?.uid),
    staleTime: 60000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const supportData = support.error ? undefined : support.data;
  const supportOwner = directory.data?.find((account) => userId(account) === supportData?.ownerUid);
  const supportComplete = supportData?.complete === true && Boolean(supportOwner);
  const rows = React.useMemo(
    () => attachSupport(performanceRows(result.data?.rows || [], directory.data || []), supportData),
    [result.data, directory.data, supportData],
  );
  const complete =
    result.data?.dataQuality?.complete === true &&
    result.data?.contributionDataVersion === 3 &&
    !result.error &&
    !directory.error &&
    !directory.isPending;
  const contributions = React.useMemo(
    () => buildContributions(rows, directory.data || [], complete, supportComplete),
    [rows, directory.data, complete, supportComplete],
  );
  const needle = normalizeSearch(query.trim());
  const filtered = contributions.filter(
    (row) =>
      (!onlyActive || hasActivity(row) || row.supportPartial) &&
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            Teamleistung
          </h2>
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
            disabled={result.isFetching || support.isFetching}
            className={secondaryButton}
            onClick={() => { result.refetch(); support.refetch(); }}
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
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="font-medium text-txt-secondary">{periodLabel}</span>
          <SupportPerformancePanel data={supportData} loading={support.isFetching} error={Boolean(support.error)} onReload={() => { support.refetch(); }} />
        </div>
        <span aria-live="polite">
          {result.isFetching
            ? "Aktualisiert …"
            : result.error
              ? "Aktualisierung fehlgeschlagen"
              : result.dataUpdatedAt
                ? `Stand ${new Date(result.dataUpdatedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`
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
          message="Mitarbeiterdaten nicht verfügbar."
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
                className="rounded-lg bg-warning-dim px-3 py-2 text-xs text-warning"
              >
                Daten unvollständig · Bewertung pausiert.
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
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" aria-label="Teamaktivität">
                {METRICS.map((item) => (
                  <div
                    key={item.key}
                    className="relative overflow-hidden rounded-xl border border-app-border bg-app-surface px-4 py-3"
                  >
                    <span className="block text-xs font-medium text-txt-secondary">
                      {item.label}
                    </span>
                    <span className="mt-1.5 inline-block text-2xl font-semibold tracking-tight tabular-nums">
                      {result.data?.dataQuality?.sources?.[
                        item.key === "erfasst" || item.key === "angereichert"
                          ? "audit"
                          : item.key === "eingelagert"
                            ? "warehouse"
                            : "orders"
                      ] === "unavailable" ||
                      (item.key === "angereichert" &&
                        result.data?.contributionDataVersion !== 3)
                        ? "—"
                        : number(
                            rows.reduce(
                              (sum, row) => sum + creditedCount(row, item.key),
                              0,
                            ),
                          )}
                    </span>
                    <span className="ml-2 text-[11px] text-txt-muted">
                      {item.unit}
                    </span>
                    <span
                      className="absolute bottom-0 left-0 h-0.5 w-full opacity-40"
                      style={{ background: item.color }}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className={`grid items-start gap-4 ${selectedRow ? "xl:grid-cols-[minmax(0,1fr)_350px]" : ""}`}>
              <section className="min-w-0 overflow-hidden rounded-2xl border border-app-border bg-app-surface">
                <div className="flex items-center justify-between border-b border-app-border px-4 py-3">
                  <h3 className="text-sm font-semibold">Team</h3>
                  <span className="text-xs text-txt-muted">{filtered.length} / {rows.length} Konten</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
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
                    <option value="contribution" disabled={!supportComplete}>{supportComplete ? "Nach Arbeitsbeitrag" : "Nach Name"}</option>
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
                  <div className="space-y-0.5 p-2">
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
                                    {row.supportPartial ? "≥ " : ""}{number(row.points!)}{" "}
                                    <span className="text-xs font-medium">
                                      Punkte
                                    </span>
                                  </span>
                                  {row.share !== null ? <span className="mt-0.5 block text-[11px] text-txt-muted">{formatShare(row.share)} % Teamanteil</span> : row.supportPartial && <span className="mt-0.5 block text-[11px] text-warning">Support unvollständig</span>}
                                </>
                              ) : (
                                <span className="text-xs">
                                  {CONTRIBUTION_STATUS[row.status]}
                                </span>
                              )}
                            </span>
                          </span>
                          {row.status === "rated" && supportComplete && (
                            <span className="mt-2 block h-1 overflow-hidden rounded-full bg-app-elevated">
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
                {!supportComplete && <p className="border-t border-app-border px-4 py-2 text-xs text-warning">Support unvollständig · Teamvergleich pausiert</p>}
              </section>
              {selectedRow ? (
                <aside
                  ref={detailRef}
                  tabIndex={-1}
                  aria-label={`Leistungsdetails ${selectedRow.name}`}
                  className="order-first min-w-0 rounded-2xl border border-accent bg-app-surface p-4 outline-none xl:sticky xl:top-4 xl:order-last"
                >
                  <div className="flex items-center gap-3">
                    <TeamAvatar name={selectedRow.name} role={selectedRow.role} small />
                    <h3 className="min-w-0 flex-1 break-words text-sm font-semibold">{selectedRow.name}</h3>
                    <button type="button" aria-label="Leistungsdetails schließen" onClick={() => select(null)} className="rounded-lg px-2 py-1 text-txt-muted hover:bg-app-elevated">×</button>
                  </div>
                  <div className="my-4 flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-accent-dim px-3 py-2.5">
                    <p className="text-2xl font-semibold text-accent">
                      {selectedRow.status === "rated" ? <>{selectedRow.supportPartial ? "≥ " : ""}{number(selectedRow.points!)} <span className="text-xs font-medium">Punkte</span></> : <span className="text-sm">{CONTRIBUTION_STATUS[selectedRow.status]}</span>}
                    </p>
                    {selectedRow.share !== null && <span className="text-xs text-txt-secondary">{formatShare(selectedRow.share)} % Teamanteil</span>}
                  </div>
                  <table className="w-full text-sm">
                    <thead><tr className="text-[11px] text-txt-muted"><th className="pb-2 text-left font-medium">Tätigkeit</th><th className="pb-2 text-right font-medium">Anzahl</th><th className="pb-2 pl-3 text-right font-medium">Punkte</th></tr></thead>
                    <tbody className="divide-y divide-app-border">
                      {activityDetails(selectedRow, result.data?.dataQuality, result.data?.contributionDataVersion, selectedRow.status === "rated").map((item) => <tr key={item.key}>
                        <th scope="row" className="py-2.5 pr-2 text-left font-normal text-txt-secondary">{item.label}</th>
                        <td className="py-2.5 text-right tabular-nums" aria-label={item.count === null ? "Nicht verfügbar" : `${number(item.count)} ${item.unit}`}>{item.count === null ? "—" : number(item.count)}</td>
                        <td className="py-2.5 pl-3 text-right font-medium tabular-nums text-accent">{item.points === null ? "—" : number(item.points)}</td>
                      </tr>)}
                    </tbody>
                  </table>
                  {selectedRow.uid === supportData?.ownerUid && <SupportPerformancePanel data={supportData} details loading={support.isFetching} error={Boolean(support.error)} onReload={() => { support.refetch(); }} />}
                  {result.data?.contributionDataVersion === 3 && selectedRow.productCareEdited !== undefined && <details className="mt-3 border-t border-app-border pt-3 text-xs text-txt-muted">
                    <summary className="cursor-pointer text-txt-secondary">Datenaufbereitung · Details</summary>
                    <dl className="mt-3 space-y-2">
                      <div className="flex justify-between gap-3"><dt>Inhaltlich geändert</dt><dd className="font-medium tabular-nums">{number(selectedRow.productContentEdited || 0)}</dd></div>
                      <div className="flex justify-between gap-3"><dt>Auf Bereit gesetzt*</dt><dd className="font-medium tabular-nums">{number(selectedRow.productReady || 0)}</dd></div>
                      <div className="flex justify-between gap-3"><dt>Gespeichert gesamt</dt><dd className="font-medium tabular-nums">{number(selectedRow.angereichert)}</dd></div>
                    </dl>
                    <p className="mt-3 leading-relaxed">* Freigaben seit 20.09.2026 erfasst. Frühere Freigaben sind unvollständig belegt. Änderungen und Freigaben zählen zusammen einmal je Produkt; eine Änderung allein ist keine vollständige Prüfung.</p>
                  </details>}
                </aside>
              ) : null}
            </div>
            <details className="px-1 text-xs text-txt-muted">
              <summary className="w-fit cursor-pointer font-medium text-txt-secondary">Berechnung</summary>
              <div className="mt-3 max-w-2xl rounded-xl border border-app-border bg-app-surface p-4 leading-relaxed">
                <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1.5">
                  {METRICS.map((item) => <React.Fragment key={item.key}><dt>{item.label}</dt><dd>× {CONTRIBUTION_WEIGHTS[item.key]}</dd></React.Fragment>)}
                  <dt>Support je Anliegen</dt><dd>× {SUPPORT_WEIGHT}</dd>
                </dl>
                <p className="mt-3">Punkte = Anzahl × Aufwandsstufe. Teamanteil = eigene Punkte ÷ alle bewertbaren Punkte, unabhängig vom Suchfilter. Aufwandsstufen sind keine gemessenen Arbeitszeiten oder Qualitätsnoten.</p>
                <p className="mt-2">Datenaufbereitung zählt belegte Inhaltsänderungen oder Freigaben einmal je Produkt und Konto. Erfassungsdefaults, Fotos, Barcodes, Preise und Gewicht allein zählen nicht dazu. Support zählt je beantwortetem Anliegen, unabhängig von der Zahl der Antworten.</p>
                <p className="mt-2">Fehlende Quellen: „—“. Unvollständiger Support: „≥“, ohne Teamvergleich. Historische und deaktivierte Konten bleiben ohne Bewertung.</p>
              </div>
            </details>
          </>
        )
      )}
    </div>
  );
};
