# eBay-Artikelzustand als eigenes Datenblatt-Feld

**Datum:** 2026-08-10
**Status:** Entwurf zur Abnahme
**Betroffene Bereiche:** Produktdatenblatt (Frontend), eBay-Publish, eBay-Abgleich, Titel-Policy

---

## 1. Ziel

Der Artikelzustand wird im Produktdatenblatt über ein Auswahlfeld gesetzt, nicht mehr über ein
Artikelmerkmal. Voreinstellung ist „Neu". Der gewählte Zustand landet beim Einstellen korrekt im
eBay-Angebot. Bei laufenden Angeboten läuft eine Änderung über die bestehende Freigabe.

**Nicht-Ziel:** Kaufland. Dort gibt es ein eigenes Zustandsfeld mit anderer Wertemenge; das ist
ein separates Arbeitspaket.

---

## 2. Wie eBay den Zustand regelt (gemessen, nicht angenommen)

Der Zustand ist bei eBay ein **eigenes Feld auf Item-Ebene** (`<ConditionID>`), unabhängig von
den Artikelmerkmalen (`<ItemSpecifics>`). Das deckt sich mit der Vorgabe aus der Aufgabe.

### 2.1 Quelle der Wahrheit

Der klassische Trading-Call `GetCategoryFeatures` ist **abgeschaltet** — er antwortet mit
`HTTP 410 Gone` (eigene Messung 2026-08-10 gegen das Produktionskonto). Gültig ist die
REST-Metadata-API:

```
GET https://api.ebay.com/sell/metadata/v1/marketplace/EBAY_DE/get_item_condition_policies
```

Antwort 2026-08-10: **HTTP 200, 14.917 Kategorien**.

### 2.2 Die Wertemenge auf ebay.de

| ID | Häufigster deutscher Name | Kategorien |
|---|---|---|
| 1000 | Neu | 13.025 |
| 1500 | Neu: Sonstige (siehe Artikelbeschreibung) | 9.707 |
| 1750 | Neu mit Fehlern / Neu mit Mängeln | 1.071 |
| 1900 | Unbenutzt | 16 |
| 2500 | Vom Verkäufer generalüberholt | 5.934 |
| 2750 | Neuwertig | 103 |
| 2990 | Gebraucht – Hervorragend | 339 |
| 3000 | Gebraucht | 12.493 |
| 3010 | Gebraucht – Akzeptabel | 339 |
| 4000 | Sehr gut | 103 |
| 5000 | Gut | 100 |
| 6000 | Akzeptabel | 100 |
| 7000 | Als Ersatzteil / defekt | 8.292 |

`2000` (Certified Refurbished) kommt für unser Konto nicht vor — es verlangt eine
eBay-Freischaltung. `2010`/`2020`/`2030` (die neueren Refurbished-Stufen) erscheinen auf ebay.de
ebenfalls nicht.

### 2.3 Drei Regeln, die den Bau bestimmen

1. **Die erlaubten Zustände hängen an der Kategorie.** Keine Kategorie erlaubt alle.
2. **Der Anzeigename einer ID hängt ebenfalls an der Kategorie.** `1000` heißt meist „Neu", in
   968 Bekleidungs-Kategorien „Neu mit Etikett", in 80 „Neu mit Karton". `3000` heißt meist
   „Gebraucht", in 339 Kategorien „Gebraucht – Gut". Eine feste Liste würde falsch beschriften.
3. **In 10.767 von 14.917 Kategorien (72,2 %) ist der Zustand Pflicht.** In 1.889 Kategorien gibt
   es gar keinen Zustand — dort darf `ConditionID` nicht gesendet werden.

Über alle 14.917 Kategorien existieren nur **27 verschiedene Zustands-Sets**. Das macht die Daten
klein genug für eine Repo-Datei (siehe 4.2).

### 2.4 Offen, bewusst nicht angenommen

Ob eBay das Ändern des Zustands an einem **laufenden Angebot mit bereits erfolgten Verkäufen**
zulässt, ist nicht belegt. Die Doku war nicht abrufbar (403 gegen `developer.ebay.com`), und ein
Praxistest wäre ein Schreibzugriff auf ein Live-Angebot gewesen. Der Entwurf behandelt einen
abgelehnten Revise deshalb als normalen, nicht-destruktiven Fehlerfall (siehe 4.7).

---

## 3. Ist-Zustand

### 3.1 Code: halb verkabelt, mit einem stillen Überschreiber

- `lib/ebay-direct.js:4285-4289` — `mapProductToEbayItem` liest bereits eine Kette:
  `overrides.conditionId` → `marketplace.ebay.conditionId` → `details.conditionId` → Rückfall `'1000'`.
- `lib/ebay-trading-api.js:1306` (Publish) und `:857-859` (Revise) schreiben `<ConditionID>` als
  eigenes Element. `ConditionDescription` unterstützt nur der Publish-Pfad.
