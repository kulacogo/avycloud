# AvyCloud Frontend v2 Redesign — Design Document

**Date:** 2026-02-19
**Author:** Claude (AI-assisted)
**Status:** Approved

## Goal

Replace the existing AvyCloud frontend UI with the v2.1 Design System (Stripe/Vercel inspired) while preserving 100% of the business logic, API integration, and feature set.

## Constraints

- **Same stack:** React 18.2 + Vite 4.4 + Tailwind 3.4 + TypeScript 5.0
- **Isolated build:** `frontend-v2/` in project root, independently runnable with `npm run dev`
- **No backend changes:** Same API client, same endpoints, same auth flow
- **Big-bang deploy:** Swap folder contents when ready, single deploy via existing CI/CD

## Architecture

### Directory Structure

```
frontend-v2/
├── index.html
├── package.json              # Same deps as root
├── vite.config.ts            # Port 3001 (to avoid conflict)
├── tsconfig.json
├── tailwind.config.ts        # New v2.1 Design System tokens
├── postcss.config.cjs
├── index.tsx                  # Entry point (same as current)
├── App.tsx                    # Slim router shell — delegates to modules
├── types.ts                   # Copied 1:1 from existing
├── constants.ts               # Copied 1:1
├── i18n.tsx                   # Copied 1:1
│
├── styles/
│   └── main.css              # Tailwind + v2.1 CSS variables
│
├── api/
│   └── client.ts             # Copied 1:1
│
├── utils/                    # Copied 1:1 (firebase.ts, gtin.ts, etc.)
│
├── context/                  # Copied 1:1 (AuthContext, InventoryContext)
│
├── hooks/                    # Copied 1:1 (all 5 hooks)
│
├── components/
│   ├── ui/                   # NEW: Design System primitives
│   │   ├── Button.tsx
│   │   ├── Card.tsx
│   │   ├── Input.tsx
│   │   ├── Badge.tsx
│   │   ├── Modal.tsx
│   │   ├── Toast.tsx
│   │   ├── CommandPalette.tsx
│   │   ├── Table.tsx
│   │   └── Spinner.tsx
│   │
│   ├── layout/               # NEW: Layout shell
│   │   ├── Sidebar.tsx
│   │   ├── Topbar.tsx
│   │   ├── MobileHeader.tsx
│   │   ├── MobileTabBar.tsx
│   │   └── AppShell.tsx      # Sidebar + Topbar + Content wrapper
│   │
│   ├── icons/
│   │   └── Icons.tsx         # Copied 1:1
│   │
│   ├── views/                # Redesigned views (same props/logic)
│   │   ├── Dashboard.tsx
│   │   ├── DashboardMobile.tsx
│   │   ├── ProductSheet.tsx
│   │   ├── AdminTable.tsx
│   │   ├── ProductInput.tsx
│   │   ├── EbayListingsView.tsx
│   │   ├── OperationsView.tsx
│   │   ├── MobileOperationsView.tsx
│   │   ├── WarehouseView.tsx
│   │   ├── CategoryManagement.tsx
│   │   ├── LoginScreen.tsx
│   │   ├── ResetPasswordScreen.tsx
│   │   ├── MobileSearchView.tsx
│   │   └── GeminiChat.tsx
│   │
│   ├── admin/                # Redesigned admin modules
│   │   ├── AdminPanel.tsx
│   │   ├── AdminUserManagement.tsx
│   │   ├── AdminGroupManagement.tsx
│   │   ├── AdminRoleManagement.tsx
│   │   ├── AdminLlmManagement.tsx
│   │   ├── AdminBulkActions.tsx
│   │   ├── AdminJobsManagement.tsx
│   │   ├── AdminIntegrations.tsx
│   │   ├── AdminEbayTaxonomy.tsx
│   │   ├── AdminRulebookManagement.tsx
│   │   └── AdminProductCoverageDashboard.tsx
│   │
│   ├── chat/                 # Redesigned chat components
│   │   ├── ChatContainer.tsx
│   │   ├── ChatInput.tsx
│   │   ├── MessageBubble.tsx
│   │   ├── AttachmentMessage.tsx
│   │   └── FileAttachmentPreview.tsx
│   │
│   ├── product/              # Split from monolithic ProductSheet
│   │   ├── ImageGallery.tsx
│   │   ├── AttributeTable.tsx
│   │   ├── PricingInfo.tsx
│   │   └── InventoryDrilldownPanel.tsx
│   │
│   ├── shared/               # Other shared components
│   │   ├── ConfirmDialog.tsx
│   │   ├── HelpDisclosure.tsx
│   │   ├── Notice.tsx
│   │   ├── PageHeader.tsx
│   │   ├── StatusDock.tsx
│   │   ├── ProcessStatusBar.tsx
│   │   ├── JobStatusPopup.tsx
│   │   └── ScannerOverlay.tsx
│   │
│   └── Header.tsx            # Legacy compat (re-exports Topbar)
```

### Design System v2.1 Tokens

**Colors:**
- Deep Blue sidebar: `#0A2540`
- Purple accent ("Blurple"): `#635BFF`
- Purple hover: `#5148E5`
- Purple light: `#818CF8`
- Purple glow: `rgba(99, 91, 255, 0.12)`
- Gradient: `linear-gradient(135deg, #635BFF, #0070F3)`

**Light mode:**
- Background: `#F6F9FC`
- Surface: `#FFFFFF`
- Text primary: `#0A2540`
- Text secondary: `#425466`
- Border: `#E3E8EE`

**Dark mode:**
- Background: `#0B0F14`
- Surface: `#151A21`
- Text primary: `#F1F3F5`
- Border: `#1E2A36`

**Shadows (light):**
- sm: `0 1px 1px rgba(0,0,0,0.03), 0 3px 6px rgba(0,0,0,0.02)`
- md: `0 2px 4px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06)`
- lg: `0 4px 8px rgba(0,0,0,0.04), 0 16px 48px rgba(0,0,0,0.08)`

**Spacing:** 4/8/12/16/20/24/32/40/48px
**Radius:** 6/8/12/16px
**Font:** Inter (Google Fonts)
**Base font size:** 14px (was 12px)

### App.tsx Refactoring

Current `App.tsx` (1080 lines) splits into:
1. **`App.tsx`** (~100 lines) — Provider wrapper + router switch
2. **`router.ts`** — Hash parsing, view-to-path mapping, allowed views
3. **`state/products.ts`** — Product state management (merge, identity keys, ensure inventory)
4. **`state/app.ts`** — Theme, view, dashboard range state

### Key UI Changes from Mockups

1. **Sidebar:** Fixed left, dark (#0A2540), logo + nav items + user footer, active indicator bar
2. **Topbar:** Sticky, search with Cmd+K shortcut, theme toggle, notifications
3. **Command Palette:** Full Cmd+K overlay with search, navigation, actions
4. **Cards:** Light surface, subtle border, hover border-color change
5. **Buttons:** Primary (purple), Secondary (bordered), Ghost, Danger variants
6. **Toast system:** Bottom-right, auto-dismiss with progress bar
7. **Tables:** Clean header, hover rows, inline actions
8. **Forms:** Labeled inputs with focus glow, read-only states
9. **Mobile:** Hamburger menu, bottom tab bar, larger touch targets

## Swap Strategy

When ready to deploy:
1. Move current frontend files to `frontend-v1-backup/`
2. Copy `frontend-v2/` contents to root (components/, hooks/, App.tsx, etc.)
3. Run `npm run build` to verify
4. `git add . && git commit && git push` — CI/CD deploys automatically
