import React from 'react';
import { confirmPasswordReset, verifyPasswordResetCode } from 'firebase/auth';
import { getFirebaseAuth } from '../../utils/firebase';
import { requestPasswordReset } from '../../api/client';
import { useI18n } from '../../i18n';

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
    <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-7 h-7 rounded-lg avy-gradient flex-shrink-0" />
          <span className="text-xl font-bold text-[var(--text-primary)] tracking-tight">AvyCloud</span>
        </div>

        {/* Card */}
        <div className="bg-[var(--surface)] rounded-2xl shadow-lg border border-[var(--border)] p-8">
          {/* Header */}
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">{t('auth.reset.title')}</h1>
            <p className="text-sm text-[var(--text-secondary)] mt-1">{t('auth.reset.subtitle')}</p>
          </div>

          {/* Loading state */}
          {loading && (
            <div className="flex items-center gap-2 py-3">
              <div className="w-4 h-4 border-2 border-[var(--avy-purple)] border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-[var(--text-secondary)]">{t('auth.reset.checking')}</p>
            </div>
          )}

          {/* Account email */}
          {!loading && email && (
            <div className="text-xs text-[var(--text-tertiary)] mb-4">
              {t('auth.reset.accountLabel')}{' '}
              <span className="text-[var(--text-primary)] font-medium">{email}</span>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mb-4 rounded-lg bg-[var(--error-bg)] border border-[var(--error-border)] px-4 py-3 text-sm text-[var(--error)]">
              {error}
            </div>
          )}

          {/* Success */}
          {success && (
            <div className="mb-4 rounded-lg bg-[var(--success-bg)] border border-[var(--success-border)] px-4 py-3 text-sm text-[var(--success)]">
              {success}
            </div>
          )}

          {/* Reset password form */}
          {!loading && !success && (
            <form onSubmit={onSubmit} className="space-y-4">
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold text-[var(--text-secondary)] tracking-wide">
                  {t('auth.reset.newPasswordLabel')}
                </span>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  className="w-full px-3 py-2.5 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] transition-all duration-200 focus:outline-none focus:border-[var(--avy-purple)] focus:shadow-[var(--shadow-focus)]"
                  required
                />
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs font-semibold text-[var(--text-secondary)] tracking-wide">
                  {t('auth.reset.confirmPasswordLabel')}
                </span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  className="w-full px-3 py-2.5 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] transition-all duration-200 focus:outline-none focus:border-[var(--avy-purple)] focus:shadow-[var(--shadow-focus)]"
                  required
                />
              </label>

              <button
                type="submit"
                disabled={submitting || !oobCode}
                className="w-full rounded-lg bg-[var(--avy-purple)] hover:bg-[var(--avy-purple-hover)] disabled:opacity-60 disabled:hover:bg-[var(--avy-purple)] px-4 py-2.5 font-semibold text-white text-sm transition-all duration-200 hover:translate-y-[-1px] hover:shadow-[0_4px_12px_rgba(99,91,255,0.3)] active:translate-y-0"
              >
                {submitting ? t('auth.reset.submitting') : t('auth.reset.submit')}
              </button>
            </form>
          )}

          {/* Resend section */}
          <div className="mt-6 pt-5 border-t border-[var(--border)] space-y-3">
            <p className="text-xs text-[var(--text-tertiary)]">
              {t('auth.reset.resend.hint')}
            </p>

            <form onSubmit={onResend} className="space-y-3">
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold text-[var(--text-secondary)] tracking-wide">
                  {t('auth.reset.resend.emailLabel')}
                </span>
                <input
                  type="email"
                  value={resendEmail}
                  onChange={(e) => setResendEmail(e.target.value)}
                  placeholder="name@trendocean.de"
                  autoComplete="email"
                  className="w-full px-3 py-2.5 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] transition-all duration-200 focus:outline-none focus:border-[var(--avy-purple)] focus:shadow-[var(--shadow-focus)]"
                  required
                />
              </label>

              <button
                type="submit"
                disabled={resendSubmitting}
                className="w-full rounded-lg bg-[var(--surface-secondary)] hover:bg-[var(--border)] text-[var(--text-secondary)] disabled:opacity-60 disabled:hover:bg-[var(--surface-secondary)] px-4 py-2.5 font-semibold text-sm transition-all duration-200"
              >
                {resendSubmitting ? t('auth.reset.resend.submitting') : t('auth.reset.resend.submit')}
              </button>

              {resendMessage && (
                <p className="text-xs text-[var(--text-secondary)]">{resendMessage}</p>
              )}
            </form>
          </div>

          {/* Back to login */}
          <div className="mt-5">
            <button
              type="button"
              onClick={() => {
                window.location.href = '/';
              }}
              className="text-xs text-[var(--avy-purple)] hover:text-[var(--avy-purple-hover)] font-medium transition-colors duration-200"
            >
              {t('auth.reset.backToLogin')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
