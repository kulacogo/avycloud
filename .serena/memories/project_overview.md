# AvyCloud — Project Overview

**Purpose:** Product Intelligence Hub for E-Commerce — AI-powered product identification, multi-marketplace sync (eBay, Kaufland), warehouse management, and order processing.

## Tech Stack
- **Frontend:** React 18 + TypeScript + Vite + Tailwind CSS → Firebase Hosting
- **Backend:** Node.js 20 + Express 4.19 (CommonJS) → Google Cloud Run (europe-west3)
- **Database:** Google Cloud Firestore (NoSQL) — active collection: `products_v2`
- **Storage:** Google Cloud Storage (`gs://prodsandjobs`)
- **AI:** Google Gemini API (`@google/generative-ai`)
- **Auth:** Firebase Authentication

## Structure
```
/                        → Frontend (React/TypeScript/Vite)
├── components/          → React components (~50 files)
├── hooks/               → Custom React Hooks
├── context/             → AuthContext, InventoryContext
├── utils/               → Frontend utilities
├── api/client.ts        → API client (fetch wrapper)
├── types.ts             → TypeScript definitions
├── i18n.tsx             → i18n (DE/EN/TR)
├── App.tsx              → Main routing & state
│
├── backend/             → Backend (Node.js/Express)
│   ├── index.js         → Express server entry
│   ├── routes/          → 7 router modules (products, orders, warehouse, identify, marketplace, admin, auth)
│   ├── lib/             → 81+ utility modules
│   ├── services/        → 29+ service modules
│   ├── __tests__/       → Vitest tests (119+ tests, 7+ suites)
│   └── cloudbuild.yaml  → Cloud Build deployment
│
├── Dockerfile           → Cloud Run container
├── firebase.json        → Firebase Hosting config
└── .github/workflows/   → GitHub Actions (Frontend CI/CD)
```

## Key Constraints
- **BaseLinker is FORBIDDEN** — AvyCloud has native integrations. No new code may reference BaseLinker.
- **Production safety is non-negotiable** — no breaking changes, no data loss, no downtime.
- **TASKS.md is the single source of truth** for all tasks and sprint instructions.
