---
title: AvyCloud FAQ
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

# FAQ

## Allgemein

**Was ist AvyCloud?**
Multi-Channel-E-Commerce-Plattform für KMU im DACH-Raum. Siehe [01-overview/what-is-avycloud.md](01-overview/what-is-avycloud.md).

**Welche Marktplätze werden unterstützt?**
Aktuell eBay und Kaufland. Amazon und OTTO sind geplant.

**Wie kommt ein Produkt in AvyCloud?**
Über die **Erfassen**-Funktion: Bilder hochladen → KI erkennt Produkt → Daten werden vorgeschlagen → speichern.

## Für Developer

**Wo finde ich die API-Doku?**
[09-api/](09-api/) — eine Datei pro Backend-Route.

**Wie führe ich Tests aus?**
`cd backend && npm test`

**Wo sind die nicht-verhandelbaren Regeln?**
[11-rules-and-invariants/README.md](11-rules-and-invariants/README.md) (Mirror von CLAUDE.md).

## Für Admins

**Wie schalte ich Multi-Tenant ein?**
ENV-Var `BACKGROUND_JOB_TENANTS=trendocean,avycloud` setzen. Siehe [04-deployment/env-vars.md](04-deployment/env-vars.md).

**Wie reparieren wir Double-Decrement-Incidents?**
`node backend/scripts/repair-double-decrement.js` (read-only audit), dann `--apply` mit Operator-Bestätigung. Siehe [12-runbooks/](12-runbooks/).

## Für Coding-Agents

**Darf ich Firestore-Felder umbenennen?**
**NEIN.** Additive only. Punkt 2 in [11-rules-and-invariants/README.md](11-rules-and-invariants/README.md).

**Darf ich retired middleware neu einbauen?**
**NEIN.** Tabu. Punkt 9.

**Wie commit ich richtig?**
Conventional Commits (`feat:`, `fix:`, `refactor:`). Nie Force-Push auf `main`. Coding-Agents committen nur wenn User explizit `commit` sagt.
