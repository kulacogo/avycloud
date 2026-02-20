/**
 * Header.tsx - Backward-compatibility shim for App.tsx
 *
 * The original v1 Header rendered a full navigation bar with icons, lang selector,
 * theme toggle, etc. In v2, navigation lives in the Sidebar/AppShell, and the top bar
 * is the Topbar component. This wrapper re-exports a <Header> with the same props
 * interface so App.tsx can import { Header } from './components/layout/Header'
 * without changes, while delegating to the v2 Topbar under the hood.
 */

import React from 'react';
import { Topbar } from './Topbar';

export interface HeaderProps {
  currentView:
    | 'dashboard'
    | 'home'
    | 'search'
    | 'input'
    | 'sheet'
    | 'inventory'
    | 'products'
    | 'admin'
    | 'categories'
    | 'ebay-listings'
    | 'warehouse'
    | 'operations'
    | 'operations-identify'
    | 'operations-stow'
    | 'operations-pick'
    | 'operations-pack';
  setView: (view: HeaderProps['currentView']) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

/**
 * Compatibility wrapper: accepts the legacy Header props and delegates to Topbar.
 * - `currentView` and `setView` are consumed by the Sidebar (not the Topbar), so
 *   they are intentionally not forwarded here.
 * - `onToggleTheme` is forwarded to Topbar's onToggleTheme.
 */
export const Header: React.FC<HeaderProps> = ({ onToggleTheme }) => {
  return <Topbar onToggleTheme={onToggleTheme} />;
};
