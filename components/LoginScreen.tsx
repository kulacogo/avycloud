import React from 'react';
import { useAuth } from '../context/AuthContext';
import { requestPasswordReset } from '../api/client';
import { useI18n } from '../i18n';

export const LoginScreen: React.FC = () => {
  const { t } = useI18n();
  const { signInWithEmailPassword } = useAuth();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showReset, setShowReset] = React.useState(false);
  const [resetEmail, setResetEmail] = React.useState('');
  const [resetSubmitting, setResetSubmitting] = React.useState(false);
  const [resetMessage, setResetMessage] = React.useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signInWithEmailPassword(email, password);
    } catch (err: any) {
      setError(err?.message || t('auth.login.error'));
    } finally {
      setSubmitting(false);
    }
  };

  const onRequestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetMessage(null);
    setError(null);

    const value = String(resetEmail || '').trim().toLowerCase();
    if (!value.endsWith('@trendocean.de')) {
      setResetMessage(t('auth.login.reset.domainError', { domain: '@trendocean.de' }));
      return;
    }

    setResetSubmitting(true);
    try {
      await requestPasswordReset(value);
      setResetMessage(t('auth.login.reset.sent'));
    } catch (err: any) {
      setResetMessage(err?.message || t('auth.login.reset.failed'));
    } finally {
      setResetSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-800/60 shadow-2xl shadow-black/40 p-6 space-y-5">
        <div className="space-y-1">
          <h1 className="text-xl font-bold">{t('auth.login.title')}</h1>
          <p className="text-sm text-slate-400">{t('auth.login.subtitle', { domain: '@trendocean.de' })}</p>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-800 bg-rose-900/40 px-4 py-3 text-sm text-rose-50">
            {error}
          </div>
        )}

        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block space-y-1">
            <span className="text-sm text-slate-300">{t('auth.login.emailLabel')}</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@trendocean.de"
              autoComplete="email"
              className="w-full rounded-xl bg-slate-900/60 border border-white/10 px-3 py-2.5 text-slate-100 outline-none focus:border-sky-500"
              required
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-slate-300">{t('auth.login.passwordLabel')}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full rounded-xl bg-slate-900/60 border border-white/10 px-3 py-2.5 text-slate-100 outline-none focus:border-sky-500"
              required
            />
          </label>
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-60 disabled:hover:bg-sky-600 px-4 py-2.5 font-semibold text-white transition-colors"
          >
            {submitting ? t('auth.login.submitting') : t('auth.login.submit')}
          </button>
        </form>

        <div className="space-y-3">
          <button
            type="button"
            onClick={() => {
              setShowReset((v) => !v);
              setResetMessage(null);
              setResetEmail((prev) => prev || String(email || '').trim().toLowerCase());
            }}
            className="text-left text-xs text-slate-400 hover:text-slate-200 underline underline-offset-4"
          >
            {t('auth.login.forgotPassword')}
          </button>

          {showReset && (
            <form onSubmit={onRequestReset} className="space-y-2">
              <label className="block space-y-1">
                <span className="text-xs text-slate-300">{t('auth.login.reset.emailLabel')}</span>
                <input
                  type="email"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  placeholder="name@trendocean.de"
                  autoComplete="email"
                  className="w-full rounded-xl bg-slate-900/60 border border-white/10 px-3 py-2.5 text-slate-100 outline-none focus:border-sky-500"
                  required
                />
              </label>

              <button
                type="submit"
                disabled={resetSubmitting}
                className="w-full rounded-xl bg-slate-700 hover:bg-slate-600 disabled:opacity-60 disabled:hover:bg-slate-700 px-4 py-2.5 font-semibold text-white transition-colors"
              >
                {resetSubmitting ? t('auth.login.reset.submitting') : t('auth.login.reset.submit')}
              </button>

              {resetMessage && <p className="text-xs text-slate-400">{resetMessage}</p>}
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

