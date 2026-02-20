import React, { useMemo, useState } from 'react';
import { useIdentificationQueue } from '../hooks/useIdentificationQueue';
import { useI18n } from '../i18n';
import { IdentificationJob } from '../types';
import { Spinner } from './Spinner';

const STATUS_META = {
  pending: { color: 'bg-amber-500/20 text-amber-100 border border-amber-400/40' },
  processing: { color: 'bg-sky-500/20 text-sky-100 border border-sky-400/40' },
  failed: { color: 'bg-rose-500/20 text-rose-100 border border-rose-400/40' },
  done: { color: 'bg-emerald-500/20 text-emerald-100 border border-emerald-400/40' },
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
    <section className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-white">{t('identifyQueue.title')}</h1>
          <p className="text-slate-400">{t('identifyQueue.description')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={refresh}
            className="px-4 py-2 rounded-xl border border-white/10 bg-white/5 text-sm text-white hover:bg-white/10 transition"
          >
            {t('actions.refresh')}
          </button>
          <button
            type="button"
            onClick={() => setAutoRefresh((value) => !value)}
            className={`px-4 py-2 rounded-xl border text-sm transition ${
              autoRefresh
                ? 'border-emerald-400/40 bg-emerald-500/20 text-emerald-100'
                : 'border-slate-600 bg-slate-800 text-slate-200'
            }`}
          >
            {autoRefresh ? t('identifyQueue.autoRefreshOn') : t('identifyQueue.autoRefreshOff')}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-rose-500/40 bg-rose-500/15 text-rose-50 px-4 py-3 text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {statusOptions.map((option) => (
          <div
            key={option.key}
            className="rounded-2xl border border-white/5 bg-slate-900/60 p-4 shadow-inner shadow-black/30"
          >
            <p className="text-xs uppercase tracking-widest text-slate-400">{option.label}</p>
            <p className="text-3xl font-semibold text-white mt-1">
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
                isActive ? meta.color : 'bg-slate-800 text-slate-300 border border-white/10'
              }`}
            >
              {option.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={resetStatuses}
          className="px-3 py-1.5 rounded-full text-xs border border-white/10 text-slate-300 hover:text-white hover:border-white/30 transition"
        >
          {t('identifyQueue.resetFilters')}
        </button>
        {lastUpdated && (
          <span className="text-xs text-slate-500">
            {t('identifyQueue.lastUpdated', { value: formatRelative(lastUpdated) })}
          </span>
        )}
      </div>

      <div className="bg-slate-900/60 border border-white/5 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900/80 text-slate-400 uppercase text-xs tracking-widest">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">{t('identifyQueue.columns.job')}</th>
                <th className="text-left px-4 py-3 font-semibold">{t('identifyQueue.columns.status')}</th>
                <th className="text-left px-4 py-3 font-semibold">{t('identifyQueue.columns.age')}</th>
                <th className="text-left px-4 py-3 font-semibold">{t('identifyQueue.columns.payload')}</th>
                <th className="text-left px-4 py-3 font-semibold">{t('identifyQueue.columns.result')}</th>
                <th className="text-right px-4 py-3 font-semibold">{t('identifyQueue.columns.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-slate-100">
              {jobs.map((job) => {
                const payload = getPayloadSummary(job);
                const result = getResultSummary(job);
                const statusMeta = STATUS_META[job.status as keyof typeof STATUS_META] || STATUS_META.pending;
                const isRetrying = retryingJobId === job.id;
                const showRetry = job.status === 'failed' || job.status === 'processing';
                return (
                  <tr key={job.id} className="hover:bg-white/5 transition-colors">
                    <td className="px-4 py-4 space-y-1">
                      <p className="font-mono text-xs text-slate-300">{job.id}</p>
                      <p className="text-xs text-slate-500">{formatDateTime(job.createdAt)}</p>
                    </td>
                    <td className="px-4 py-4">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${statusMeta.color}`}>
                        {statusLabels[job.status as keyof typeof statusLabels] || job.status}
                      </span>
                      <p className="text-xs text-slate-500 mt-1">
                        {t('identifyQueue.attempts', { count: job.attempts || 0 })}
                      </p>
                    </td>
                    <td className="px-4 py-4">
                      <p className="text-sm text-white">{formatRelative(job.createdAt)}</p>
                      {job.startedAt && (
                        <p className="text-xs text-slate-500">{t('identifyQueue.processingSince', { value: formatRelative(job.startedAt) })}</p>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      {payload.barcodes ? (
                        <p className="text-xs text-slate-200 break-words">{payload.barcodes}</p>
                      ) : (
                        <p className="text-xs text-slate-500">—</p>
                      )}
                      <p className="text-xs text-slate-500 mt-1">
                        {t('identifyQueue.files', { count: payload.fileCount || 0 })}
                      </p>
                    </td>
                    <td className="px-4 py-4">
                      {job.status === 'failed' && job.error?.message && (
                        <p className="text-xs text-rose-300">{job.error.message}</p>
                      )}
                      {result ? (
                        <>
                          <p className="text-sm text-white">{result.label}</p>
                          {result.details && <p className="text-xs text-slate-500">{result.details}</p>}
                        </>
                      ) : (
                        job.status !== 'failed' && <p className="text-xs text-slate-500">—</p>
                      )}
                    </td>
                    <td className="px-4 py-4 text-right">
                      {showRetry ? (
                        <button
                          type="button"
                          onClick={() => handleRetry(job.id)}
                          disabled={isRetrying}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium border border-white/15 text-white hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed transition"
                        >
                          {isRetrying ? t('identifyQueue.retrying') : t('identifyQueue.actions.retry')}
                        </button>
                      ) : (
                        <span className="text-xs text-slate-500">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {jobs.length === 0 && !isLoading && (
          <p className="text-center text-slate-400 text-sm py-8">{t('identifyQueue.empty')}</p>
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
            className="px-6 py-2 rounded-xl border border-white/10 bg-white/5 text-white text-sm hover:bg-white/10 transition"
          >
            {t('identifyQueue.actions.loadMore')}
          </button>
        </div>
      )}
    </section>
  );
};

export default IdentifyQueueView;

