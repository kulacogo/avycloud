---
paths:
  - "components/**/*.tsx"
  - "hooks/**/*.ts"
  - "context/**/*.tsx"
  - "api/**/*.ts"
  - "utils/**/*.ts"
  - "types.ts"
  - "App.tsx"
  - "i18n.tsx"
---

# Frontend Rules

- TypeScript, ES Modules, React Functional Components + Hooks
- 2 Spaces, Double Quotes
- Farben NUR über Design-Tokens: `bg-accent`, `text-txt-primary`, `bg-app-surface` — NIEMALS `bg-blue-500`
- Dark Mode ist Default. Light Mode via `[data-theme='light']`. Beide testen.
- Status-Farben: success/warning/danger/info + `-dim` Varianten für Hintergründe
- Radii: `rounded-sm` (6px), `rounded-md` (8px), `rounded-lg` (12px)
- Seitentitel NIE als eigenes `<h1>` — immer `components/ui/PageTitle.tsx`. Die Topbar (`VIEW_TITLES`) zeigt den Seitennamen ab Desktop; PageTitle blendet sich dort aus und bleibt nur mobil sichtbar (mobiler `Header.tsx` hat keinen Titel). `PageHeader` ist für ABSCHNITTE innerhalb einer Seite (`title` optional)
- Logo: `object-contain`, nie verzerren. Siehe `public/` für Assets
- Markenname: "AvyCloud" (CamelCase in Text), "avycloud" (Wordmark)
- Token-Definitionen: `styles/main.css` + `tailwind.config.cjs`
