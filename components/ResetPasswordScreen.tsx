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
    <div className="min-h-screen bg-slate-900 text-slate-200 flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-800/60 shadow-2xl shadow-black/40 p-6 space-y-5">
        <div className="space-y-1">
          <h1 className="text-xl font-bold">{t('auth.reset.title')}</h1>
          <p className="text-sm text-slate-400">{t('auth.reset.subtitle')}</p>
        </div>

        {loading && <p className="text-sm text-slate-300" role="status">{t('auth.reset.checking')}</p>}

        {!loading && email && (
          <div className="text-xs text-slate-500">
            {t('auth.reset.accountLabel')} <span className="text-slate-200">{email}</span>
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-xl border border-rose-800 bg-rose-900/40 px-4 py-3 text-sm text-rose-50">
            {error}
          </div>
        )}
        {success && (
          <div role="status" className="rounded-xl border border-emerald-800 bg-emerald-900/30 px-4 py-3 text-sm text-emerald-50">
            {success}
          </div>
        )}

        {!loading && !success && (
          <form onSubmit={handleResetSubmit(onSubmit)} className="space-y-4" noValidate>
            <label className="block space-y-1">
              <span className="text-sm text-slate-300">{t('auth.reset.newPasswordLabel')}</span>
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
                className="w-full rounded-xl bg-slate-900/60 border border-white/10 px-3 py-2.5 text-slate-100 outline-none focus:border-sky-500"
              />
              {resetErrors.newPassword?.message && (
                <p className="text-xs text-rose-400">{resetErrors.newPassword.message}</p>
              )}
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-slate-300">{t('auth.reset.confirmPasswordLabel')}</span>
              <input
                type="password"
                {...registerReset('confirmPassword', {
                  required: true,
                  validate: (v) =>
                    v === newPasswordValue ||
                    (t('auth.reset.passwordMismatch') as string),
                })}
                autoComplete="new-password"
                className="w-full rounded-xl bg-slate-900/60 border border-white/10 px-3 py-2.5 text-slate-100 outline-none focus:border-sky-500"
              />
              {resetErrors.confirmPassword?.message && (
                <p className="text-xs text-rose-400">{resetErrors.confirmPassword.message}</p>
              )}
            </label>

            <button
              type="submit"
              disabled={resetSubmitting || !oobCode}
              className="w-full rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-60 disabled:hover:bg-sky-600 px-4 py-2.5 font-semibold text-white transition-colors"
            >
              {resetSubmitting ? t('auth.reset.submitting') : t('auth.reset.submit')}
            </button>
          </form>
        )}

        <div className="border-t border-white/10 pt-4 space-y-3">
          <div className="text-xs text-slate-500">
            {t('auth.reset.resend.hint')}
          </div>
          <form onSubmit={handleResendSubmit(onResend)} className="space-y-2" noValidate>
            <label className="block space-y-1">
              <span className="text-xs text-slate-300">{t('auth.reset.resend.emailLabel')}</span>
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
                className="w-full rounded-xl bg-slate-900/60 border border-white/10 px-3 py-2.5 text-slate-100 outline-none focus:border-sky-500"
              />
              {resendErrors.resendEmail?.message && (
                <p className="text-xs text-rose-400">{resendErrors.resendEmail.message}</p>
              )}
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
