# AGENT_RULES.md — AvyCloud Coding Agent Constitution

> **Version:** 1.0 | **Last Updated:** 2026-03-19
> **Status:** ACTIVE — Compliance is MANDATORY for all coding agents.

---

## 🛡️ THE GOLDEN RULE

```
DIE APP IN PRODUCTION DARF NIEMALS NEGATIV BEEINFLUSST WERDEN.
```

**No breaking changes. No data loss. No downtime. Zero regression.**

AvyCloud is running in production for TrendOcean. Real customers use it daily for real orders, real shipments, real revenue. Every line of code you write has the potential to impact a live business.

**If you are unsure whether a change is safe: STOP and ASK.**

---

## 1. Session Protocol

Every agent MUST follow this sequence at the start of every task:

```
1. Read CLAUDE.md                    → Project rules, architecture, safety constraints
2. Read this file (AGENT_RULES.md)   → Agent governance, behavioral rules, checklists
3. Read TASKS.md                     → Current priorities, open tasks, sprint context
4. Read the feature spec             → docs/features/<ID>/spec.md for your assigned task
5. Run the test suite                → cd backend && npm test (verify green baseline)
6. Run frontend build                → npm run build (verify clean baseline)
7. THEN — and only then — begin work
```

**If any baseline check fails (tests red, build broken), STOP. Do not begin work on a broken baseline. Report the failure.**

---

## 2. Change Classification System

Every change is classified into one of four risk levels. The level determines what verification is required.

### Level Definitions

| Level | Name | Description | Verification Required |
|-------|------|-------------|-----------------------|
| **L0** | Safe | Additive-only, zero impact on existing behavior | Automated checks only |
| **L1** | Low Risk | Changes to non-critical paths with test coverage | Automated checks + self-review |
| **L2** | Medium Risk | Changes to shared code, APIs, or data paths | Automated checks + human review |
| **L3** | Critical | Changes to auth, data integrity, infra, external APIs | Human review + staging verification + explicit approval |

### Auto-Classification Rules

Determine the level by checking these heuristics **in order** (highest match wins):

**L3 — Critical (STOP and get human approval):**
- ANY change to files in the Red Zone (see §3)
- ANY change to route signatures in `backend/routes/*.js`
- ANY change to Firestore collection structure (renames, deletions)
- ANY change to external API integrations (eBay, Kaufland, SendCloud, SevDesk, Gemini)
- ANY change to `package.json` dependencies (additions OR removals)
- ANY change to deployment config (`Dockerfile`, `cloudbuild.yaml`, `firebase.json`, `.firebaserc`)
- ANY change to environment variable names referenced in CI/CD
- ANY database migration or schema change

**L2 — Medium Risk (flag for human review):**
- Modifying existing backend service logic (`backend/services/*.js`)
- Modifying existing library functions (`backend/lib/*.js`)
- Changing API response shapes (even backward-compatible)
- Changes touching >10 files
- Changes to frontend routing (`App.tsx` routes)
- Modifying shared React context providers (`context/*.tsx`)

**L1 — Low Risk (self-review sufficient):**
- Bug fixes in isolated modules with existing test coverage
- UI text changes, styling adjustments
- Adding new optional fields to existing Firestore documents
- Changes touching 2–10 files
- Modifying individual React components (non-routing, non-context)

**L0 — Safe (automated checks only):**
- New files (tests, utilities, components) that nothing imports yet
- Documentation changes
- Adding comments or type annotations
- Changes touching 1 file that is not in Red or Yellow zone

---

## 3. Protected Zones

### 🔴 Red Zone — NEVER MODIFY without explicit human instruction

These files are production-critical infrastructure. An agent must NEVER change them unless the human explicitly instructs it for that specific file.

```
# Deployment & Infrastructure
Dockerfile
cloudbuild.yaml
firebase.json
.firebaserc
.github/workflows/*

# Authentication & Authorization
backend/lib/auth.js
backend/lib/rbac.js

# Server Entry & Routing Registration
backend/index.js                    (require paths only — adding new routes is Yellow)

# CI/CD Secrets & Environment
.env*
cloudbuild.yaml substitutions
```

### 🟡 Yellow Zone — MODIFY WITH CAUTION (human review required)

