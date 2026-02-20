import React from 'react';
import { Search, Bell, Sun, Moon } from 'lucide-react';
import { useI18n } from '../i18n';

interface TopbarProps {
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

export const Topbar: React.FC<TopbarProps> = ({ theme, onToggleTheme }) => {
  const { t } = useI18n();

  return (
    <div className="topbar">
      <div className="topbar-search">
        <Search size={16} />
        <span>{t('search.placeholder') || 'Suchen...'}</span>
        <kbd>⌘K</kbd>
      </div>

      <div className="topbar-right">
        <button className="topbar-btn" aria-label="Notifications">
          <Bell size={18} />
          <span className="dot" />
        </button>

        <button
          className="theme-toggle"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? t('theme.switchToLight') : t('theme.switchToDark')}
        >
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>
    </div>
  );
};
