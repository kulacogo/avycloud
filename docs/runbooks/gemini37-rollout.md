# Rollout: Modellpolitik gemini-3.7-flash (2026-08-26)

Owner-Entscheid: Das Politik-Modell wechselt von `gemini-2.5-flash` auf **`gemini-3.7-flash`**
(Aktionspreis 0,75/3,75 $ je 1M Token bis 31.12.2026, danach 1,50/7,50 — Kosten-Forecast:
~Verdopplung von kleiner Basis, siehe Preiseintrag in `backend/lib/llm-telemetry.js`).
`backend/lib/model-select.js` normalisiert ALLE Text-Modellnamen zentral; die Cloud-Run-ENV-Pins
(`IDENTIFY_MODEL=gemini-2.5-flash` usw.) müssen dafür NICHT geändert werden — sie werden beim
Lesen normalisiert.

## Was sich beim Deploy automatisch ändert (bewusst, live gegen die echte API verifiziert)

1. **Alle Text-LLM-Calls** laufen auf `gemini-3.7-flash` (Bild-/TTS-/Live-Modelle ausgenommen).
2. **Chat-V3 wird wieder aktiv** (Ein-Request: googleSearch+urlContext+Functions; Kaskade V3→V2→Legacy
   fängt Fehler). `CHAT_V3=false` schaltet ab.
3. **V2 verlässt den Zwei-Request-Split** (Ein-Request mit `includeServerSideToolInvocations`);
   der Split bleibt als Notbremsen-Pfad vollständig erhalten.
4. **Agentische Stage 3 aktiviert sich** (`STAGE3_AGENTIC` default on, Modell-Gate offen).
   Wer das beim ersten Deploy NICHT will: `STAGE3_AGENTIC=false` pinnen (eine Variable pro Rollout).
5. **JSON-Zwang bleibt bei Grounding-Calls am Request** — der Formatter-Zweitcall pro Lauf entfällt.
6. **Grounding-Verbrauch wird gezählt**: `external_api_calls` service `gemini_grounding`,
   Feld `queryCount` (3er-Familie rechnet PRO Such-Query ab, 5.000 frei/Monat, danach 14 $/1k).

## VOR dem Merge/Deploy: Cloud-Run-ENV-Pins korrigieren (web UND worker!)

Die vier Timeout-Pins stammen aus der schnellen-Flash-Ära und liegen UNTER den Code-Defaults,
die 2026-08 genau wegen „Suche+Thinking braucht länger" angehoben wurden. Mit den alten Pins
produziert der Modellwechsel mehr Timeouts/Fallbacks und sähe fälschlich schlechter aus.

```bash
for SVC in product-hub-backend product-hub-worker; do
  gcloud run services update "$SVC" --region=europe-west3 --project=avycloud \
    --update-env-vars=FOCUSED_GROUNDING_TIMEOUT_MS=45000,IDENTIFY_GROUNDING_TIMEOUT_MS=90000,STAGE3_CONTENT_TIMEOUT_MS=60000,STAGE3_AGENTIC_TIMEOUT_MS=90000,V3_TIMEOUT_MS=240000 \
    --remove-env-vars=BASELINKER_CATEGORY_MODEL
done
```

(`BASELINKER_CATEGORY_MODEL` wird von keiner Codezeile gelesen — toter Pin.
Die Modell-Pins `IDENTIFY_MODEL` usw. können stehen bleiben: die Politik normalisiert sie.)

## NACH dem Deploy prüfen

1. `SMOKE_MODEL=gemini-3.7-flash node backend/scripts/smoke-gemini-config.js` — Konfig-Probe gegen die echte API.
2. Eine echte Erfassung durchspielen (Foto ohne Barcode): Laufzeit, Datenblatt-Qualität, `identify_metrics`.
3. Grounding-Zähler: `external_api_calls` mit service `gemini_grounding` — Summe `queryCount`/Monat
   gegen das 5.000er-Freikontingent halten (Google-Seite: Monitoring-Metrik
   `search_grounding_request_per_project_per_day`; gemessen vor dem Flip: ~2.464 Prompts/30 Tage).
4. Quality-Gate-Score-Verteilung über den Bestand vorher/nachher messen — ein anderes Urteilsmodell
   bewertet anders; erst dann Schwellen-Konsequenzen (Bereit-Status) trauen.
5. Dedup-Judge: `DEDUP_SEARCH=shadow` für einige Tage erwägen (Confidence-Verteilung des neuen
   Modells gegen die bekannten Dubletten-Paare prüfen), dann zurück auf `on`.
6. 429-Raten in den Logs beobachten (Quota-Buckets gelten PRO Modell — der gesamte Traffic wandert
   in den 3.7-Bucket). Erst bei gemessenen Wellen die Parallelität senken.

## Rollback (Notbremse)

`MODEL_POLICY=gemini25` auf beiden Services setzen → 2.5-Politik, und ALLE Fähigkeits-Gates
kippen automatisch konsistent mit (V3 aus, V2-Split an, Agentic aus, JSON-Strip an).
Kein Code-Rollback nötig.

## Danach fällig (separat)

- **31.12.2026**: Aktionspreis läuft aus — Preiseintrag in `llm-telemetry.js` nachziehen und
  Kosten neu bewerten (dann 1,50/7,50 $).
- SerpAPI bleibt nötig (Bildsuche, eBay-Sold-Preise, Amazon, Review-Evidenz) — Erwartung: nach
  dem Flip sinkt der `google`-Engine-Anteil (Text-Recherche übernimmt Grounding), der 5.000er-Plan
  sollte wieder reichen. 30 Tage nach Flip mit `external_api_calls` nachmessen, NICHT raten.
- Identify-Bericht/Trace zeigt jetzt das echte Modell (Metadaten-Lügen behoben) — Dashboards, die
  auf 'gemini-2.5-pro'-Strings filtern, ggf. anpassen.
