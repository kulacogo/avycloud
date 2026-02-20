import React from 'react';
import { confirmPasswordReset, verifyPasswordResetCode } from 'firebase/auth';
import { getFirebaseAuth } from '../utils/firebase';
import { requestPasswordReset } from '../api/client';
import { useI18n } from '../i18n';

const getOobCode = (): string | null => {
  if (typeof window === 'undefined') return null;
  const search = new URLSearchParams(window.location.search || '');
  const code = search.get('oobCode') || search.get('oobcode');
  if (code) return code;

  // Fallback: support hash-based links too (e.g. #/reset-password?oobCode=...)
  const rawHash = window.location.hash.replace(/^#/, '');
  const [, queryPart] = rawHash.split('?');
  const hashParams = new URLSearchParams(queryPart || '');
  return hashParams.get('oobCode') || hashParams.get('oobcode');
};

export const ResetPasswordScreen: React.FC = () => {
  const { t } = useI18n();
  const [oobCode] = React.useState<string | null>(() => getOobCode());
  const [email, setEmail] = React.useState<string>('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  const [resendEmail, setResendEmail] = React.useState('');
  const [resendSubmitting, setResendSubmitting] = React.useState(false);
  const [resendMessage, setResendMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      setSuccess(null);
      setResendMessage(null);

      if (!oobCode) {
        setLoading(false);
        setError(t('auth.reset.invalidLink'));
        return;
      }

      try {
        const auth = getFirebaseAuth();
        const accountEmail = await verifyPasswordResetCode(auth, oobCode);
        if (cancelled) return;
        setEmail(accountEmail);
        setResendEmail(accountEmail);
      } catch (err: any) {
        if (cancelled) return;
        setError(t('auth.reset.expiredLink'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [oobCode, t]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!oobCode) {
      setError(t('auth.reset.invalidLink'));
      return;
    }
    if (newPassword.length < 6) {
      setError(t('auth.reset.passwordTooShort', { count: 6 }));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('auth.reset.passwordMismatch'));
      return;
    }

    setSubmitting(true);
    try {
      const auth = getFirebaseAuth();
      await confirmPasswordReset(auth, oobCode, newPassword);
      setSuccess(t('auth.reset.success'));
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      const message =
        err?.code === 'auth/expired-action-code' || err?.code === 'auth/invalid-action-code'
          ? t('auth.reset.expiredLink')
          : err?.code === 'auth/weak-password'
            ? t('auth.reset.weakPassword')
            : err?.message || t('auth.reset.saveFailed');
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const onResend = async (e: React.FormEvent) => {
    e.preventDefault();
    setResendMessage(null);

    const value = String(resendEmail || '').trim().toLowerCase();
    if (!value.endsWith('@trendocean.de')) {
      setResendMessage(t('auth.reset.resend.domainError', { domain: '@trendocean.de' }));
      return;
    }

    setResendSubmitting(true);
    try {
      await requestPasswordReset(value);
      setResendMessage(t('auth.reset.resend.sent'));
    } catch (err: any) {
      setResendMessage(err?.message || t('auth.reset.resend.failed'));
    } finally {
      setResendSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-800/60 shadow-2xl shadow-black/40 p-6 space-y-5">
        <div className="space-y-1">
          <h1 className="text-xl font-bold">{t('auth.reset.title')}</h1>
          <p className="text-sm text-slate-400">{t('auth.reset.subtitle')}</p>
        </div>

        {loading && <p className="text-sm text-slate-300">{t('auth.reset.checking')}</p>}

        {!loading && email && (
          <div className="text-xs text-slate-500">
            {t('auth.reset.accountLabel')} <span className="text-slate-200">{email}</span>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-rose-800 bg-rose-900/40 px-4 py-3 text-sm text-rose-50">
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-xl border border-emerald-800 bg-emerald-900/30 px-4 py-3 text-sm text-emerald-50">
            {success}
          </div>
        )}

        {!loading && !success && (
          <form onSubmit={onSubmit} className="space-y-4">
            <label className="block space-y-1">
              <span className="text-sm text-slate-300">{t('auth.reset.newPasswordLabel')}</span>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                className="w-full rounded-xl bg-slate-900/60 border border-white/10 px-3 py-2.5 text-slate-100 outline-none focus:border-sky-500"
                required
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-slate-300">{t('auth.reset.confirmPasswordLabel')}</span>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                className="w-full rounded-xl bg-slate-900/60 border border-white/10 px-3 py-2.5 text-slate-100 outline-none focus:border-sky-500"
                required
              />
            </label>

            <button
              type="submit"
              disabled={submitting || !oobCode}
              className="w-full rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-60 disabled:hover:bg-sky-600 px-4 py-2.5 font-semibold text-white transition-colors"
            >
              {submitting ? t('auth.reset.submitting') : t('auth.reset.submit')}
            </button>
          </form>
        )}

        <div className="border-t border-white/10 pt-4 space-y-3">
          <div className="text-xs text-slate-500">
            {t('auth.reset.resend.hint')}
          </div>
          <form onSubmit={onResend} className="space-y-2">
            <label className="block space-y-1">
              <span className="text-xs text-slate-300">{t('auth.reset.resend.emailLabel')}</span>
              <input
                type="email"
                value={resendEmail}
                onChange={(e) => setResendEmail(e.target.value)}
                placeholder="name@trendocean.de"
                autoComplete="email"
                className="w-full rounded-xl bg-slate-900/60 border border-white/10 px-3 py-2.5 text-slate-100 outline-none focus:border-sky-500"
                required
              />
            </label>
            <button
              type="submit"
              disabled={resendSubmitting}
              className="w-full rounded-xl bg-slate-700 hover:bg-slate-600 disabled:opacity-60 disabled:hover:bg-slate-700 px-4 py-2.5 font-semibold text-white transition-colors"
            >
              {resendSubmitting ? t('auth.reset.resend.submitting') : t('auth.reset.resend.submit')}
            </button>
            {resendMessage && <p className="text-xs text-slate-400">{resendMessage}</p>}
          </form>
        </div>

        <button
          type="button"
          onClick={() => {
            window.location.href = '/';
          }}
          className="text-left text-xs text-slate-400 hover:text-slate-200 underline underline-offset-4"
        >
          {t('auth.reset.backToLogin')}
        </button>
      </div>
    </div>
  );
};