- **Kein Pfad schreibt diese Felder.** Weder Datenblatt noch Erfassen noch Chat. `types.ts:1101`
  kennt `conditionId` nur als Publish-Override.
- `computeSyncPatch` (`lib/ebay-direct.js:3412`) kennt den Zustand nicht — der Gap-Abgleich fasst
  ihn nie an. `reviseListingFromProduct` (`lib/ebay-direct.js:5328`) sendet ihn dagegen bei
  **jedem** Revise mit, also faktisch immer `1000`.

**Folge:** ein per Hand auf „Gebraucht" gesetztes Angebot fällt beim nächsten inhaltlichen Revise
still auf „Neu" zurück. Das ist ein latenter Datenverlust, unabhängig von diesem Feature.

### 3.2 Daten: ein konkurrierendes Zustands-Konzept als Artikelmerkmal

Gemessen über `products_v2` (tenant `default`, 1.758 Produkte, read-only):

- 1.733 Produkte haben eine numerische eBay-Kategorie, verteilt auf **914 verschiedene Kategorien**
- **1.627 Produkte stehen in Kategorien mit Zustands-Pflicht**
- 81 Produkte stehen in Kategorien, für die eBay keine Zustands-Policy führt
- rund **1.115 Produkte tragen ein Artikelmerkmal „Zustand"**, mit uneinheitlichen Werten:
  `Neu` (858), `new` (218), `NEU` (20), `Gebraucht` (4), dazu Einzelfälle wie `used_good`,
  `Leer`, `Neuwertig, mit leichten Lagerspuren`

