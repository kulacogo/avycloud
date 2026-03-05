import React from 'react';
import { useForm } from 'react-hook-form';
import { confirmPasswordReset, verifyPasswordResetCode } from 'firebase/auth';
import { getFirebaseAuth } from '../utils/firebase';
import { requestPasswordReset } from '../api/client';
import { useI18n } from '../i18n';

interface ResetFormData {
  newPassword: string;
  confirmPassword: string;
}

interface ResendFormData {
  resendEmail: string;
}

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
  const [resendMessage, setResendMessage] = React.useState<string | null>(null);

  const {
    register: registerReset,
    handleSubmit: handleResetSubmit,
    formState: { isSubmitting: resetSubmitting, errors: resetErrors },
    reset: resetForm,
    watch,
  } = useForm<ResetFormData>({ mode: 'onBlur' });

  const {
    register: registerResend,
    handleSubmit: handleResendSubmit,
    formState: { isSubmitting: resendSubmitting, errors: resendErrors },
  } = useForm<ResendFormData>({ mode: 'onBlur' });

  const newPasswordValue = watch('newPassword');

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

  const onSubmit = async (data: ResetFormData) => {
    setError(null);
    setSuccess(null);

    if (!oobCode) {
      setError(t('auth.reset.invalidLink'));
      return;
    }

    try {
      const auth = getFirebaseAuth();
      await confirmPasswordReset(auth, oobCode, data.newPassword);
      setSuccess(t('auth.reset.success'));
      resetForm();
    } catch (err: any) {
      const message =
        err?.code === 'auth/expired-action-code' || err?.code === 'auth/invalid-action-code'
          ? t('auth.reset.expiredLink')
          : err?.code === 'auth/weak-password'
            ? t('auth.reset.weakPassword')
            : err?.message || t('auth.reset.saveFailed');
      setError(message);
    }
  };

  const onResend = async (data: ResendFormData) => {
    setResendMessage(null);
    try {
      await requestPasswordReset(data.resendEmail.trim().toLowerCase());
      setResendMessage(t('auth.reset.resend.sent'));
    } catch (err: any) {
      setResendMessage(err?.message || t('auth.reset.resend.failed'));
    }
  };

  return (
    <div className="min-h-screen bg-app-bg text-txt-secondary flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-app-border bg-app-surface shadow-2xl shadow-black/40 p-6 space-y-5">
        <div className="space-y-1">
          <h1 className="text-xl font-bold">{t('auth.reset.title')}</h1>
          <p className="text-sm text-txt-muted">{t('auth.reset.subtitle')}</p>
        </div>

        {loading && <p className="text-sm text-txt-secondary" role="status">{t('auth.reset.checking')}</p>}

        {!loading && email && (
          <div className="text-xs text-txt-muted">
            {t('auth.reset.accountLabel')} <span className="text-txt-secondary">{email}</span>
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-xl border border-danger/30 bg-danger-dim px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}
        {success && (
          <div role="status" className="rounded-xl border border-success/30 bg-success-dim px-4 py-3 text-sm text-success">
            {success}
          </div>
        )}

        {!loading && !success && (
          <form onSubmit={handleResetSubmit(onSubmit)} className="space-y-4" noValidate>
            <label className="block space-y-1">
              <span className="text-sm text-txt-secondary">{t('auth.reset.newPasswordLabel')}</span>
              <input
                type="password"
                {...registerReset('newPassword', {
                  required: true,
                  minLength: {
                    value: 6,
                    message: t('auth.reset.passwordTooShort', { count: 6 }) as string,
                  },
                })}
                autoComplete="new-password"
                className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2.5 text-txt-primary outline-none focus:border-accent"
              />
              {resetErrors.newPassword?.message && (
                <p className="text-xs text-danger">{resetErrors.newPassword.message}</p>
              )}
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-txt-secondary">{t('auth.reset.confirmPasswordLabel')}</span>
              <input
                type="password"
                {...registerReset('confirmPassword', {
                  required: true,
                  validate: (v) =>
                    v === newPasswordValue ||
                    (t('auth.reset.passwordMismatch') as string),
                })}
                autoComplete="new-password"
                className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2.5 text-txt-primary outline-none focus:border-accent"
              />
              {resetErrors.confirmPassword?.message && (
                <p className="text-xs text-danger">{resetErrors.confirmPassword.message}</p>
              )}
            </label>

            <button
              type="submit"
              disabled={resetSubmitting || !oobCode}
              className="w-full rounded-xl bg-accent hover:bg-accent/80 disabled:opacity-60 disabled:hover:bg-accent px-4 py-2.5 font-semibold text-txt-primary transition-colors"
            >
              {resetSubmitting ? t('auth.reset.submitting') : t('auth.reset.submit')}
            </button>
          </form>
        )}

        <div className="border-t border-app-border pt-4 space-y-3">
          <div className="text-xs text-txt-muted">
            {t('auth.reset.resend.hint')}
          </div>
          <form onSubmit={handleResendSubmit(onResend)} className="space-y-2" noValidate>
            <label className="block space-y-1">
              <span className="text-xs text-txt-secondary">{t('auth.reset.resend.emailLabel')}</span>
              <input
                type="email"
                {...registerResend('resendEmail', {
                  required: true,
                  validate: (v) =>
                    v.trim().toLowerCase().endsWith('@trendocean.de') ||
                    (t('auth.reset.resend.domainError', { domain: '@trendocean.de' }) as string),
                })}
                defaultValue={email || ''}
                placeholder="name@trendocean.de"
                autoComplete="email"
                className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2.5 text-txt-primary outline-none focus:border-accent"
              />
              {resendErrors.resendEmail?.message && (
                <p className="text-xs text-danger">{resendErrors.resendEmail.message}</p>
              )}
            </label>
            <button
              type="submit"
              disabled={resendSubmitting}
              className="w-full rounded-xl bg-app-elevated hover:bg-app-border disabled:opacity-60 disabled:hover:bg-app-elevated px-4 py-2.5 font-semibold text-txt-primary transition-colors"
            >
              {resendSubmitting ? t('auth.reset.resend.submitting') : t('auth.reset.resend.submit')}
            </button>
            {resendMessage && <p className="text-xs text-txt-muted">{resendMessage}</p>}
          </form>
        </div>

        <button
          type="button"
          onClick={() => {
            window.location.href = '/';
          }}
          className="text-left text-xs text-txt-muted hover:text-txt-secondary underline underline-offset-4"
        >
          {t('auth.reset.backToLogin')}
        </button>
      </div>
    </div>
  );
};
