# Erfassen-Modul: Datenblatt-Format-Parität

**Datum:** 2026-06-24
**Status:** Design (Implementierung folgt)
**Owner:** kulacogo
**Branch:** `fix-ebay-deactivation-confirm` (eigener Feature-Branch wird angelegt)

## Problem

Das im **Erfassen**-Modul (Identify-Pipeline) generierte Produktdatenblatt entspricht nicht der erwarteten, im System gelebten Form. Konkret:

- Die **Beschreibung** wird als Mischung aus Einleitungsabsatz + Bullet-Liste + Abschlussabsatz erzeugt, statt als **Fließtext**.
- Die übrigen Datenblatt-Felder (Highlights, Attribute) bleiben hinter der Qualität zurück, die der Chat-Assistent liefert.

Der erwartete Standard ist **glasklar definiert und gelebt**: Produkte, die über den Chat-Assistenten oder von Hand entstehen, haben Beschreibung = Fließtext, Highlights = Bullets, Attribute mit echten Werten — und werden so problemlos veröffentlicht. **Nur das Erfassen-Modul weicht ab.** Es gibt keine offene Design-Entscheidung; das Erfassen-Modul muss an den bestehenden Standard angeglichen werden. Publish- und Frontend-Pfad bleiben unangetastet.

## Root Cause (verifiziert durch 17-Agenten-Analyse)

Das Bullet-Format ist ein **Generierungs- + Post-Processing-Artefakt**, kein Rendering-Problem.

1. **Post-Processing (entscheidend):** `sanitizeDescriptionToHtml()` (`backend/lib/listing-sanitize.js:118-204`), aufgerufen in `backend/lib/identify-v3-stage3.js:191-204`, strippt jegliches HTML, zerlegt den Text in Sätze und baut ihn **deterministisch** neu zusammen: erste 2 Sätze → `<p>`, weitere Sätze ≥24 Zeichen → `<ul><li>` (max 6), Rest → `<p>`. Egal was das Modell schreibt — die Beschreibung wird zwangsweise bulletisiert.
2. **Generierung:** Prompts/Schemas bestellen aktiv eine gemischte HTML-Struktur:
   - Agentic Write-Tool (Live-Default): `'eBay HTML description, 180-240 words, <p>+<ul>+<li>+<strong>'` (`backend/lib/identify-v3-stage3-agentic.js:121-124`)
   - Single-Shot: `'... <ul> mit 5-7 Benefits ...'` (`backend/lib/gemini3-client.js:671`, weitere bei :774, :944)

Zum Vergleich: Der Chat-Assistent (Gold-Standard) speichert seinen Text **wortwörtlich** ohne Re-Sanitizing (`backend/lib/apply-chat-changes.js:95`). Darum bleibt Chat-Prosa Prosa.

**Live-Pfad:** Identify V3 Stage-3, agentic Generator (`STAGE3_AGENTIC=true`). V4 ist dark-deployed (0 % Traffic). Das Frontend (`components/ProductSheet.tsx`) rendert nur den gespeicherten String via DOMPurify — keine Bullet-Logik, kein Markdown-Split. **Frontend bleibt unverändert.**

## Felder & Datenmodell (bereits korrekte Form)

- `details.short_description` = **String** (HTML) → die Beschreibung. Bullets leben heute *innerhalb* dieses Strings — das ist das Problem.
- `details.key_features` = **Array<String>** → die Highlights. Wird im Frontend bereits als `<ul><li>` gerendert (`ProductSheet.tsx:1506-1508`).

Das Zielmodell ist also bereits die richtige Feld-Form. Die Bullets müssen nur **aus `short_description` raus** und allein über `key_features` getragen werden. Keine Feld-Umbenennung, keine Schema-Migration.

## Lösung

### A — Beschreibung wird Fließtext (Kern)

1. **Prosa-erhaltender Sanitizer.** Neuer Modus in `backend/lib/listing-sanitize.js`, z. B. `sanitizeDescriptionProse(text, opts)`:
   - Erlaubte Tags: `<p>`, `<strong>`, `<em>`, `<br>`. **Keine** `<ul>/<ol>/<li>`-Erzeugung.
   - Behält die Absatzstruktur des Modells. Falls das Modell wider Erwarten eine Liste liefert, werden Listen-Items zu Absatz-Text geglättet (kein Datenverlust, aber keine Bullets).
   - Behält die Sicherheits-/Längen-Garantien der bestehenden Funktion (Escape, maxLen).
   - Die bestehende `sanitizeDescriptionToHtml()` bleibt erhalten für Caller, die echte Bullets brauchen (keine Breaking Change).
