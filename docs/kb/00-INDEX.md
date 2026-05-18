---
title: AvyCloud Knowledge Base — Master Index
for: [user, dev, agent, admin, manager]
lastReviewed: 2026-05-18
---

# AvyCloud Knowledge Base

> **Single Source of Truth.** Diese KB ist die offizielle Wahrheit über AvyCloud — wie es funktioniert, wie man entwickelt, wie man deployt, was die Regeln sind, was wir haben, was fehlt.
> Wenn etwas hier dokumentiert ist, ist es **maßgeblich**. Wenn etwas hier nicht steht, wird es entweder ergänzt oder es existiert nicht offiziell.

## Schneller Einstieg nach Persona

| Persona | Start hier |
|---------|-----------|
| **User** (Endanwender im UI) | [13-personas/for-users.md](13-personas/for-users.md) |
| **Developer** (Code-Beitrag) | [13-personas/for-developers.md](13-personas/for-developers.md) |
| **Coding-Agent** (AI Pair-Programmer) | [13-personas/for-coding-agents.md](13-personas/for-coding-agents.md) — **MUSS gelesen werden** |
| **Admin** (Operator, Bulk-Aktionen, Support) | [13-personas/for-admins.md](13-personas/for-admins.md) |
| **Manager** (Strategie, Roadmap, Metriken) | [13-personas/for-managers.md](13-personas/for-managers.md) |

## Sektionen

| # | Bereich | Was darin steht |
|---|---------|-----------------|
| 01 | [Overview](01-overview/) | Was ist AvyCloud, Glossar, Personas |
| 02 | [Architecture](02-architecture/) | System, Frontend, Backend, Daten, Auth, Multi-Tenancy, Eventing, ADRs |
| 03 | [Development](03-development/) | Setup, Code-Style, Tests, Commit-Workflow, Feature-Flags, Debugging |
| 04 | [Deployment](04-deployment/) | Frontend & Backend Deploy, CI/CD, Rollback, ENV-Vars |
| 05 | [Pages](05-pages/) | Eine Doku pro UI-View (Dashboard, Inventory, Orders, ...) |
| 06 | [Features](06-features/) | Eine Doku pro Feature (Identify, Chat, Pricing, Rule-Engine, ...) |
| 07 | [LLM](07-llm/) | Modelle, Pipelines, Tools, Caching, Telemetrie, Kosten |
| 08 | [Integrations](08-integrations/) | eBay, Kaufland, SendCloud, SevDesk, Firebase, Gemini, ... |
| 09 | [API](09-api/) | Eine Doku pro Backend-Route-File mit allen Endpoints |
| 10 | [Data](10-data/) | Firestore-Collections, Schemas, Indexes |
| 11 | [Rules & Invariants](11-rules-and-invariants/) | Die nicht-verhandelbaren Regeln (Mirror von CLAUDE.md) |
| 12 | [Runbooks](12-runbooks/) | Incident-Response und operative Anleitungen |
| 13 | [Personas](13-personas/) | Einstiegspunkte pro Zielgruppe |
| 14 | [FAQ](14-faq.md) | Häufige Fragen |
| 15 | [Gap Analysis](15-gap-analysis.md) | Was AvyCloud HAT vs was FEHLT |
| 16 | [Changelog](16-changelog.md) | Was sich in der KB geändert hat |
| 17 | [Cleanup Report](17-cleanup-report.md) | Was im System ZU VIEL ist und weg kann |

## Wenn du etwas suchst

1. **Coding-Agent / Developer**: Suche zuerst in `11-rules-and-invariants/` und `02-architecture/`.
2. **Eine bestimmte UI-Seite**: `05-pages/<view-name>.md`.
3. **Ein bestimmter API-Endpunkt**: `09-api/<route-file>.md`.
4. **Eine bestimmte Feature**: `06-features/<feature>.md`.
5. **Ein bestimmter Fehler oder Incident**: `12-runbooks/`.

## Wenn du etwas Neues hinzufügst

Jede neue Route, Page, Feature, Integration oder Collection braucht einen KB-Eintrag. Der CI-Check ([backend/scripts/audit-kb-coverage.js](../../backend/scripts/audit-kb-coverage.js)) prüft das automatisch.

Template-Hinweis: schau in die Nachbar-Datei und kopiere die Struktur. Wir haben absichtlich keine starren Templates — Konsistenz durch Beispiel.

## KB-Konventionen

- **Sprache**: Deutsch für User-/Manager-Inhalte, Englisch für tieftechnische API/Code-Referenzen wenn Codebezeichner ohnehin englisch sind. Mischen ist OK, Konsistenz innerhalb einer Datei nicht.
- **Dateipfade IMMER als Markdown-Link**: `[backend/lib/foo.js](../../backend/lib/foo.js)`.
- **Frontmatter Pflicht**: `title`, `for: [persona, ...]`, `lastReviewed: YYYY-MM-DD`.
- **Code-Beispiele**: Sprache im Codeblock annotieren.
- **Mermaid für Diagramme**: keine harten Farben (Theme-broken im Dark-Mode).

---

**Letzte KB-Review:** 2026-05-18.
**Verantwortlich für Pflege:** Engineering-Team. Drift-Schutz via CI.