These files are shared, high-impact modules. Changes are allowed but require human review before merge.

```
# API Routes (live endpoints)
backend/routes/*.js

# Core Data Layer
backend/lib/firestore.js
backend/lib/product-store.js
backend/lib/product-canonical.js
backend/lib/product-schema.js

# External API Integrations
backend/lib/ebay-*.js
backend/lib/kaufland-*.js
backend/lib/sendcloud.js
backend/lib/sevdesk.js
backend/lib/gemini*.js

# Business-Critical Services
backend/services/order-state-machine.js
backend/services/order-intake-ebay.js
backend/services/order-intake-kaufland.js
backend/services/shipping-engine.js
backend/services/returns-engine.js
backend/services/sync-event-bus.js
backend/services/marketplace-tracking.js

# Job Runners
backend/services/job-runner.js
backend/services/improve-runner.js
backend/services/quality-runner.js
backend/services/rulebook-runner.js
backend/services/admin-bulk-runner.js

# LLM Pipeline
backend/lib/llm-policy-pack.js
backend/lib/llm-rulebook.js

# Frontend Core
App.tsx                            (routing changes)
context/AuthContext.tsx
context/InventoryContext.tsx
api/client.ts
```

### 🟢 Green Zone — SAFE TO MODIFY (automated checks sufficient)

```
# New files (nothing imports them yet)
# Test files (*.test.js, *.test.ts, __tests__/*)
# Frontend components (components/*.tsx — non-routing)
# Frontend hooks (hooks/*.ts — non-auth)
# Frontend utilities (utils/*.ts)
# Styling (styles/*.css, tailwind.config.cjs)
# Documentation (docs/*, *.md)
# Backend utilities that are not in Yellow Zone
# i18n translations (i18n.tsx — additive keys only)
```

---

## 4. Behavioral Commandments

### The Five Commandments

1. **Conservative by Default**
   When uncertain, do less, not more. A change that does nothing is better than a change that breaks production. If two approaches exist — one safe and slow, one fast and risky — choose safe.

2. **Evidence Before Action**
   Never propose a fix without first proving the problem exists. Read the code. Trace the data flow. Reproduce the issue. Understand the root cause. THEN fix it.

3. **Additive Over Destructive**
   Prefer adding new code over modifying existing code. Never delete working code without explicit instruction. New functions > modified functions > deleted functions.

4. **Escalate Uncertainty**
   If your confidence in a change is below 80%, STOP and ask the human. Say "I'm not sure about X because Y" — this is strength, not weakness. Guessing is forbidden.

5. **Atomic Changes**
   Each change does ONE thing. One commit = one logical change. No "while I'm here" improvements. No scope creep. If you notice something unrelated that needs fixing, note it and move on.

### Forbidden Anti-Patterns

These are EXPLICITLY BANNED. If you catch yourself doing any of these, STOP immediately.

| Anti-Pattern | Description | Why It's Banned |
|-------------|-------------|-----------------|
| **Shotgun Debugging** | Making multiple speculative changes hoping one works | Creates new bugs, obscures root cause |
| **Blind Fixing** | Proposing a fix without reading the relevant code first | Symptom fixes mask real problems |
| **Test Deletion** | Removing or disabling tests that fail instead of fixing code | Destroys the safety net |
| **Scope Creep** | "I also noticed X, so I fixed it" beyond the assigned task | Unreviewed changes in production code |
| **Dependency Cowboy** | Adding npm packages without justification | Supply chain risk, bundle bloat |
| **Secret Sprawl** | Logging, hardcoding, or exposing credentials/tokens | Security breach risk |
| **Speculative Refactoring** | Refactoring code that works "because it could be better" | Risk without benefit |
| **Force Operations** | `git push --force`, `git reset --hard`, `--no-verify` | Destroys history, bypasses safety |
| **Silent Failures** | Catching errors without logging or re-throwing | Hides production issues |
| **Circular Testing** | Writing tests that only verify your own generated code logic | False confidence — test must verify business requirements |

### Required Behaviors