2. **Aufruf umstellen.** In `backend/lib/identify-v3-stage3.js:191-204` `sanitizeDescriptionToHtml` → `sanitizeDescriptionProse` für `description_ebay` und `description_kaufland`.
3. **Prompts/Schemas auf Prosa.** Beschreibungs-Feld-Beschreibungen umformulieren auf "2–3 `<p>`-Absätze Fließtext, KEINE Aufzählung":
   - `backend/lib/identify-v3-stage3-agentic.js:121-124, :250`
   - `backend/lib/gemini3-client.js:671, :774, :944` (das CONTENT_SCHEMA-Feld bei :944 und das agentic Write-Tool sind die wirkungsstärksten Schema-Beschreibungen)

### B — Highlights bleiben Bullets + Bugfix

Format unverändert (Array). Aber die Qualitäts-Policy (Dash-Template "Nutzen – Spec", Längen, Dedup) läuft heute **nie**, weil `backend/lib/identify-v3-stage3.js:213-216` `Array.isArray(normalized)` prüft, während `normalizeHighlightsStrict()` ein **Objekt** `{ ok, highlights, ... }` zurückgibt (`backend/lib/highlights-policy.js:148-154`) → immer `false` → rohe Modell-Bullets gehen ungeprüft durch.

Fix: `const { highlights } = normalizeHighlightsStrict(...); if (Array.isArray(highlights) && highlights.length) result.key_features = highlights;`

### C — Attribute erreichen erwartete Qualität

Identify stopft heute für jedes unaufgelöste Pflicht-Aspekt ein wörtliches `'Unbekannt'` rein (`identify-v3-stage3.js:404-408`), und `pickLikeliestFallback` rät teils den ersten Enum-Wert (`:462-463`).

- `pickLikeliestFallback`: für ein Pflicht-Aspekt ohne belastbaren generischen Enum **`'Unbekannt'`** zurückgeben statt eines erfundenen ersten Enum-Werts (nie plausibel-aber-falsch).
- `confidence: 0` sauber bis zur UI durchreichen (Map `item_specifics_confidence`, gesetzt in `services/identify-v3.js`).
- Frontend Attribute-Tab: confidence-0-/„Unbekannt"-Zeilen ausgrauen bzw. nicht als vollwertig zeigen (eigener kleiner UI-Schritt; eBay-Sichtbarkeit/Cassini-Backfill bleibt erhalten, aber visuell entwertet).

### D — Doc/Code-Drift bereinigen

Aspect-Repair-Schwelle: Code default 10 % (`identify-v3-stage3.js:256-258`) vs. Doku/Prompt 30 % (`backend/lib/llm-prompts/scopes/identify-attributes.json:10`, CLAUDE.md). Auf einen Wert angleichen (Empfehlung: Code 0.1 behalten, Doku/Prompt auf 10 % korrigieren → mehr Research-Abdeckung, näher am Chat).

## Tests (zuerst, TDD)

Neue/erweiterte Unit-Tests:

1. **Beschreibung-Prosa:** Nach Stage-3-Content-Assembly enthält `description_ebay` `<p>` und **kein** `<ul>`/`<li>`; eingegebene Modell-Prosa bleibt als Absätze erhalten.
2. **Sanitizer-Einheit:** `sanitizeDescriptionProse()` — Prosa-Input → Prosa-Output ohne Bullets; List-Input → geglättete Absätze; XSS/Disallowed-Tags entfernt; maxLen respektiert.
3. **Highlights-Policy greift:** `result.key_features` ist nach Stage-3 das Ergebnis von `normalizeHighlightsStrict(...).highlights` (Dash-Template angewandt, nicht roher Passthrough).
4. **Attribute-Fallback:** `pickLikeliestFallback` liefert für ein Pflicht-Aspekt ohne generischen Enum `'Unbekannt'`, nie einen erfundenen Wert; `confidence: 0` gesetzt.

## Verifikations-Gate

`cd backend && npm test` + `npm run build` müssen grün sein. Keine bestehende Route/Feld/ENV geändert. Golden-Rule: Production nicht negativ beeinflussen — Sanitizer additiv, alter Pfad bleibt, Frontend/Publish unangetastet.

## Out of Scope

- Keine Änderung am Publish-Pfad (eBay/Kaufland) — der gelebte Standard funktioniert bereits.
- Keine Feld-Umbenennung, keine Firestore-Migration.
- Keine V4-Änderungen außer optionaler Konsistenz (V4 ist dark; nur falls trivial mitgenommen).
- Titel: Erfassen ist hier bereits regelkonform; keine Änderung nötig.
