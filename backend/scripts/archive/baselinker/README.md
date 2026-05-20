# BaseLinker Scripts — ARCHIV (Stand 2026-05-18)

> **Diese Scripts sind archiviert. DO NOT RUN.**
>
> CLAUDE.md Regel #9: **BaseLinker ist TABU** — keine neuen Referenzen, Imports oder ENV-Vars.
>
> Diese 24 Scripts stammen aus der BaseLinker-Era (Pre-2026-03). Sie wurden hierher
> verschoben um sie aus den aktiven `backend/scripts/`-Pfaden zu entfernen, ohne sie
> komplett zu löschen — für den seltenen Fall dass historische Daten-Surgery nötig wird.
>
> **Vor jedem Lauf:**
> 1. Operator-Approval einholen (Engineering Lead / Founder)
> 2. Verify dass keine aktiven Pfade die Scripts importieren (`rg "baselinker" backend/{routes,services,lib}/`)
> 3. `--dry-run` zuerst, immer
> 4. Production-Daten sichern (Firestore-Export)
>
> Wenn das Script länger als 30 Tage nicht gebraucht wurde, kann es gelöscht werden.

## Inhalt

24 Scripts (siehe `ls`).

## Kontext / Audit

Siehe [docs/kb/17-cleanup-report.md](../../../../docs/kb/17-cleanup-report.md) Sektion 1.2 und
[backend/scripts/audit-repo-cruft.js](../audit-repo-cruft.js) (BaseLinker-Erkennung).
