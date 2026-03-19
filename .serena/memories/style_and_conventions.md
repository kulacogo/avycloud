# Code Style & Conventions

## Backend (Node.js)
- **Module system:** CommonJS (`require`/`module.exports`)
- **Language:** JavaScript (not TypeScript)
- **Indentation:** 2 spaces
- **Quotes:** Single quotes
- **Async:** `async/await` preferred, no callbacks
- **Error handling:** Every endpoint needs try/catch with structured error response:
  ```js
  try {
    // logic
  } catch (err) {
    console.error(`[POST /api/example] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
  ```

## Frontend (React)
- **Language:** TypeScript
- **Module system:** ES Modules
- **Components:** React Functional Components + Hooks
- **Indentation:** 2 spaces
- **Quotes:** Double quotes
- **Styling:** Tailwind CSS with custom design tokens (CSS variables)
- **Colors:** Always use CSS variables/Tailwind tokens (`bg-accent`), NEVER hardcoded values (`bg-blue-500`)
- **Dark Mode is default**, Light Mode via `[data-theme='light']`

## Git
- Branch naming: `feat/`, `fix/`, `refactor/`, `chore/`
- Conventional Commits: `feat:`, `fix:`, `refactor:`, `chore:`, `test:`
- No force-push on `main`

## Safety Rules (NON-NEGOTIABLE)
- No existing route changes without explicit instruction
- No Firestore collection structure changes (additive fields only)
- No dependency removals
- No env var renames referenced in cloudbuild.yaml or GitHub Actions
- No changes to Dockerfile, firebase.json, .firebaserc, cloudbuild.yaml without instruction
- No auth middleware changes without instruction
- Every new function needs at least 1 test