Geschrieben wird dieses Merkmal an mindestens vier Stellen: `lib/identify-v3-stage3.js:628`,
`lib/v2-product-builder.js:110`, `services/enrichment-v2.js:278` und per Prompt-Anweisung in
`services/enrichment.js:756` („setze Attribut Zustand = NEU").

### 3.3 Das Merkmal hängt an der Titel-Bildung

`lib/title-policy.js:1382` nimmt einen Zustands-Token nur dann in den Titel auf, wenn
`ops.condition_locked` gesetzt **oder** das Merkmal „Zustand" vorhanden ist. `inferCondition()`
(`:1105`) leitet daraus `NEU`, `NEU OVP` oder `GEBRAUCHT` ab.

Das ist der empfindlichste Punkt des ganzen Umbaus: Merkmal entfernen ohne Ersatz ⇒ rund 1.115
Titel verlieren ihren Zustands-Token ⇒ Massen-Abweichungen gegen die Live-Angebote.

Vorbereitet, aber inaktiv: `lib/ebay-aspect-repair.js:57-62` führt `Zustand` und `Artikelzustand`
bereits in `MISPLACED_ASPECT_TOKENS`; der Standardmodus ist `off`.

---

## 4. Entwurf

### 4.1 Datenmodell (additiv)

| Feld | Typ | Bedeutung |
|---|---|---|
| `details.conditionId` | String, z. B. `'3000'` | der gewählte eBay-Zustand |
| `details.conditionSource` | `'manual' \| 'auto'` | wer ihn gesetzt hat |

Kein Feld wird umbenannt oder gelöscht. `details.conditionId` wird von `mapProductToEbayItem`
bereits gelesen.

**Eine Änderung an der bestehenden Kette:** die Reihenfolge in `lib/ebay-direct.js:4285` wird
umgedreht, sodass `details.conditionId` **vor** `marketplace.ebay.conditionId` gewinnt. Sonst
könnte ein aus dem Angebot gespiegelter Wert die Wahl im Datenblatt überstimmen. Der Rückfall auf
`'1000'` bleibt unverändert.

Muster für `conditionSource` ist das bestehende `details.categorySource`
(`'manual'` schützt vor automatischen Überschreibungen, siehe CLAUDE.md §Category-Source-Protection).

### 4.2 Zustands-Katalog als Repo-Datei

Neue Datei `backend/ebay-data/condition-policies-de.json`:

```json
{
  "v": 1,
  "syncedAt": "2026-08-10T00:00:00.000Z",
  "marketplace": "EBAY_DE",
  "sets": [ [[1000, "Neu"], [1500, "Neu: Sonstige (siehe Artikelbeschreibung)"], ...], ... ],
  "cats": { "261581": [0, 0], "261588": [5, 1] }
}
```

`cats[kategorieId] = [setIndex, requiredFlag]`. Durch die 27 Sets bleibt die Datei bei
**rund 215 KB** — kleiner als das bereits im Repo liegende `required-aspects-full.json` (461 KB).
Kein API-Call zur Laufzeit.

Dazu `backend/scripts/sync-ebay-condition-policies.js` (read-only gegen eBay, schreibt nur die
JSON-Datei) zum Nachziehen. Meta-Datei mit Sync-Datum analog zu `required-aspects-full-meta.json`,
damit Veralterung sichtbar ist.

### 4.3 Reine Lib

`backend/lib/ebay-conditions.js`, ohne Netz und ohne Firestore:

- `getConditionsForCategory(categoryId)` → `{ required: boolean, conditions: [{ id, name }] }`.
  Unbekannte Kategorie → `{ required: false, conditions: [] }` (nicht werfen).
- `isConditionAllowed(categoryId, conditionId)` → bei unbekannter Kategorie `true`
  (fail-open: 81 unserer Produkte stehen in solchen Kategorien, sie dürfen nicht blockiert werden).
- `resolveConditionName(categoryId, conditionId)` → kategoriegenauer Anzeigename, Rückfall auf
  den global häufigsten Namen.

### 4.4 Endpoint

`GET /api/ebay/conditions?categoryId=<id>` → `{ ok: true, required, conditions: [{ id, name }] }`.

Ohne `categoryId` liefert er die globale Liste, damit das Datenblatt auch bei fehlender Kategorie
etwas anzeigen kann.

### 4.5 Oberfläche

Auswahlfeld im Produktdatenblatt (`components/ProductSheet.tsx`), platziert bei der Kategorie —
sie bestimmt die Auswahl, also gehört beides nebeneinander.

- angezeigt werden nur die in dieser Kategorie erlaubten Zustände, mit kategoriegenauen Namen
- ohne Auswahl steht dort **„Neu (Standard)"**, sichtbar als Voreinstellung und nicht als Wert
- eine Auswahl setzt `conditionSource: 'manual'`
- verlangt die Kategorie einen Zustand und ist keiner gewählt, erscheint ein Hinweis (kein Block)
- führt die Kategorie keine Zustände, wird das Feld ausgegraut mit Begründung
- beim Kategoriewechsel: ist der gewählte Zustand dort nicht erlaubt, wird er sichtbar
  zurückgesetzt statt still zu verschwinden

Gestaltung nach den Design-Tokens (`bg-accent`, keine rohen Tailwind-Farben), Auswahlfeld im
Hausstil der bestehenden Formularfelder im Datenblatt.

### 4.6 Einstellen (Publish)

In `validatePublishReadiness()`:

- gewählter Zustand nicht erlaubt → Abbruch mit neuer Fehlerklasse `CONDITION_NOT_ALLOWED`
  in `lib/listing-error-classify.js`, damit das Fehler-Cockpit die Fälle bündelt
- Kategorie ohne Zustände → `ConditionID` weglassen statt `1000` zu senden

### 4.7 Laufende Angebote — nur über Freigabe

Entscheidung des Owners (2026-08-10): **kein automatischer Push.**

- neuer Gap-Typ `condition` in `ebayListingGaps`, gefüllt aus dem Vergleich
  Datenblatt ↔ Spiegel (`ebayListingsLive.conditionId`, wird von
  `lib/ebay-trading-api.js:527` bereits gespiegelt)
- `computeSyncPatch` übernimmt `patch.conditionId` **nur** aus einem freigegebenen Gap
- `reviseListingFromProduct` sendet `conditionId` künftig **nur**, wenn er vom Spiegelwert
  abweicht und freigegeben ist. Das entschärft den stillen Überschreiber aus 3.1.
- lehnt eBay den Revise ab, ist das ein gewöhnlicher, nicht-destruktiver Fehler: klassifizieren,
  in die Warteschlange, Wiederholung mit Backoff — nie ein Beenden des Angebots (CLAUDE.md §14)

### 4.8 Titel-Verhalten unverändert halten

`lib/title-policy.js` bekommt das neue Feld als **zusätzliche** Quelle, nicht als Ersatz:

```
Zustands-Token im Titel, wenn:
    ops.condition_locked                      (wie heute)
 ODER details.conditionSource === 'manual'    (neu)
 ODER Merkmal „Zustand" vorhanden             (wie heute, bleibt bis zur Ablösung)
```

`inferCondition()` liest bei gesetztem `conditionSource === 'manual'` die ID, sonst weiter das
Merkmal. Abbildung: `1000`/`1500`/`1750`/`1900` → `NEU` (bzw. `NEU OVP` bei OVP-Hinweis),
alles ab `2500` → `GEBRAUCHT`.

Zwei Punkte, die zusammen dafür sorgen, dass **kein einziger Titel sich ändert**:

- Das Merkmal bleibt vorerst gültige Quelle. Würde man es sofort abklemmen, verlören rund 1.115
  Titel ihren Zustands-Token.
- Auslöser für die neue Quelle ist `conditionSource === 'manual'`, **nicht** das bloße
  Vorhandensein von `conditionId`. Sonst erzeugte die Voreinstellung „Neu" bei jedem Produkt einen
  Token, den es heute nicht gibt.

Weicht ein manuell gesetzter Zustand vom Alt-Merkmal ab, gewinnt das Feld — es ist die
ausdrückliche Eingabe eines Menschen.

### 4.9 Kein Backfill

Die rund 1.115 Merkmalswerte werden **nicht** in `details.conditionId` übertragen. Begründung:
ein leeres Feld verhält sich beim Einstellen exakt wie heute (Rückfall auf `1000`), ein Backfill
würde dagegen über 4.8 Titel verändern.

Das Merkmal „Zustand" wird bei aktivem Schalter aus den Artikelmerkmalen des **Publish**-XML
gefiltert — die Namen stehen bereits in `lib/ebay-aspect-repair.js:57-62`, die dortige Mechanik
läuft aber unter eigenem Schalter und im Standard auf `off`; der Filter wird hier eigenständig an
`EBAY_CONDITION_FIELD` gehängt. Laufende Angebote sind davon nicht betroffen: der Revise-Pfad
mischt Merkmale über `filterPatchItemSpecificsForListing` und wird nicht angefasst.

Im Datenblatt bleibt das Alt-Merkmal sichtbar, bis der Owner es je Produkt bewusst ersetzt.

### 4.10 Schalter

`EBAY_CONDITION_FIELD='off'` (Voreinstellung) | `'on'`.

`off` bedeutet exakt heutiges Verhalten: kein Auswahlfeld, keine Publish-Prüfung, keine
Zustands-Gaps. Auch das Umdrehen der Lese-Reihenfolge aus 4.1 hängt am Schalter.

Die Entschärfung des stillen Überschreibers (4.7, zweiter Punkt) läuft **ohne** Schalter — sie
verhindert nur einen Datenverlust und ändert nichts, was heute gewollt ist.

---

## 5. Ausdrücklich nicht im Umfang

- Kaufland-Zustand
- `ConditionDescription` (Freitext zum Zustand) und `ConditionDescriptors` (strukturierte
  Zustandsangaben, u. a. bei Sammelkarten). Beide sind sinnvolle Erweiterungen, aber eigenständig.
- automatisches Erkennen des Zustands durch die Erfassen-Pipeline
- Massen-Bearbeitung des Zustands über die Produktliste

---

## 6. Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Titel ändern sich ungewollt → Massen-Abweichungen | 4.8: Alt-Merkmal bleibt gültige Quelle, neue Quelle nur bei `manual`; 4.9: kein Backfill |
| Zustand eines Live-Angebots wird still überschrieben | 4.7: nur bei freigegebener Abweichung senden |
| Kategorie-Daten veralten, Auswahl wird falsch | Sync-Script + Meta-Datei mit Datum, fail-open bei unbekannter Kategorie |
| eBay lehnt Zustandsänderung bei verkauften Angeboten ab | 4.7: als gewöhnlicher Fehler behandeln, nie destruktiv |
| Kategorie ohne Zustände bekommt trotzdem `1000` | 4.6: Feld weglassen |

---

## 7. Tests

Neu, alle in `backend/__tests__/`:

- `ebay-conditions-lib.test.js` — kategoriegenaue Namen (`1000` = „Neu mit Etikett" in einer
  Bekleidungskategorie), Pflicht-Flag, fail-open bei unbekannter Kategorie
- `ebay-condition-publish.test.js` — erlaubter Zustand landet im XML; unerlaubter wird
  abgewiesen; Kategorie ohne Zustände sendet kein `ConditionID`
- `ebay-condition-no-silent-overwrite.test.js` — Regressionstest zu 3.1: ein Revise ohne
  freigegebene Zustands-Abweichung enthält **kein** `<ConditionID>`
- `title-policy-condition-source.test.js` — drei Fälle: (a) Produkt mit Alt-Merkmal „Zustand"
  und ohne `conditionId` behält seinen Titel unverändert; (b) `conditionId` gesetzt, aber
  `conditionSource !== 'manual'` erzeugt **keinen** neuen Token; (c) manuell gesetzter Zustand
  gewinnt gegen ein abweichendes Alt-Merkmal
- Flag-Test: bei `EBAY_CONDITION_FIELD='off'` verhält sich Publish byte-gleich wie heute

---

## 8. Rollout

1. Katalog-Datei + Lib + Tests, Flag `off` — keine Verhaltensänderung
2. Entschärfung des stillen Überschreibers (ohne Flag), mit Regressionstest
3. Endpoint + Auswahlfeld im Datenblatt, Flag weiterhin `off` (nicht sichtbar)
4. Flag auf `on` in einer Sitzung mit dem Owner, an einem Produkt geprüft
5. Zustands-Gaps beobachten, bevor die erste Freigabe erteilt wird