- **Read before write.** Always read every file you plan to modify. Understand the context.
- **Test before AND after.** Run the full test suite before starting AND after every change.
- **One thing at a time.** Make a change, verify it works, then move to the next change.
- **Explain your reasoning.** Before implementing, state what you plan to do and why.
- **Use existing patterns.** Follow the codebase's established patterns. Don't invent new ones.
- **Preserve backwards compatibility.** New fields: OK. Changed fields: CAUTION. Removed fields: FORBIDDEN.
- **Log meaningfully.** New endpoints need structured error logging with context.

---

## 5. Pre-Flight Checklist

**BEFORE making any code changes, verify ALL of the following:**

```
□ I have read the feature spec (docs/features/<ID>/spec.md)
□ I have read ALL files I plan to modify
□ I have identified the Change Level (L0/L1/L2/L3)
□ I have mapped the blast radius (what depends on the files I'll change?)
□ I have verified the test baseline is green (cd backend && npm test)
□ I have verified the frontend build is clean (npm run build)
□ I have confirmed my changes do NOT touch Red Zone files (unless explicitly instructed)
□ I have confirmed the approach aligns with CLAUDE.md rules
□ For L2+: I have flagged this for human review BEFORE implementing
□ For L3: I have received explicit human approval BEFORE implementing
```

---

## 6. Post-Flight Checklist

**AFTER making code changes, verify ALL of the following:**

```
□ All existing tests still pass (cd backend && npm test)
□ Frontend builds without errors (npm run build)
□ No new linting warnings or errors introduced
□ Test coverage has not decreased
□ New functions/endpoints have at least 1 test
□ New endpoints have try/catch with structured error responses
□ No hardcoded secrets, keys, or tokens in the code
□ No console.log() left in production code (use structured logging)
□ Firestore queries include tenantId filter (multi-tenancy requirement)
□ Changes follow code style (Backend: CJS, 2 spaces, single quotes / Frontend: TS, ESM, 2 spaces, double quotes)
□ Git commit message follows conventional commits (feat:, fix:, refactor:, etc.)
□ Changes are on a feature branch, NOT directly on main
```

---

## 7. Testing Requirements by Change Level

| Level | Existing Tests | New Unit Tests | Integration Tests | Manual Verification |
|-------|---------------|----------------|-------------------|-------------------|
| **L0** | Must pass ✅ | Not required | Not required | Not required |
| **L1** | Must pass ✅ | Required for new code ✅ | Not required | Not required |
| **L2** | Must pass ✅ | Required ✅ | Required for affected paths ✅ | Recommended |
| **L3** | Must pass ✅ | Required ✅ | Required ✅ | **MANDATORY** ✅ |

### Test Infrastructure Reference

```
# Backend tests (Vitest)
cd backend && npm test

# Frontend build verification
npm run build

# Test file locations
backend/__tests__/              → API integration tests
backend/services/*.test.js      → Service unit tests
backend/lib/*.test.js           → Library unit tests

# Test mocking pattern (CJS + Vitest 4.x)
# See: backend/__tests__/api/_patchGcp.js, _patchLocalModules.js, _setupMocks.js
# IMPORTANT: vi.mock() does NOT intercept CJS require() — use require.cache patching
```

### Writing New Tests — Rules

1. Tests MUST verify business requirements, not just code paths
2. Tests MUST include at least one negative case (invalid input, error condition)
3. Tests MUST NOT mock the module under test — only mock its dependencies
4. Tests MUST be deterministic — no timing-dependent assertions, no random data
5. Existing tests MUST NOT be deleted or disabled — ever
6. If a test fails after your change, the code is wrong, not the test

---

## 8. Agent Contracts

Every task an agent executes has an implicit contract with three parts:

### Preconditions (MUST be true before starting)

```
- Feature spec exists and has been read
- All files to be modified have been read and understood
- Test suite passes (green baseline)
- Frontend build succeeds (clean baseline)
- Change level has been determined
- Required approvals obtained (for L2+)
```

### Path Conditions (MUST be followed during execution)

```
- Work on a feature branch (never main directly)
- Make atomic commits (one logical change per commit)
- Run tests after each significant change
- Stay within the scope defined in the feature spec
- Follow code style and patterns established in the codebase
- Log progress and flag any surprises or blockers
```

### Postconditions (MUST be true after completion)

