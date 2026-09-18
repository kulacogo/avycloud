---
title: Produktbilder — Studio und Varianten
for: [agent, dev, admin]
lastReviewed: 2026-09-18
---

# Produktbilder: Studio und Varianten

Betreiberanforderung vom 18.09.2026: professionelle Belichtung, Weißabgleich, informationshaltige Schatten und plausible Reflexionen verbessern; tatsächlichen Artikel einschließlich Schäden, Vergilbung, Verpackung, Material, Farbe, Text und Zubehör erhalten. Fehlende Bildinformation niemals als erfundene Details ersetzen.

## Umsetzung

- Gemeinsame Vorgaben: `backend/lib/product-photo-policy.js`; Studio-Prompt und Varianten-Prompts verwenden dieselbe fotografische Grenze. Kein pauschales Beleuchtungs-/Beautify-Verbot und keine Amateurlicht-Vorgabe mehr.
- `backend/services/image-studio.js`: bewährtes Originalpixel-Composite mit vorhandener deterministischer Belichtungskorrektur bleibt primär. Generative Rückfälle werden gegen das gewählte Original auf Identität, Zustand, Material, Farbe, Text und Referenzbelege geprüft. Sicher erkannte Produktänderungen werden verworfen; Unsicherheit/Prüfungsausfall erscheint in den Bildnotizen und dauerhaft sichtbar am betreffenden Bild in `components/ImageGallery.tsx`. Originalerhaltender Rückfall bleibt erhalten und wird als solcher benannt.
- Studio-Ausgabe wird erst nach Bearbeitung ohne Beschnitt auf eine weiße quadratische Leinwand mit mindestens 1600 px gesetzt. Hochskalieren erzeugt keine zusätzlichen echten Details. Das Bildmodell muss dafür keinen neuen Ausschnitt erfinden.
- `backend/services/image-generation.js` verwendet denselben Ergebnisprüfer. Gewünschte Perspektivwechsel bleiben möglich, die Regeln für tatsächlichen Zustand und belegbare Details gelten weiterhin.
- `backend/lib/image-result-check.js`: strukturierte Zusatzkriterien, eindeutige Veränderung + ausreichende Konfidenz → verwerfen; fehlende oder unsichere Bewertung → sichtbar prüfbedürftig. Das ist eine Modellbewertung und kein Beweis perfekter Produkttreue.
- Studio verwendet nun den vorhandenen gemeinsamen Kostenzähler auch für Masken/Rückfälle. Reservierung vor dem Aufruf schützt vor Timeout-Wiederholungen. Es handelt sich um konservative Schätzkosten der Bildversuche, keine vollständige API-Rechnung einschließlich Vision-/Eingabetokens.

## Betrieb und Abnahme

Bestehende Schalter: `STUDIO_COMPOSITE` (nur `off` deaktiviert), `IMAGE_COST_CAP_USD` (Default 0.9, `0` unbegrenzt), `GENERATED_IMAGE_IDENTITY_CHECK` (nur `off` deaktiviert), `GENERATED_IMAGE_IDENTITY_MIN_CONFIDENCE` (Default 0.6). Keine Schalter in Produktion geändert.

Lokale Tests decken Lichtakzeptanz, kosmetische Veränderung, unsichere Prüfung, Upload-Schutz, Modellrückfall, Budget und Quadratformat ab. Ein repräsentativer Realbildvergleich mit dunklen/matten/glänzenden Artikeln, Schäden, Kleindruck und beschädigter Verpackung steht vor der fachlichen Abnahme noch aus. Bestehende Originalbilder werden nicht überschrieben. Keine neue Route.

## Technischer Realbildtest — 18.09.2026

Mit einer isolierten Kopie echter Daten und dem bestehenden Gemini-Dienst verifiziert: Studio HTTP 200 mit Originalpixel-Composite, Varianten HTTP 200 mit vier Bildern; fehlende Makroaufnahme explizit ausgelassen. Ergebnisdateien waren nach Neustart abrufbar. Das belegt den technischen Ablauf, keine umfassende Qualitätsabnahme aller Produktkategorien. Es wurden keine Produktionsprodukte verändert.
