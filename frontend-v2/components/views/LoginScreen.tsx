import React from 'react';
import { useAuth } from '../../context/AuthContext';
import { requestPasswordReset } from '../../api/client';
import { useI18n } from '../../i18n';

export const LoginScreen: React.FC = () => {
  const { t } = useI18n();
  const { signInWithEmailPassword } = useAuth();

  // ---- Login state ----
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showPassword, setShowPassword] = React.useState(false);
  const [emailTouched, setEmailTouched] = React.useState(false);
  const [passwordTouched, setPasswordTouched] = React.useState(false);

  // ---- Forgot-password state ----
  const [showReset, setShowReset] = React.useState(false);
  const [resetEmail, setResetEmail] = React.useState('');
  const [resetSubmitting, setResetSubmitting] = React.useState(false);
  const [resetMessage, setResetMessage] = React.useState<string | null>(null);
  const [resetSuccess, setResetSuccess] = React.useState(false);
  const [resetEmailTouched, setResetEmailTouched] = React.useState(false);

  // ---- Validation helpers ----
  const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  const emailError = emailTouched && email.trim() !== '' && !isValidEmail(email.trim());
  const passwordError = passwordTouched && password === '';
  const resetEmailError = resetEmailTouched && resetEmail.trim() !== '' && !isValidEmail(resetEmail.trim());

  // ---- Login submit ----
  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailTouched(true);
    setPasswordTouched(true);

    if (!email.trim() || !isValidEmail(email.trim()) || !password) return;

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

  // ---- Forgot-password submit ----
  const onRequestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetEmailTouched(true);
    setResetMessage(null);
    setError(null);

    const value = String(resetEmail || '').trim().toLowerCase();
    if (!isValidEmail(value)) return;

    if (!value.endsWith('@trendocean.de')) {
      setResetMessage(t('auth.login.reset.domainError', { domain: '@trendocean.de' }));
      return;
    }

    setResetSubmitting(true);
    try {
      await requestPasswordReset(value);
      setResetSuccess(true);
      setResetMessage(t('auth.login.reset.sent'));
    } catch (err: any) {
      setResetMessage(err?.message || t('auth.login.reset.failed'));
    } finally {
      setResetSubmitting(false);
    }
  };

  // ---- View switching ----
  const goToForgot = () => {
    setShowReset(true);
    setResetEmail(email.trim().toLowerCase() || '');
    setResetMessage(null);
    setResetSuccess(false);
    setResetEmailTouched(false);
    setError(null);
  };

  const goToLogin = () => {
    setShowReset(false);
    setResetMessage(null);
    setResetSuccess(false);
    setResetEmailTouched(false);
    setError(null);
  };

  return (
    <div className="min-h-screen flex flex-col lg:flex-row animate-fade-in">
      {/* ================================================================
          LEFT: BRANDED PANEL
          ================================================================ */}
      <div className="hidden lg:flex lg:w-1/2 relative bg-avy-deep overflow-hidden flex-col justify-between p-12">
        {/* Animated gradient mesh background */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 20% 80%, rgba(99,91,255,0.15), transparent), radial-gradient(ellipse 60% 80% at 80% 20%, rgba(0,112,243,0.12), transparent), radial-gradient(ellipse 50% 50% at 50% 50%, rgba(99,91,255,0.06), transparent)',
          }}
        />
        {/* Subtle grid pattern */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)',
            backgroundSize: '64px 64px',
            maskImage: 'radial-gradient(ellipse at 60% 40%, black 20%, transparent 70%)',
            WebkitMaskImage: 'radial-gradient(ellipse at 60% 40%, black 20%, transparent 70%)',
          }}
        />

        {/* Logo */}
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-9 h-9 rounded-md avy-gradient flex items-center justify-center shadow-[0_2px_8px_rgba(99,91,255,0.3)]">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="#fff" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          <span className="text-xl font-bold text-white tracking-tight">AvyCloud</span>
        </div>

        {/* Hero content */}
        <div className="relative z-10 max-w-[440px]">
          <h2 className="text-[36px] font-extrabold text-white leading-[1.15] tracking-tight mb-10">
            Smarte Lagerverwaltung
            <br />
            f&uuml;r deinen{' '}
            <span className="bg-clip-text text-transparent" style={{ backgroundImage: 'linear-gradient(135deg, #635BFF, #0070F3)' }}>
              eBay-Handel
            </span>
          </h2>

          <div className="flex flex-col gap-6">
            <FeatureBullet
              icon={
                <svg viewBox="0 0 24 24" className="w-5 h-5 stroke-[var(--avy-purple-light)]" fill="none" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                </svg>
              }
              title="Produktidentifizierung mit KI"
              description="Automatische Erkennung und Klassifizierung deiner Produkte mit intelligenter Bildanalyse."
            />
            <FeatureBullet
              icon={
                <svg viewBox="0 0 24 24" className="w-5 h-5 stroke-[var(--avy-purple-light)]" fill="none" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              }
              title="Automatische eBay-Synchronisation"
              description="Echtzeit-Sync deiner Listings, Bestellungen und Bestaende zwischen AvyCloud und eBay."
            />
            <FeatureBullet
              icon={
                <svg viewBox="0 0 24 24" className="w-5 h-5 stroke-[var(--avy-purple-light)]" fill="none" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                </svg>
              }
              title="Intelligentes Warehouse Management"
              description="Optimierte Lagerplaetze, Kommissionierung und Bestandsverwaltung in Echtzeit."
            />
          </div>
        </div>

        {/* Trust badge */}
        <div className="relative z-10 flex items-center gap-3">
          <div className="flex">
            {['M', 'K', 'S', 'T', '+'].map((letter, i) => (
              <div
                key={i}
                className="w-7 h-7 rounded-full border-2 border-avy-deep flex items-center justify-center text-[10px] font-semibold text-white -mr-2 last:mr-0"
                style={{ background: 'linear-gradient(135deg, rgba(99,91,255,0.5), rgba(0,112,243,0.5))' }}
              >
                {letter}
              </div>
            ))}
          </div>
          <span className="text-[13px] text-white/50">
            Vertraut von <strong className="text-white/75 font-semibold">50+ eBay-Haendlern</strong>
          </span>
        </div>
      </div>

      {/* ================================================================
          MOBILE: Brand strip (shown when left panel hidden)
          ================================================================ */}
      <div className="lg:hidden bg-avy-deep relative overflow-hidden px-6 py-7 flex items-center gap-4">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 20% 80%, rgba(99,91,255,0.15), transparent), radial-gradient(ellipse 60% 80% at 80% 20%, rgba(0,112,243,0.12), transparent)',
          }}
        />
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-9 h-9 rounded-md avy-gradient flex items-center justify-center shadow-[0_2px_8px_rgba(99,91,255,0.3)]">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="#fff" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          <span className="text-lg font-bold text-white tracking-tight">AvyCloud</span>
        </div>
        <span className="relative z-10 text-[13px] text-white/60">Smarte Lagerverwaltung</span>
      </div>

      {/* ================================================================
          RIGHT: FORM PANEL
          ================================================================ */}
      <div className="flex-1 flex flex-col items-center justify-center bg-[var(--surface)] relative px-6 py-12 lg:px-12">
        <div className="w-full max-w-[380px] animate-slide-up">
          {/* ========== LOGIN VIEW ========== */}
          {!showReset && (
            <>
              {/* Header */}
              <div className="mb-8">
                <h1 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight mb-2">
                  {t('auth.login.title')}
                </h1>
                <p className="text-base text-[var(--text-secondary)] leading-relaxed">
                  {t('auth.login.subtitle', { domain: '@trendocean.de' })}
                </p>
              </div>

              {/* Global error message */}
              {error && (
                <div className="mb-5 rounded-lg bg-[var(--error-bg)] border border-[var(--error-border)] px-4 py-3 text-sm text-[var(--error)] flex items-center gap-2">
                  <svg viewBox="0 0 24 24" className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  {error}
                </div>
              )}

              {/* Login form */}
              <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
                {/* Email */}
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="login-email" className="text-[13px] font-medium text-[var(--text-primary)] flex items-center gap-1">
                    {t('auth.login.emailLabel')} <span className="text-[var(--error)] text-xs">*</span>
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); setEmailTouched(true); }}
                    onBlur={() => setEmailTouched(true)}
                    placeholder="name@trendocean.de"
                    autoComplete="email"
                    required
                    className={`w-full h-11 px-3.5 rounded-md border text-sm text-[var(--text-primary)] bg-[var(--surface)] placeholder:text-[var(--text-tertiary)] outline-none transition-all duration-200 hover:border-[var(--border-hover)] focus:border-[var(--avy-purple)] focus:shadow-[0_0_0_3px_var(--avy-purple-glow)] ${
                      emailError ? 'border-[var(--error)] shadow-[0_0_0_3px_rgba(220,38,38,0.1)] focus:border-[var(--error)] focus:shadow-[0_0_0_3px_rgba(220,38,38,0.15)]' : 'border-[var(--border)]'
                    }`}
                  />
                  <div className={`text-xs text-[var(--error)] flex items-center gap-1 overflow-hidden transition-all duration-200 ${emailError ? 'opacity-100 max-h-6 mt-0.5' : 'opacity-0 max-h-0'}`}>
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span>Bitte gib eine gueltige E-Mail-Adresse ein</span>
                  </div>
                </div>

                {/* Password */}
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="login-password" className="text-[13px] font-medium text-[var(--text-primary)] flex items-center gap-1">
                    {t('auth.login.passwordLabel')} <span className="text-[var(--error)] text-xs">*</span>
                  </label>
                  <div className="relative">
                    <input
                      id="login-password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => { setPassword(e.target.value); setPasswordTouched(true); }}
                      onBlur={() => setPasswordTouched(true)}
                      placeholder="Dein Passwort"
                      autoComplete="current-password"
                      required
                      className={`w-full h-11 px-3.5 pr-11 rounded-md border text-sm text-[var(--text-primary)] bg-[var(--surface)] placeholder:text-[var(--text-tertiary)] outline-none transition-all duration-200 hover:border-[var(--border-hover)] focus:border-[var(--avy-purple)] focus:shadow-[0_0_0_3px_var(--avy-purple-glow)] ${
                        passwordError ? 'border-[var(--error)] shadow-[0_0_0_3px_rgba(220,38,38,0.1)] focus:border-[var(--error)] focus:shadow-[0_0_0_3px_rgba(220,38,38,0.15)]' : 'border-[var(--border)]'
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Passwort verbergen' : 'Passwort anzeigen'}
                      className="absolute right-1 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center rounded-sm text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)] transition-all duration-200"
                    >
                      {showPassword ? (
                        <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      )}
                    </button>
                  </div>
                  <div className={`text-xs text-[var(--error)] flex items-center gap-1 overflow-hidden transition-all duration-200 ${passwordError ? 'opacity-100 max-h-6 mt-0.5' : 'opacity-0 max-h-0'}`}>
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span>Bitte gib dein Passwort ein</span>
                  </div>
                </div>

                {/* Forgot password link */}
                <div className="flex justify-end -mt-2">
                  <button
                    type="button"
                    onClick={goToForgot}
                    className="text-[13px] font-medium text-[var(--avy-purple)] hover:text-[var(--avy-purple-hover)] transition-colors duration-200 bg-transparent border-none cursor-pointer p-0"
                  >
                    {t('auth.login.forgotPassword')}
                  </button>
                </div>

                {/* Submit button */}
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full h-11 rounded-md bg-[var(--avy-purple)] hover:bg-[var(--avy-purple-hover)] text-white text-sm font-semibold flex items-center justify-center gap-2 transition-all duration-200 hover:-translate-y-px hover:shadow-[0_4px_12px_rgba(99,91,255,0.25)] active:translate-y-0 active:shadow-none disabled:opacity-70 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none mt-1 border-none cursor-pointer"
                >
                  {submitting ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      <span>{t('auth.login.submitting')}</span>
                    </>
                  ) : (
                    <span>{t('auth.login.submit')}</span>
                  )}
                </button>
              </form>

              {/* Footer */}
              <p className="text-center mt-7 text-[13px] text-[var(--text-secondary)]">
                Nur @trendocean.de Konten erlaubt
              </p>
            </>
          )}

          {/* ========== FORGOT PASSWORD VIEW ========== */}
          {showReset && (
            <>
              {/* Header */}
              <div className="mb-8">
                <h1 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight mb-2">
                  Passwort zuruecksetzen
                </h1>
                <p className="text-base text-[var(--text-secondary)] leading-relaxed">
                  Gib deine E-Mail-Adresse ein und wir senden dir einen Link zum Zuruecksetzen.
                </p>
              </div>

              {/* Error message from reset */}
              {resetMessage && !resetSuccess && (
                <div className="mb-5 rounded-lg bg-[var(--error-bg)] border border-[var(--error-border)] px-4 py-3 text-sm text-[var(--error)] flex items-center gap-2">
                  <svg viewBox="0 0 24 24" className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  {resetMessage}
                </div>
              )}

              {/* Reset form (hidden after success) */}
              {!resetSuccess && (
                <form onSubmit={onRequestReset} className="flex flex-col gap-5" noValidate>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="reset-email" className="text-[13px] font-medium text-[var(--text-primary)] flex items-center gap-1">
                      {t('auth.login.reset.emailLabel')} <span className="text-[var(--error)] text-xs">*</span>
                    </label>
                    <input
                      id="reset-email"
                      type="email"
                      value={resetEmail}
                      onChange={(e) => { setResetEmail(e.target.value); setResetEmailTouched(true); }}
                      onBlur={() => setResetEmailTouched(true)}
                      placeholder="name@trendocean.de"
                      autoComplete="email"
                      required
                      className={`w-full h-11 px-3.5 rounded-md border text-sm text-[var(--text-primary)] bg-[var(--surface)] placeholder:text-[var(--text-tertiary)] outline-none transition-all duration-200 hover:border-[var(--border-hover)] focus:border-[var(--avy-purple)] focus:shadow-[0_0_0_3px_var(--avy-purple-glow)] ${
                        resetEmailError ? 'border-[var(--error)] shadow-[0_0_0_3px_rgba(220,38,38,0.1)] focus:border-[var(--error)] focus:shadow-[0_0_0_3px_rgba(220,38,38,0.15)]' : 'border-[var(--border)]'
                      }`}
                    />
                    <div className={`text-xs text-[var(--error)] flex items-center gap-1 overflow-hidden transition-all duration-200 ${resetEmailError ? 'opacity-100 max-h-6 mt-0.5' : 'opacity-0 max-h-0'}`}>
                      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                      <span>Bitte gib eine gueltige E-Mail-Adresse ein</span>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={resetSubmitting}
                    className="w-full h-11 rounded-md bg-[var(--avy-purple)] hover:bg-[var(--avy-purple-hover)] text-white text-sm font-semibold flex items-center justify-center gap-2 transition-all duration-200 hover:-translate-y-px hover:shadow-[0_4px_12px_rgba(99,91,255,0.25)] active:translate-y-0 active:shadow-none disabled:opacity-70 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none border-none cursor-pointer"
                  >
                    {resetSubmitting ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        <span>{t('auth.login.reset.submitting')}</span>
                      </>
                    ) : (
                      <span>{t('auth.login.reset.submit')}</span>
                    )}
                  </button>
                </form>
              )}

              {/* Success state */}
              {resetSuccess && (
                <div className="text-center py-6 animate-slide-up">
                  <div className="w-14 h-14 rounded-full bg-[rgba(14,159,110,0.1)] mx-auto mb-4 flex items-center justify-center">
                    <svg viewBox="0 0 24 24" className="w-7 h-7" fill="none" stroke="var(--success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-2">E-Mail gesendet</h3>
                  <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                    {resetMessage}
                  </p>
                </div>
              )}

              {/* Back to login link */}
              <button
                type="button"
                onClick={goToLogin}
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--avy-purple)] hover:text-[var(--avy-purple-hover)] transition-colors duration-200 mt-4 bg-transparent border-none cursor-pointer p-0"
              >
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="19" y1="12" x2="5" y2="12" />
                  <polyline points="12 19 5 12 12 5" />
                </svg>
                Zurueck zum Login
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

/* ---------------------------------------------------------------
   Helper: Feature bullet for left branded panel
   --------------------------------------------------------------- */
const FeatureBullet: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: string;
}> = ({ icon, title, description }) => (
  <div className="flex items-start gap-4">
    <div className="w-10 h-10 min-w-[40px] rounded-md bg-[rgba(99,91,255,0.12)] border border-[rgba(99,91,255,0.2)] flex items-center justify-center">
      {icon}
    </div>
    <div>
      <h4 className="text-[15px] font-semibold text-white mb-0.5">{title}</h4>
      <p className="text-[13px] text-white/55 leading-relaxed">{description}</p>
    </div>
  </div>
);
