import React from 'react';
import { useForm } from 'react-hook-form';
import { useAuth } from '../context/AuthContext';
import { requestPasswordReset } from '../api/client';
import { useI18n } from '../i18n';

interface LoginFormData {
  email: string;
  password: string;
}

interface ResetFormData {
  resetEmail: string;
}

export const LoginScreen: React.FC = () => {
  const { t } = useI18n();
  const { signInWithEmailPassword } = useAuth();
  const [error, setError] = React.useState<string | null>(null);
  const [showReset, setShowReset] = React.useState(false);
  const [resetMessage, setResetMessage] = React.useState<string | null>(null);

  const {
    register: registerLogin,
    handleSubmit: handleLoginSubmit,
    formState: { isSubmitting: loginSubmitting },
    getValues,
  } = useForm<LoginFormData>({ mode: 'onBlur' });

  const {
    register: registerReset,
    handleSubmit: handleResetSubmit,
    formState: { isSubmitting: resetSubmitting, errors: resetErrors },
  } = useForm<ResetFormData>({ mode: 'onBlur' });

  const onLogin = async (data: LoginFormData) => {
    setError(null);
    try {
      await signInWithEmailPassword(data.email, data.password);
    } catch (err: any) {
      setError(err?.message || t('auth.login.error'));
    }
  };

  const onRequestReset = async (data: ResetFormData) => {
    setResetMessage(null);
    setError(null);
    try {
      await requestPasswordReset(data.resetEmail.trim().toLowerCase());
      setResetMessage(t('auth.login.reset.sent'));
    } catch (err: any) {
      setResetMessage(err?.message || t('auth.login.reset.failed'));
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
          <div role="alert" className="rounded-xl border border-rose-800 bg-rose-900/40 px-4 py-3 text-sm text-rose-50">
            {error}
          </div>
        )}

        <form onSubmit={handleLoginSubmit(onLogin)} className="space-y-4" noValidate>
          <label className="block space-y-1">
            <span className="text-sm text-slate-300">{t('auth.login.emailLabel')}</span>
            <input
              type="email"
              {...registerLogin('email', { required: true })}
              placeholder="name@trendocean.de"
              autoComplete="email"
              className="w-full rounded-xl bg-slate-900/60 border border-white/10 px-3 py-2.5 text-slate-100 outline-none focus:border-sky-500"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-slate-300">{t('auth.login.passwordLabel')}</span>
            <input
              type="password"
              {...registerLogin('password', { required: true })}
              autoComplete="current-password"
              className="w-full rounded-xl bg-slate-900/60 border border-white/10 px-3 py-2.5 text-slate-100 outline-none focus:border-sky-500"
            />
          </label>
          <button
            type="submit"
            disabled={loginSubmitting}
            className="w-full rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-60 disabled:hover:bg-sky-600 px-4 py-2.5 font-semibold text-white transition-colors"
          >
            {loginSubmitting ? t('auth.login.submitting') : t('auth.login.submit')}
          </button>
        </form>

        <div className="space-y-3">
          <button
            type="button"
            onClick={() => {
              setShowReset((v) => !v);
              setResetMessage(null);
            }}
            className="text-left text-xs text-slate-400 hover:text-slate-200 underline underline-offset-4"
          >
            {t('auth.login.forgotPassword')}
          </button>

          {showReset && (
            <form onSubmit={handleResetSubmit(onRequestReset)} className="space-y-2" noValidate>
              <label className="block space-y-1">
                <span className="text-xs text-slate-300">{t('auth.login.reset.emailLabel')}</span>
                <input
                  type="email"
                  {...registerReset('resetEmail', {
                    required: true,
                    validate: (v) =>
                      v.trim().toLowerCase().endsWith('@trendocean.de') ||
                      (t('auth.login.reset.domainError', { domain: '@trendocean.de' }) as string),
                  })}
                  defaultValue={getValues('email') || ''}
                  placeholder="name@trendocean.de"
                  autoComplete="email"
                  className="w-full rounded-xl bg-slate-900/60 border border-white/10 px-3 py-2.5 text-slate-100 outline-none focus:border-sky-500"
                />
                {resetErrors.resetEmail?.message && (
                  <p className="text-xs text-rose-400">{resetErrors.resetEmail.message}</p>
                )}
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
