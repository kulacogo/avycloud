import React, { useMemo, useState } from 'react';
import { useIdentificationQueue } from '../../hooks/useIdentificationQueue';
import { useI18n } from '../../i18n';
import { IdentificationJob } from '../../types';
import { Spinner } from '../ui/Spinner';

const STATUS_META = {
  pending: { color: 'bg-[var(--warning)]/20 text-[var(--warning)] border border-[var(--warning)]/40' },
  processing: { color: 'bg-[var(--avy-purple)]/20 text-[var(--avy-purple)] border border-[var(--avy-purple)]/40' },
  failed: { color: 'bg-[var(--error)]/20 text-[var(--error)] border border-[var(--error)]/40' },
  done: { color: 'bg-[var(--success)]/20 text-[var(--success)] border border-[var(--success)]/40' },
};

const formatRelative = (iso?: string | null) => {
  if (!iso) return '\u2014';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '\u2014';
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
  if (!iso) return '\u2014';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '\u2014';
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
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight">{t('identifyQueue.title')}</h1>
          <p className="text-[13px] text-[var(--text-tertiary)]">{t('identifyQueue.description')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={refresh}
            className="px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--text-primary)] hover:opacity-80 transition"
          >
            {t('actions.refresh')}
          </button>
          <button
            type="button"
            onClick={() => setAutoRefresh((value) => !value)}
            className={`px-4 py-2 rounded-xl border text-sm transition ${
              autoRefresh
                ? 'border-[var(--success)]/40 bg-[var(--success)]/20 text-[var(--success)]'
                : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)]'
            }`}
          >
            {autoRefresh ? t('identifyQueue.autoRefreshOn') : t('identifyQueue.autoRefreshOff')}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-xl border border-[var(--error)]/40 bg-[var(--error)]/10 text-[var(--error)] px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {statusOptions.map((option) => (
          <div
            key={option.key}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
          >
            <p className="text-xs uppercase tracking-widest text-[var(--text-tertiary)]">{option.label}</p>
            <p className="text-3xl font-semibold text-[var(--text-primary)] mt-1">
              {stats[option.key] ?? 0}
            </p>
          </div>
        ))}
      </div>

      {/* Status filter pills */}
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
                isActive ? meta.color : 'bg-[var(--surface)] text-[var(--text-secondary)] border border-[var(--border)]'
              }`}
            >
              {option.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={resetStatuses}
          className="px-3 py-1.5 rounded-full text-xs border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--text-tertiary)] transition"
        >
          {t('identifyQueue.resetFilters')}
        </button>
        {lastUpdated && (
          <span className="text-xs text-[var(--text-tertiary)]">
            {t('identifyQueue.lastUpdated', { value: formatRelative(lastUpdated) })}
          </span>
        )}
      </div>

      {/* Jobs table */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-[var(--surface-elevated)] text-[var(--text-tertiary)] uppercase text-xs tracking-widest">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">{t('identifyQueue.columns.job')}</th>
                <th className="text-left px-4 py-3 font-semibold">{t('identifyQueue.columns.status')}</th>
                <th className="text-left px-4 py-3 font-semibold">{t('identifyQueue.columns.age')}</th>
                <th className="text-left px-4 py-3 font-semibold">{t('identifyQueue.columns.payload')}</th>
                <th className="text-left px-4 py-3 font-semibold">{t('identifyQueue.columns.result')}</th>
                <th className="text-right px-4 py-3 font-semibold">{t('identifyQueue.columns.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)] text-[var(--text-primary)]">
              {jobs.map((job) => {
                const payload = getPayloadSummary(job);
                const result = getResultSummary(job);
                const statusMeta = STATUS_META[job.status as keyof typeof STATUS_META] || STATUS_META.pending;
                const isRetrying = retryingJobId === job.id;
                const showRetry = job.status === 'failed' || job.status === 'processing';
                return (
                  <tr key={job.id} className="hover:bg-[var(--surface-elevated)]/50 transition-colors">
                    <td className="px-4 py-4 space-y-1">
                      <p className="font-mono text-xs text-[var(--text-secondary)]">{job.id}</p>
                      <p className="text-xs text-[var(--text-tertiary)]">{formatDateTime(job.createdAt)}</p>
                    </td>
                    <td className="px-4 py-4">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${statusMeta.color}`}>
                        {statusLabels[job.status as keyof typeof statusLabels] || job.status}
                      </span>
                      <p className="text-xs text-[var(--text-tertiary)] mt-1">
                        {t('identifyQueue.attempts', { count: job.attempts || 0 })}
                      </p>
                    </td>
                    <td className="px-4 py-4">
                      <p className="text-sm text-[var(--text-primary)]">{formatRelative(job.createdAt)}</p>
                      {job.startedAt && (
                        <p className="text-xs text-[var(--text-tertiary)]">{t('identifyQueue.processingSince', { value: formatRelative(job.startedAt) })}</p>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      {payload.barcodes ? (
                        <p className="text-xs text-[var(--text-primary)] break-words">{payload.barcodes}</p>
                      ) : (
                        <p className="text-xs text-[var(--text-tertiary)]">\u2014</p>
                      )}
                      <p className="text-xs text-[var(--text-tertiary)] mt-1">
                        {t('identifyQueue.files', { count: payload.fileCount || 0 })}
                      </p>
                    </td>
                    <td className="px-4 py-4">
                      {job.status === 'failed' && job.error?.message && (
                        <p className="text-xs text-[var(--error)]">{job.error.message}</p>
                      )}
                      {result ? (
                        <>
                          <p className="text-sm text-[var(--text-primary)]">{result.label}</p>
                          {result.details && <p className="text-xs text-[var(--text-tertiary)]">{result.details}</p>}
                        </>
                      ) : (
                        job.status !== 'failed' && <p className="text-xs text-[var(--text-tertiary)]">\u2014</p>
                      )}
                    </td>
                    <td className="px-4 py-4 text-right">
                      {showRetry ? (
                        <button
                          type="button"
                          onClick={() => handleRetry(job.id)}
                          disabled={isRetrying}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--surface-elevated)] disabled:opacity-50 disabled:cursor-not-allowed transition"
                        >
                          {isRetrying ? t('identifyQueue.retrying') : t('identifyQueue.actions.retry')}
                        </button>
                      ) : (
                        <span className="text-xs text-[var(--text-tertiary)]">\u2014</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {jobs.length === 0 && !isLoading && (
          <p className="text-center text-[var(--text-tertiary)] text-sm py-8">{t('identifyQueue.empty')}</p>
        )}
        {isLoading && (
          <div className="flex items-center justify-center py-6">
            <Spinner />
          </div>
        )}
      </div>

      {/* Load more */}
      {hasMore && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            className="px-6 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm hover:bg-[var(--surface-elevated)] transition"
          >
            {t('identifyQueue.actions.loadMore')}
          </button>
        </div>
      )}
    </section>
  );
};

export default IdentifyQueueView;
