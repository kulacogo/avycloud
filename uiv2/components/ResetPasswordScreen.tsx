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
    <div className="min-h-screen bg-[var(--surface-secondary)] text-[color:var(--text-primary)] flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface-hover)]/60 shadow-2xl shadow-black/40 p-6 space-y-5">
        <div className="space-y-1">
          <h1 className="text-xl font-bold">{t('auth.reset.title')}</h1>
          <p className="text-sm text-[color:var(--text-tertiary)]">{t('auth.reset.subtitle')}</p>
        </div>

        {loading && <p className="text-sm text-[color:var(--text-secondary)]">{t('auth.reset.checking')}</p>}

        {!loading && email && (
          <div className="text-xs text-[color:var(--text-tertiary)]">
            {t('auth.reset.accountLabel')} <span className="text-[color:var(--text-primary)]">{email}</span>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-[var(--error-border)] bg-[var(--error-bg)] px-4 py-3 text-sm text-[color:var(--error)]">
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-xl border border-[var(--success-border)] bg-[var(--success-bg)] px-4 py-3 text-sm text-[color:var(--success)]">
            {success}
          </div>
        )}

        {!loading && !success && (
          <form onSubmit={onSubmit} className="space-y-4">
            <label className="block space-y-1">
              <span className="text-sm text-[color:var(--text-secondary)]">{t('auth.reset.newPasswordLabel')}</span>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                className="w-full rounded-xl bg-[var(--surface-secondary)]/60 border border-[var(--border)] px-3 py-2.5 text-[color:var(--text-primary)] outline-none focus:border-[var(--avy-purple)]"
                required
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-[color:var(--text-secondary)]">{t('auth.reset.confirmPasswordLabel')}</span>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                className="w-full rounded-xl bg-[var(--surface-secondary)]/60 border border-[var(--border)] px-3 py-2.5 text-[color:var(--text-primary)] outline-none focus:border-[var(--avy-purple)]"
                required
              />
            </label>

            <button
              type="submit"
              disabled={submitting || !oobCode}
              className="w-full rounded-xl bg-[var(--avy-purple)] hover:bg-[var(--avy-purple-hover)] disabled:opacity-60 disabled:hover:bg-[var(--avy-purple)] px-4 py-2.5 font-semibold text-[color:white] transition-colors"
            >
              {submitting ? t('auth.reset.submitting') : t('auth.reset.submit')}
            </button>
          </form>
        )}

        <div className="border-t border-[var(--border)] pt-4 space-y-3">
          <div className="text-xs text-[color:var(--text-tertiary)]">
            {t('auth.reset.resend.hint')}
          </div>
          <form onSubmit={onResend} className="space-y-2">
            <label className="block space-y-1">
              <span className="text-xs text-[color:var(--text-secondary)]">{t('auth.reset.resend.emailLabel')}</span>
              <input
                type="email"
                value={resendEmail}
                onChange={(e) => setResendEmail(e.target.value)}
                placeholder="name@trendocean.de"
                autoComplete="email"
                className="w-full rounded-xl bg-[var(--surface-secondary)]/60 border border-[var(--border)] px-3 py-2.5 text-[color:var(--text-primary)] outline-none focus:border-[var(--avy-purple)]"
                required
              />
            </label>
            <button
              type="submit"
              disabled={resendSubmitting}
              className="w-full rounded-xl bg-[var(--surface)] hover:bg-[var(--surface-secondary)] disabled:opacity-60 disabled:hover:bg-[var(--surface)] px-4 py-2.5 font-semibold text-[color:white] transition-colors"
            >
              {resendSubmitting ? t('auth.reset.resend.submitting') : t('auth.reset.resend.submit')}
            </button>
            {resendMessage && <p className="text-xs text-[color:var(--text-tertiary)]">{resendMessage}</p>}
          </form>
        </div>

        <button
          type="button"
          onClick={() => {
            window.location.href = '/';
          }}
          className="text-left text-xs text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] underline underline-offset-4"
        >
          {t('auth.reset.backToLogin')}
        </button>
      </div>
    </div>
  );
};