```
- All existing tests still pass
- Frontend build still succeeds
- New code has test coverage
- No Red Zone files modified (unless explicitly approved)
- No new security vulnerabilities introduced
- Changes are documented in commit messages
- Feature spec status updated
```

**If any postcondition fails, the task is NOT complete.** Fix the issue or escalate.

---

## 9. Concurrent Agent Coordination

When multiple agents work on the codebase simultaneously:

### Isolation Rules

1. **Git Worktrees**: Each agent MUST work in an isolated git worktree, not the main working directory
2. **Domain Isolation**: Agents are assigned to feature domains. Do NOT modify files outside your assigned domain unless the spec explicitly requires it
3. **No Shared State**: Agents must not assume another agent's changes exist. Work from the current `main` branch
4. **Sequential Integration**: Feature branches merge into `main` one at a time, not simultaneously

### Conflict Prevention

1. **Claim files**: Before modifying a file, check if another agent's feature spec also targets it
2. **Minimal footprint**: Touch as few files as possible. Smaller changes = fewer conflicts
3. **Feature flags**: For large features, use additive code behind conditions rather than modifying shared paths
4. **Communication**: If your spec requires modifying a file that another active agent also needs, escalate to the human for coordination

---

## 10. Communication Protocol

### Before Starting

```
"I'm starting work on [FEATURE-ID].
My plan is to modify these files: [list].
Change level: [L0/L1/L2/L3].
Blast radius: [what depends on these files].
I'll begin with [first step]."
```

### During Work

Flag immediately when you encounter:
- A file in Yellow/Red zone that you didn't expect to need
- A dependency you didn't anticipate
- Existing code that seems broken or inconsistent
- Test failures you can't explain
- Any deviation from the spec

### After Completion

```
"Completed [FEATURE-ID].
Changes: [summary of what was done]
Files modified: [list]
Tests: [pass/fail, new tests added]
Build: [pass/fail]
Risks identified: [any concerns]
```

### Escalation Triggers — STOP and ask the human

- Confidence below 80% on any change
- Need to modify a Red Zone file
- Test failures after your change that you can't resolve in 2 attempts
- Spec is ambiguous or contradictory
- Change scope is larger than expected
- You discover a pre-existing bug unrelated to your task

---

## 11. Rollback & Recovery

### Git Workflow

```
1. Always work on a feature branch: feat/<feature-id>-<short-name>
2. Atomic commits with conventional commit messages
3. Never force-push. Never amend published commits.
4. PR-based integration into main
5. Squash-merge for clean history
```

### Circuit Breakers — Auto-halt conditions

**STOP working and escalate to the human if:**

- Your changes cause test failures on **3 consecutive attempts**
- You've been working on the same issue for **>1 hour** without progress
- You need to modify **>20 files** for what was supposed to be a small change
- The fix for one problem creates a **new problem** in a different area
- You find yourself wanting to **disable a test** to make things pass

### Incident Response (if agent-introduced bug reaches production)

```
1. DETECT   → Tests fail, error rates spike, user reports issue
2. CONTAIN  → Revert the specific commit immediately
3. DIAGNOSE → Review the agent's changes, reasoning, and test gaps
4. FIX      → Proper fix on a new branch with additional tests
5. PREVENT  → Add the failure pattern to this document
6. DOCUMENT → Record in TASKS.md for future reference
```

---

## 12. AvyCloud-Specific Rules

These rules are specific to the AvyCloud codebase and supplement the general rules above.

### Firestore — Data Layer Rules

```
✅ DO:
- Use saveProductV2() for all product writes (backend/lib/product-store.js)
- Include tenantId in all new collections/queries
- Add new fields to existing documents (additive only)
- Use normalizeProduct() for canonical data format

❌ DO NOT:
- Rename or delete existing Firestore fields
- Change collection names
- Create new collections without multi-tenancy support
- Write directly to Firestore bypassing product-store.js for products
```

### Active Collection: `products_v2`

The canonical product collection is `products_v2` with `USE_PRODUCTS_V2=true`. All product operations go through the `product-store.js` abstraction layer. Do not bypass it.

### BaseLinker — ABSOLUTE PROHIBITION

