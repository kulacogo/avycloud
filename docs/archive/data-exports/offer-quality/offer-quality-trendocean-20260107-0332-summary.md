# Analyse – Bericht zur Angebotsqualität (trendocean, DE, 07.01.2026)

Quelle: `Bericht zur Angebotsqualität für trendocean - DE - 07.01.2026 03-32 MEZ.xlsx`

## Dateien (aus dieser Analyse generiert)

- `overview.json`: Struktur/Metadaten + per Sheet Kurz-Auswertung
- `category_summary.csv`: Kennzahlen pro Kategorie-Sheet (Offer-Counts + Missing/Thresholds)
- `offers_long.csv`: Alle Offer-Zeilen (Long-Format) für Filter/Excel/Pivot
- `google_shopping_rejected.csv`: Tabelle der Google Shopping Ablehnungen

## Zusammenfassung (Executive)

- Workbook enthält **13 Sheets**: 1× Zusammenfassung, 1× Ratgeber, 1× Google Shopping Ablehnungen, **10× Kategorie-Sheets**.
- In der **Zusammenfassung** werden insgesamt **44 „Angebote können optimiert werden“** über 9 Blöcke berichtet.
- **Google Shopping**: **6 abgelehnte Produkte**, alle in Kategorie **Tonerkassetten**, Problem: **„Fehlende Anforderungen zu Druckerpatronen“**.

## Kategorie-Sheets (Listing-Tabelle ab Zeile 44)

Hinweis: In vielen Zellen steht **„Keine Angabe“** (als fehlend gewertet). Ein **„✔“** wird als „vorhanden“ gezählt (Wert selbst ist im Report teilweise nicht ausgeschrieben).

### Kennzahlen pro Kategorie (aus `category_summary.csv`)

| Kategorie-Sheet | Offers | Missing Marke | Missing Herstellernummer | Missing EAN | Fotos < 5 | Empf. Merkmale < 5 |
|---|---:|---:|---:|---:|---:|---:|
| Damenschuhe>Sneaker | 11 | 0 | 10 | 10 | 1 | 5 |
| Herrenschuhe>Sneaker | 8 | 0 | 8 | 6 | 0 | 7 |
| Sonstige | 9 | 9 | 6 | 4 | 2 | 5 |
| Bettlaken | 7 | 0 | 5 | 5 | 5 | 6 |
| Motoröl | 6 | 0 | 0 | 0 | 1 | 5 |
| Tonerkassetten | 6 | 0 | 1 | 0 | 3 | 1 |
| Möbelschutzhüllen | 5 | 0 | 3 | 0 | 2 | 4 |
| Bettwäsche | 5 | 3 | 2 | 1 | 1 | 3 |
| Bücher | 5 | 5 | 5 | 5 | 4 | 0 |
| Bremsscheiben | 6 | 6 | 2 | 2 | 1 | 4 |

### Auffälligkeiten (high-signal)

- **Sneaker (Damen/Herren)**:
  - Sehr häufig **Herstellernummer + EAN fehlen** (Damen: 10/11, Herren: 8/8 bzw. EAN 6/8).
  - Viele Angebote haben **<5 empfohlene Artikelmerkmale** (Damen: 5/11, Herren: 7/8).
- **Sonstige**:
  - **Marke fehlt bei 9/9** Angeboten (sehr auffällig; wirkt wie unvollständige Datenbasis).
- **Bettlaken**:
  - **Fotos < 5 bei 5/7** Angeboten (Foto-Qualität/Quantität ist hier ein klarer Hebel).
  - **Herstellernummer/EAN fehlen bei 5/7**.
- **Tonerkassetten**:
  - **Google Shopping Ablehnung** betrifft 6 Toner-Angebote (siehe `google_shopping_rejected.csv`).
  - Zusätzlich: **Fotos < 5 bei 3/6**.
- **Bücher**:
  - In diesem Report sind **Marke/Herstellernummer/EAN** überall „Keine Angabe“ (5/5).
  - Gleichzeitig ist **ISBN in diesem Sheet vollständig vorhanden (0 fehlend)** – d. h. für Bücher ist ISBN vermutlich der relevante Identifikator im Listing-Kontext.

## Google Shopping: Abgelehnte Produkte (Sheet)

Siehe `google_shopping_rejected.csv`:
- Kategorie: **Tonerkassetten**
- Anzahl: **6**
- Google-Problem: **Fehlende Anforderungen zu Druckerpatronen**

## Nächste sinnvolle Schritte (ohne Spekulation)

- **Daten-Abgleich gegen eure Produktdaten**: `offers_long.csv` enthält **SKU** und **Artikelnummer** aus dem Report → damit können wir die betroffenen Produkte in Firestore/BaseLinker finden.
- **Priorisieren nach Impact**: Kategorien mit hoher Missing-Quote (z. B. Sneaker, Sonstige, Bettlaken, Bremsscheiben).
- **Gezielte Reparatur-Workflows**:
  - fehlende **Marke/Herstellernummer/EAN** (wo im Report als fehlend markiert)
  - **Fotos auf ≥5** bringen, wenn Report <5 zeigt
  - **empfohlene Artikelmerkmale** auf ≥5 erhöhen (Report-Spalte „Empfohlene Artikelmerkmale angegeben“)

