import React, { useMemo, useState } from 'react';
import { useIdentificationQueue } from '../hooks/useIdentificationQueue';
import { useI18n } from '../i18n';
import { IdentificationJob } from '../types';
import { Spinner } from './Spinner';
import { IdentifyHealthTile } from './IdentifyHealthTile';

const STATUS_META = {
  pending: { color: 'bg-warning-dim text-warning border border-warning/30' },
  processing: { color: 'bg-accent-dim text-accent border border-accent/30' },
  failed: { color: 'bg-danger-dim text-danger border border-danger/30' },
  done: { color: 'bg-success-dim text-success border border-success/30' },
};

const formatRelative = (iso?: string | null) => {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.max(0, Math.round(diffMs / 60000));
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes - hours * 60;
    return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
};

const formatDateTime = (iso?: string | null) => {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const getPayloadSummary = (job: IdentificationJob) => {
  const payload = job.payload || undefined;
  const barcodes = payload?.barcodes?.trim();
  const files = payload?.files ?? [];
  return {
    barcodes,
    fileCount: payload?.fileCount ?? files.length,
    files,
  };
};

const getResultSummary = (job: IdentificationJob) => {
  if (job.status !== 'done' || !job.result) {
    return null;
  }
  const result = job.result;
  if (!result.products?.length) {
    return { label: `${result.productCount ?? 0} Produkte` };
  }
  const names = result.products.map((product) => product.name || product.sku || product.id).filter(Boolean);
  return { label: `${result.productCount ?? names.length} Produkte`, details: names.slice(0, 3).join(', ') };
};

const IdentifyQueueView: React.FC = () => {
  const { t } = useI18n();
  const {
    jobs,
    isLoading,
    error,
    statuses,
    toggleStatus,
    resetStatuses,
    refresh,
    loadMore,
    hasMore,
    autoRefresh,
    setAutoRefresh,
    lastUpdated,
    retryJob,
    stats,
  } = useIdentificationQueue();
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);

  const activeStatusSet = useMemo(() => new Set(statuses), [statuses]);

  const handleRetry = async (jobId: string) => {
    setRetryingJobId(jobId);
    try {
      await retryJob(jobId);
    } finally {
      setRetryingJobId(null);
    }
  };

  const statusOptions: Array<{ key: keyof typeof STATUS_META; label: string }> = [
    { key: 'pending', label: t('identifyQueue.status.pending') },
    { key: 'processing', label: t('identifyQueue.status.processing') },
    { key: 'failed', label: t('identifyQueue.status.failed') },
    { key: 'done', label: t('identifyQueue.status.done') },
  ];
  const statusLabels = {
    pending: statusOptions[0].label,
    processing: statusOptions[1].label,
    failed: statusOptions[2].label,
    done: statusOptions[3].label,
  };

  return (
    <section className="space-y-5">
      <IdentifyHealthTile />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-txt-primary">{t('identifyQueue.title')}</h1>
          <p className="text-sm text-txt-muted">{t('identifyQueue.description')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={refresh}
            className="px-4 py-2 rounded-xl border border-app-border bg-white/5 text-sm text-txt-primary hover:bg-white/10 transition"
          >
            {t('actions.refresh')}
          </button>
          <button
            type="button"
            onClick={() => setAutoRefresh((value) => !value)}
            className={`px-4 py-2 rounded-xl border text-sm transition ${
              autoRefresh
                ? 'border-success/30 bg-success-dim text-success'
                : 'border-app-border bg-app-surface text-txt-secondary'
            }`}
          >
            {autoRefresh ? t('identifyQueue.autoRefreshOn') : t('identifyQueue.autoRefreshOff')}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-danger/30 bg-danger-dim text-danger px-4 py-3 text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {statusOptions.map((option) => (
          <div
            key={option.key}
            className="rounded-2xl border border-app-border bg-app-surface p-4"
          >
            <p className="text-[11px] uppercase tracking-widest text-txt-muted font-semibold">{option.label}</p>
            <p className="text-2xl font-bold text-txt-primary mt-1">
              {stats[option.key] ?? 0}
            </p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {statusOptions.map((option) => {
          const meta = STATUS_META[option.key];
          const isActive = activeStatusSet.has(option.key);
          return (
            <button
              key={option.key}
              type="button"
              onClick={() => toggleStatus(option.key)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${
                isActive ? meta.color : 'bg-app-surface text-txt-secondary border border-app-border'
              }`}
            >
              {option.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={resetStatuses}
          className="px-3 py-1.5 rounded-full text-xs border border-app-border text-txt-secondary hover:text-txt-primary hover:border-app-border transition"
        >
          {t('identifyQueue.resetFilters')}
        </button>
        {lastUpdated && (
          <span className="text-xs text-txt-muted">
            {t('identifyQueue.lastUpdated', { value: formatRelative(lastUpdated) })}
          </span>
        )}
      </div>

      <div className="bg-app-bg/60 border border-app-border rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-app-bg/80 text-txt-muted uppercase text-xs tracking-widest">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">{t('identifyQueue.columns.job')}</th>
                <th className="text-left px-4 py-3 font-semibold">{t('identifyQueue.columns.status')}</th>
                <th className="text-left px-4 py-3 font-semibold">{t('identifyQueue.columns.age')}</th>
                <th className="text-left px-4 py-3 font-semibold">{t('identifyQueue.columns.payload')}</th>
                <th className="text-left px-4 py-3 font-semibold">{t('identifyQueue.columns.result')}</th>
                <th className="text-right px-4 py-3 font-semibold">{t('identifyQueue.columns.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border text-txt-primary">
              {jobs.map((job) => {
                const payload = getPayloadSummary(job);
                const result = getResultSummary(job);
                const statusMeta = STATUS_META[job.status as keyof typeof STATUS_META] || STATUS_META.pending;
                const isRetrying = retryingJobId === job.id;
                const showRetry = job.status === 'failed' || job.status === 'processing';
                return (
                  <tr key={job.id} className="hover:bg-white/5 transition-colors">
                    <td className="px-4 py-4 space-y-1">
                      <p className="font-mono text-xs text-txt-secondary">{job.id}</p>
                      <p className="text-xs text-txt-muted">{formatDateTime(job.createdAt)}</p>
                    </td>
                    <td className="px-4 py-4">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${statusMeta.color}`}>
                        {statusLabels[job.status as keyof typeof statusLabels] || job.status}
                      </span>
                      <p className="text-xs text-txt-muted mt-1">
                        {t('identifyQueue.attempts', { count: job.attempts || 0 })}
                      </p>
                    </td>
                    <td className="px-4 py-4">
                      <p className="text-sm text-txt-primary">{formatRelative(job.createdAt)}</p>
                      {job.startedAt && (
                        <p className="text-xs text-txt-muted">{t('identifyQueue.processingSince', { value: formatRelative(job.startedAt) })}</p>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      {payload.barcodes ? (
                        <p className="text-xs text-txt-secondary break-words">{payload.barcodes}</p>
                      ) : (
                        <p className="text-xs text-txt-muted">—</p>
                      )}
                      <p className="text-xs text-txt-muted mt-1">
                        {t('identifyQueue.files', { count: payload.fileCount || 0 })}
                      </p>
                    </td>
                    <td className="px-4 py-4">
                      {job.status === 'failed' && job.error?.message && (
                        <p className="text-xs text-danger">{job.error.message}</p>
                      )}
                      {result ? (
                        <>
                          <p className="text-sm text-txt-primary">{result.label}</p>
                          {result.details && <p className="text-xs text-txt-muted">{result.details}</p>}
                        </>
                      ) : (
                        job.status !== 'failed' && <p className="text-xs text-txt-muted">—</p>
                      )}
                    </td>
                    <td className="px-4 py-4 text-right">
                      {showRetry ? (
                        <button
                          type="button"
                          onClick={() => handleRetry(job.id)}
                          disabled={isRetrying}
                          className="px-3 py-1.5 rounded-xl text-xs font-medium border border-app-border text-txt-primary hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed transition"
                        >
                          {isRetrying ? t('identifyQueue.retrying') : t('identifyQueue.actions.retry')}
                        </button>
                      ) : (
                        <span className="text-xs text-txt-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {jobs.length === 0 && !isLoading && (
          <p className="text-center text-txt-muted text-sm py-8">{t('identifyQueue.empty')}</p>
        )}
        {isLoading && (
          <div className="flex items-center justify-center py-6">
            <Spinner />
          </div>
        )}
      </div>

      {hasMore && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            className="px-6 py-2 rounded-xl border border-app-border bg-white/5 text-txt-primary text-sm hover:bg-white/10 transition"
          >
            {t('identifyQueue.actions.loadMore')}
          </button>
        </div>
      )}
    </section>
  );
};

export default IdentifyQueueView;

