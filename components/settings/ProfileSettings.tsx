import React, { useState } from "react";
import { Card } from "../ui/Card";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { Avatar } from "../ui/Avatar";

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
  { key: "dailySummary", label: "Tagliche Zusammenfassung" },
];

type ThemeOption = "light" | "dark" | "system";

export const ProfileSettings: React.FC = () => {
  const [vorname, setVorname] = useState("Max");
  const [nachname, setNachname] = useState("Mustermann");
  const [email] = useState("max@muster-gmbh.de");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [notifications, setNotifications] = useState<Record<string, boolean>>({
    newOrder: true,
    lowStock: true,
    syncError: true,
    returnReceived: false,
    dailySummary: true,
  });
  const [theme, setTheme] = useState<ThemeOption>("system");
  const [saving, setSaving] = useState(false);

  const toggleNotification = (key: string) => {
    setNotifications((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || newPassword !== confirmPassword) return;
    setChangingPassword(true);
    // TODO: API call to change password (POST /api/auth/change-password)
    await new Promise((r) => setTimeout(r, 800));
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setChangingPassword(false);
  };

  const handleSave = async () => {
    setSaving(true);
    // TODO: API call to save profile settings (PUT /api/settings/profile)
    await new Promise((r) => setTimeout(r, 800));
    setSaving(false);
  };

  const initials = `${vorname.charAt(0)}${nachname.charAt(0)}`;

  return (
    <div className="space-y-6">
      {/* Avatar */}
      <Card>
        <div className="flex items-center gap-4">
          <Avatar initials={initials} size="lg" />
          <div>
            <p className="text-sm font-semibold text-txt-primary">{vorname} {nachname}</p>
            <button
              type="button"
              className="text-xs text-accent hover:text-accent/80 transition-colors mt-1"
            >
              {/* TODO: Implement avatar upload */}
              Profilbild andern
            </button>
          </div>
        </div>
      </Card>

      {/* Persoenliche Daten */}
      <Card>
        <h3 className="text-sm font-semibold text-txt-primary mb-4">Personliche Daten</h3>
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
              helpText="Kontaktiere den Admin um die E-Mail zu andern"
            />
          </div>
        </div>
      </Card>

      {/* Passwort aendern */}
      <Card>
        <h3 className="text-sm font-semibold text-txt-primary mb-4">Passwort andern</h3>
        <div className="space-y-4 max-w-md">
          <Input
            label="Aktuelles Passwort"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="********"
          />
          <Input
            label="Neues Passwort"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="********"
          />
          <Input
            label="Neues Passwort bestatigen"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="********"
            error={confirmPassword && newPassword !== confirmPassword ? "Passworter stimmen nicht uberein" : undefined}
          />
          <Button
            variant="secondary"
            size="md"
            loading={changingPassword}
            onClick={handleChangePassword}
            disabled={!currentPassword || !newPassword || newPassword !== confirmPassword}
          >
            Passwort andern
          </Button>
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
          Anderungen speichern
        </Button>
      </div>
    </div>
  );
};

export default ProfileSettings;
