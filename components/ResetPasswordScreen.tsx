import React from 'react';
import { confirmPasswordReset, verifyPasswordResetCode } from 'firebase/auth';
import { getFirebaseAuth } from '../utils/firebase';
import { requestPasswordReset } from '../api/client';

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
        setError('Reset-Link ist ungültig. Bitte fordere einen neuen Link an.');
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
        setError('Dieser Reset-Link ist abgelaufen oder wurde bereits verwendet. Bitte fordere einen neuen Link an.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [oobCode]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!oobCode) {
      setError('Reset-Link ist ungültig. Bitte fordere einen neuen Link an.');
      return;
    }
    if (newPassword.length < 6) {
      setError('Das Passwort muss mindestens 6 Zeichen lang sein.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Die Passwörter stimmen nicht überein.');
      return;
    }

    setSubmitting(true);
    try {
      const auth = getFirebaseAuth();
      await confirmPasswordReset(auth, oobCode, newPassword);
      setSuccess('Passwort wurde gesetzt. Du kannst dich jetzt anmelden.');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      const message =
        err?.code === 'auth/expired-action-code' || err?.code === 'auth/invalid-action-code'
          ? 'Dieser Reset-Link ist abgelaufen oder wurde bereits verwendet. Bitte fordere einen neuen Link an.'
          : err?.code === 'auth/weak-password'
            ? 'Das Passwort ist zu schwach.'
            : err?.message || 'Passwort konnte nicht gesetzt werden.';
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
      setResendMessage('Bitte eine @trendocean.de E-Mail-Adresse eingeben.');
      return;
    }

    setResendSubmitting(true);
    try {
      await requestPasswordReset(value);
      setResendMessage('Wenn ein Konto existiert, wurde eine E-Mail mit einem Reset-Link gesendet.');
    } catch (err: any) {
      setResendMessage(err?.message || 'Reset-Link konnte nicht gesendet werden.');
    } finally {
      setResendSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-800/60 shadow-2xl shadow-black/40 p-6 space-y-5">
        <div className="space-y-1">
          <h1 className="text-xl font-bold">Passwort zurücksetzen</h1>
          <p className="text-sm text-slate-400">Setze ein neues Passwort für dein Konto.</p>
        </div>

        {loading && <p className="text-sm text-slate-300">Prüfe Reset-Link…</p>}

        {!loading && email && (
          <div className="text-xs text-slate-500">
            Konto: <span className="text-slate-200">{email}</span>
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
              <span className="text-sm text-slate-300">Neues Passwort</span>
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
              <span className="text-sm text-slate-300">Passwort wiederholen</span>
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
              {submitting ? 'Speichere…' : 'Passwort setzen'}
            </button>
          </form>
        )}

        <div className="border-t border-white/10 pt-4 space-y-3">
          <div className="text-xs text-slate-500">
            Link ungültig/abgelaufen? Fordere einen neuen Reset-Link an.
          </div>
          <form onSubmit={onResend} className="space-y-2">
            <label className="block space-y-1">
              <span className="text-xs text-slate-300">E-Mail</span>
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
              {resendSubmitting ? 'Sende…' : 'Neuen Reset-Link senden'}
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
          Zurück zum Login
        </button>
      </div>
    </div>
  );
};

