import React from 'react';
import { Sun, Moon, Eye, EyeOff, ArrowLeft, Layers, Sparkles, RefreshCw, Package } from 'lucide-react';
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
  const [showPassword, setShowPassword] = React.useState(false);
  const [showReset, setShowReset] = React.useState(false);
  const [resetEmail, setResetEmail] = React.useState('');
  const [resetSubmitting, setResetSubmitting] = React.useState(false);
  const [resetMessage, setResetMessage] = React.useState<string | null>(null);
  const [resetSuccess, setResetSuccess] = React.useState(false);

  const theme = document.documentElement.getAttribute('data-theme');
  const toggleTheme = () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('avycloud-theme', 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('avycloud-theme', 'dark');
    }
  };

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
      setResetSuccess(true);
      setResetMessage(t('auth.login.reset.sent'));
    } catch (err: any) {
      setResetMessage(err?.message || t('auth.login.reset.failed'));
    } finally {
      setResetSubmitting(false);
    }
  };

  const goToReset = () => {
    setShowReset(true);
    setResetMessage(null);
    setResetSuccess(false);
    setResetEmail((prev) => prev || String(email || '').trim().toLowerCase());
  };

  const goToLogin = () => {
    setShowReset(false);
    setResetMessage(null);
    setResetSuccess(false);
  };

  return (
    <div className="auth-page">
      {/* Left branded panel */}
      <div className="brand-panel">
        <div className="brand-logo">
          <div className="brand-logo-icon">A</div>
          <span className="brand-logo-text">AvyCloud</span>
          <span className="brand-mobile-tagline" style={{ display: 'none' }}>
            Smarte Lagerverwaltung
          </span>
        </div>

        <div className="brand-content">
          <h2 className="brand-headline">
            Smarte Lagerverwaltung<br />
            für deinen <span>eBay-Handel</span>
          </h2>

          <div className="feature-list">
            <div className="feature-item">
              <div className="feature-icon">
                <Sparkles size={20} />
              </div>
              <div className="feature-text">
                <h4>Produktidentifizierung mit KI</h4>
                <p>Automatische Erkennung und Klassifizierung deiner Produkte mit intelligenter Bildanalyse.</p>
              </div>
            </div>
            <div className="feature-item">
              <div className="feature-icon">
                <RefreshCw size={20} />
              </div>
              <div className="feature-text">
                <h4>Automatische eBay-Synchronisation</h4>
                <p>Echtzeit-Sync deiner Listings, Bestellungen und Bestände zwischen AvyCloud und eBay.</p>
              </div>
            </div>
            <div className="feature-item">
              <div className="feature-icon">
                <Package size={20} />
              </div>
              <div className="feature-text">
                <h4>Intelligentes Warehouse Management</h4>
                <p>Optimierte Lagerplätze, Kommissionierung und Bestandsverwaltung in Echtzeit.</p>
              </div>
            </div>
          </div>
        </div>

        <div className="trust-section">
          <div className="trust-avatars">
            {['M', 'K', 'S', 'T', '+'].map((letter) => (
              <div key={letter} className="trust-avatar">{letter}</div>
            ))}
          </div>
          <span className="trust-text">
            Vertraut von <strong>50+ eBay-Händlern</strong>
          </span>
        </div>
      </div>

      {/* Right form panel */}
      <div className="form-panel">
        {/* Theme toggle */}
        <button
          type="button"
          onClick={toggleTheme}
          style={{
            position: 'absolute', top: 24, right: 24, width: 40, height: 40,
            borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
            background: 'var(--surface)', cursor: 'pointer', display: 'flex',
            alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)',
            transition: 'all var(--transition)',
          }}
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />}
        </button>

        <div className="form-container">
          {!showReset ? (
            /* ─── LOGIN VIEW ─── */
            <>
              <div className="form-header">
                <h1>{t('auth.login.title')}</h1>
                <p>{t('auth.login.subtitle', { domain: '@trendocean.de' })}</p>
              </div>

              {error && (
                <div style={{
                  borderRadius: 'var(--radius-md)', background: 'var(--error-bg)',
                  border: '1px solid var(--error-border)', padding: '12px 16px',
                  fontSize: 13, color: 'var(--error)', marginBottom: 20,
                }}>
                  {error}
                </div>
              )}

              <form onSubmit={onSubmit} className="form-body">
                <div className="form-group">
                  <label className="form-label">{t('auth.login.emailLabel')}</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@trendocean.de"
                    autoComplete="email"
                    className="form-input"
                    required
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">{t('auth.login.passwordLabel')}</label>
                  <div style={{ position: 'relative' }}>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      className="form-input"
                      style={{ paddingRight: 44 }}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      style={{
                        position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
                        width: 36, height: 36, border: 'none', background: 'transparent',
                        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        borderRadius: 'var(--radius-sm)', color: 'var(--text-tertiary)',
                      }}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>

                <div className="form-row">
                  <button type="button" className="link-forgot" onClick={goToReset}>
                    {t('auth.login.forgotPassword')}
                  </button>
                </div>

                <button type="submit" disabled={submitting} className="btn btn-primary" style={{ width: '100%', height: 44 }}>
                  {submitting ? t('auth.login.submitting') : t('auth.login.submit')}
                </button>
              </form>
            </>
          ) : (
            /* ─── FORGOT PASSWORD VIEW ─── */
            <>
              <div className="form-header">
                <h1>{t('auth.login.reset.title') || 'Passwort zurücksetzen'}</h1>
                <p>{t('auth.login.reset.description') || 'Gib deine E-Mail-Adresse ein und wir senden dir einen Link zum Zurücksetzen.'}</p>
              </div>

              {!resetSuccess ? (
                <form onSubmit={onRequestReset} className="form-body">
                  <div className="form-group">
                    <label className="form-label">{t('auth.login.reset.emailLabel')}</label>
                    <input
                      type="email"
                      value={resetEmail}
                      onChange={(e) => setResetEmail(e.target.value)}
                      placeholder="name@trendocean.de"
                      autoComplete="email"
                      className="form-input"
                      required
                    />
                  </div>

                  {resetMessage && !resetSuccess && (
                    <p style={{ fontSize: 13, color: 'var(--error)' }}>{resetMessage}</p>
                  )}

                  <button type="submit" disabled={resetSubmitting} className="btn btn-primary" style={{ width: '100%', height: 44 }}>
                    {resetSubmitting ? t('auth.login.reset.submitting') : t('auth.login.reset.submit')}
                  </button>
                </form>
              ) : (
                <div style={{ textAlign: 'center', padding: '24px 0' }}>
                  <div style={{
                    width: 56, height: 56, borderRadius: '50%',
                    background: 'rgba(14,159,110,0.1)', margin: '0 auto 16px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: 'var(--success)', fontSize: 28,
                  }}>
                    ✓
                  </div>
                  <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
                    {t('auth.login.reset.successTitle') || 'E-Mail gesendet'}
                  </h3>
                  <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    {resetMessage}
                  </p>
                </div>
              )}

              <button type="button" className="forgot-back" onClick={goToLogin}>
                <ArrowLeft size={14} />
                {t('auth.login.reset.back') || 'Zurück zum Login'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
