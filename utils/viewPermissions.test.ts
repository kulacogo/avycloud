import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { ALLOWED_VIEWS, canAccessView } from './viewPermissions.ts';
import type { View } from '../types';
const require = createRequire(import.meta.url);
const { defaultRoles } = require('../backend/lib/access-profiles.js');
const can = (role: string) => (module: string, action: string) => {
  const p = defaultRoles()[role].permissions;
  return p['*']?.['*'] === true || p[module]?.[action] === true;
};
test('alle renderbaren Ansichten sind registriert; unbekannte Ziele bleiben zu', () => {
  const app = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  for (const [, view] of app.matchAll(/case '([a-z-]+)':/g)) assert.ok(ALLOWED_VIEWS.includes(view as View), view);
  assert.equal(canAccessView('unknown' as View, can('admin')), false);
});
test('Mitarbeiter erreichen den vollständigen Arbeitsweg ohne Finanzen oder Verwaltung', () => {
  for (const view of ['operations-identify', 'operations-stow', 'operations-pick', 'operations-pack', 'products', 'orders', 'orders-shipping'] as View[]) assert.equal(canAccessView(view, can('employee')), true, view);
  for (const role of ['employee', 'manager', 'developer', 'viewer']) {
    for (const view of ['finance', 'settings', 'settings-team', 'settings-api', 'settings-billing', 'admin'] as View[]) assert.equal(canAccessView(view, can(role)), false, `${role}: ${view}`);
  }
});
test('Partner lesen Finanzberichte; Entwickler sehen Diagnose, keine Zugangskonfiguration', () => {
  assert.equal(canAccessView('finance', can('partner')), true);
  assert.equal(canAccessView('operations-pack', can('partner')), false);
  assert.equal(canAccessView('shop-health', can('developer')), true);
  assert.equal(canAccessView('integrations', can('developer')), true);
  assert.equal(canAccessView('integrations-sevdesk', can('developer')), false);
});
test('Menüs und direkter Seitenaufruf verwenden dieselbe Entscheidung', () => {
  for (const file of ['../App.tsx', '../components/Sidebar.tsx', '../components/Header.tsx', '../components/MobileTabBar.tsx']) assert.match(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), /canAccessView\(/);
});
