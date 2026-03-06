import React, { useState, useEffect, useCallback } from "react";
import { Card } from "../ui/Card";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { Avatar } from "../ui/Avatar";
import { fetchProfile, saveProfile } from "../../api/client";

const SaveIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
    <polyline points="7 3 7 8 15 8" />
  </svg>
);

const LockIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0110 0v4" />
  </svg>
);

interface NotificationOption {
  key: string;
  label: string;
}

const notificationOptions: NotificationOption[] = [
  { key: "newOrder", label: "Neuer Auftrag" },
  { key: "lowStock", label: "Niedrig-Bestand Warnung" },
  { key: "syncError", label: "Sync-Fehler" },
  { key: "returnReceived", label: "Retoure eingegangen" },
  { key: "dailySummary", label: "Tägliche Zusammenfassung" },
];

type ThemeOption = "light" | "dark" | "system";

export const ProfileSettings: React.FC = () => {
  const [vorname, setVorname] = useState("");
  const [nachname, setNachname] = useState("");
  const [email, setEmail] = useState("");
  const [notifications, setNotifications] = useState<Record<string, boolean>>({});
  const [theme, setTheme] = useState<ThemeOption>("system");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const loadProfile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchProfile();
      if (data.vorname) setVorname(data.vorname);
      if (data.nachname) setNachname(data.nachname);
      if (data.email) setEmail(data.email);
      if (data.notifications) setNotifications(data.notifications);
      if (data.theme) setTheme(data.theme as ThemeOption);
      // Fallback: use displayName if vorname/nachname not set
      if (!data.vorname && !data.nachname && data.displayName) {
        const parts = data.displayName.split(" ");
        setVorname(parts[0] || "");
        setNachname(parts.slice(1).join(" ") || "");
      }
    } catch (err: any) {
      setError(err.message || "Fehler beim Laden des Profils");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  const toggleNotification = (key: string) => {
    setNotifications((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaveSuccess(false);
    try {
      await saveProfile({ vorname, nachname, notifications, theme });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message || "Fehler beim Speichern");
    } finally {
      setSaving(false);
    }
  };

  const initials = `${vorname.charAt(0)}${nachname.charAt(0)}`.toUpperCase() || "?";

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-app-surface border border-app-border rounded-xl p-6 h-24" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Error Banner */}
      {error && (
        <div className="bg-danger-dim border border-app-border rounded-xl px-4 py-3 flex items-center gap-3">
          <span className="text-sm text-danger flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-txt-muted hover:text-txt-primary text-sm">
            Schließen
          </button>
        </div>
      )}

      {/* Success Banner */}
      {saveSuccess && (
        <div className="bg-success-dim border border-app-border rounded-xl px-4 py-3 text-sm text-success font-medium">
          Profil erfolgreich gespeichert.
        </div>
      )}

      {/* Avatar */}
      <Card>
        <div className="flex items-center gap-4">
          <Avatar initials={initials} size="lg" />
          <div>
            <p className="text-sm font-semibold text-txt-primary">
              {vorname || nachname ? `${vorname} ${nachname}`.trim() : email || "Benutzer"}
            </p>
            <p className="text-xs text-txt-muted mt-0.5">{email}</p>
          </div>
        </div>
      </Card>

      {/* Persönliche Daten */}
      <Card>
        <h3 className="text-sm font-semibold text-txt-primary mb-4">Persönliche Daten</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Vorname" value={vorname} onChange={(e) => setVorname(e.target.value)} />
          <Input label="Nachname" value={nachname} onChange={(e) => setNachname(e.target.value)} />
          <div className="sm:col-span-2">
            <Input
              label="E-Mail"
              type="email"
              value={email}
              disabled
              iconRight={<LockIcon />}
              helpText="E-Mail kann nur über Firebase Authentication geändert werden"
            />
          </div>
        </div>
      </Card>

      {/* Benachrichtigungen */}
      <Card>
        <h3 className="text-sm font-semibold text-txt-primary mb-4">Benachrichtigungen</h3>
        <div className="space-y-3">
          {notificationOptions.map((opt) => (
            <label key={opt.key} className="flex items-center gap-3 cursor-pointer group">
              <span
                className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-colors ${
                  notifications[opt.key]
                    ? "bg-accent border-accent"
                    : "bg-app-elevated border-app-border group-hover:border-accent/40"
                }`}
                onClick={() => toggleNotification(opt.key)}
              >
                {notifications[opt.key] && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
              </span>
              <span className="text-sm text-txt-primary">{opt.label}</span>
            </label>
          ))}
        </div>
      </Card>

      {/* Design / Theme */}
      <Card>
        <h3 className="text-sm font-semibold text-txt-primary mb-4">Design</h3>
        <div className="flex flex-wrap gap-3">
          {([
            { value: "light" as ThemeOption, label: "Hell" },
            { value: "dark" as ThemeOption, label: "Dunkel" },
            { value: "system" as ThemeOption, label: "System" },
          ]).map((opt) => (
            <label
              key={opt.value}
              className={`flex items-center gap-2.5 px-4 py-2.5 rounded-xl border cursor-pointer transition-colors ${
                theme === opt.value
                  ? "border-accent bg-accent-dim text-accent"
                  : "border-app-border bg-app-elevated text-txt-secondary hover:border-accent/30"
              }`}
            >
              <input
                type="radio"
                name="theme"
                value={opt.value}
                checked={theme === opt.value}
                onChange={() => setTheme(opt.value)}
                className="sr-only"
              />
              <span
                className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                  theme === opt.value ? "border-accent" : "border-app-border"
                }`}
              >
                {theme === opt.value && <span className="w-2 h-2 rounded-full bg-accent" />}
              </span>
              <span className="text-sm font-medium">{opt.label}</span>
            </label>
          ))}
        </div>
      </Card>

      {/* Save */}
      <div className="flex justify-end">
        <Button
          variant="primary"
          size="lg"
          loading={saving}
          iconLeft={<SaveIcon />}
          onClick={handleSave}
          className="w-full sm:w-auto"
        >
          Änderungen speichern
        </Button>
      </div>
    </div>
  );
};

export default ProfileSettings;
