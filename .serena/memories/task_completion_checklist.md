# Task Completion Checklist

Before completing any task, verify:

1. [ ] Existing routes unchanged (unless explicitly instructed)
2. [ ] No Firestore fields renamed/removed
3. [ ] No dependencies removed
4. [ ] New functions have try/catch with structured errors
5. [ ] New functions have at least 1 test
6. [ ] `cd backend && npm test` passes
7. [ ] `npm run build` (frontend) succeeds if frontend was changed
8. [ ] No secrets/keys hardcoded
9. [ ] No BaseLinker references added
10. [ ] Both Dark and Light mode work for UI changes
