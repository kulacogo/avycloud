# Suggested Commands

## Testing
```bash
cd backend && npm test          # Run all Vitest tests
```

## Build
```bash
npm run build                   # Frontend build (Vite)
npm run dev                     # Frontend dev server
```

## Backend Development
```bash
cd backend && node index.js     # Start backend locally
```

## Deployment
- **Frontend:** Push to `main` → GitHub Actions → Firebase Hosting
- **Backend:** Push to `main` → Cloud Build → Docker → Cloud Run

## System Utils (macOS/Darwin)
```bash
git status / git diff / git log
ls -la
find . -name "*.js" -path "*/backend/*"
grep -r "pattern" --include="*.js" backend/
```

## Linting/Formatting
No dedicated linter configured in project. Follow conventions from style_and_conventions memory.