```
⛔ BaseLinker is COMPLETELY REMOVED from AvyCloud.
- No new code may reference BaseLinker
- No imports of baselinker-* modules
- No BaseLinker ENV vars
- No BaseLinker API calls
- If you find BaseLinker references in existing code, note them but do NOT fix them
  unless that is your assigned task
```

### Backend Code Style

```javascript
// CommonJS modules
const express = require('express');
const router = express.Router();

// Async/await, structured errors
router.post('/api/v1/example', async (req, res) => {
  try {
    // logic
  } catch (err) {
    console.error(`[POST /api/v1/example] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

module.exports = router;
```

### Frontend Code Style

```typescript
// ES Modules, TypeScript, React Functional Components
import React, { useState, useEffect } from "react";

// Double quotes, 2 spaces, Tailwind design tokens
const MyComponent: React.FC<Props> = ({ data }) => {
  return (
    <div className="bg-app-surface text-txt-primary rounded-md p-4">
      {/* Use design tokens, never hardcoded colors */}
    </div>
  );
};
```

### Design System Compliance

All frontend changes MUST use the AvyCloud design tokens:
- Colors: `bg-accent`, `text-txt-primary`, `bg-app-surface` — NEVER raw Tailwind colors like `bg-blue-500`
- Radii: `rounded-sm` (6px), `rounded-md` (8px), `rounded-lg` (12px)
- Both Dark Mode AND Light Mode must work
- See `styles/main.css` for all CSS custom properties
- See `tailwind.config.cjs` for Tailwind token mapping
- See `CLAUDE.md` Brand & Design System section for full reference

### Multi-Tenancy Requirement

All new code MUST support multi-tenancy:

```
✅ saveProductV2({ tenantId, ...data })
✅ db.collection('products_v2').where('tenantId', '==', tenantId)
✅ GCS paths: gs://prodsandjobs/{tenantId}/...
❌ Global queries without tenantId filter
❌ Hardcoded 'default' tenantId (except as documented fallback)
```

---

## 13. Confidence Scoring & Decision Guide

When deciding whether to proceed or escalate:

| Confidence | Action |
|------------|--------|
| **90–100%** | Proceed. Standard verification. |
| **70–89%** | Proceed with extra caution. Add additional tests. Flag in PR description. |
| **50–69%** | PAUSE. Explain your uncertainty to the human. Propose options. Wait for guidance. |
| **Below 50%** | STOP. Do not write code. Explain what you don't understand. Ask for help. |

### Confidence Reducers (things that should lower your confidence)

- You haven't seen this pattern before in the codebase
- The change affects multiple interconnected modules
- You're not sure about the data flow
- The spec is ambiguous about edge cases
- You're changing a file you haven't fully read
- The change interacts with an external API you're not familiar with

### Confidence Boosters (things that raise confidence)

- You've read all relevant files and understand the data flow
- There's an existing pattern in the codebase you're following
- The change is additive (new file, new function, new field)
- Comprehensive test coverage exists for the affected area
- The spec is detailed and unambiguous

---

## 14. Quick Reference Card

```
┌─────────────────────────────────────────────────────────────┐
│                    AGENT QUICK REFERENCE                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  BEFORE CODING:                                              │
│  1. Read spec → 2. Read files → 3. Check tests → 4. Plan    │
│                                                              │
│  DURING CODING:                                              │
│  • Feature branch only (never main)                          │
│  • One change at a time                                      │
│  • Test after each change                                    │
│  • Stay in scope                                             │
│                                                              │
│  AFTER CODING:                                               │
│  • All tests pass? → Build clean? → Coverage ok? → PR        │
│                                                              │
│  STOP IF:                                                    │
│  • Red Zone file needs changing                              │
│  • 3+ failed attempts                                        │
│  • Confidence < 50%                                          │
│  • Scope expanding beyond spec                               │
│  • Creating problems in other areas                          │
│                                                              │
│  NEVER:                                                      │
│  • Touch auth/deployment without approval                    │
│  • Delete tests                                              │
│  • Force-push                                                │
│  • Skip the test suite                                       │
│  • Reference BaseLinker                                      │
│  • Hardcode secrets                                          │
│  • Commit to main directly                                   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Document History

| Date | Version | Changes |
|------|---------|---------|
| 2026-03-19 | 1.0 | Initial version — full agent governance framework |
