# Design: Pack-Modul Versand-Umbau — kuratierter Versand-Katalog

**Datum:** 2026-07-22
**Status:** Entwurf zur Abnahme
**Owner:** TrendOcean GmbH (kulacoglu.oguzhan@gmail.com)
**Quelle der Wahrheit:** Plakat „WELCHER VERSAND?" (ab 09.07.2026)

---

## 1. Ziel

Der Versand-Teil des Pack-Moduls (Mobile-Scanner + Desktop) wird umgebaut, sodass beim Verpacken einer Bestellung genau die Produkte gewählt werden, die TrendOcean laut Plakat nutzt — kurz, korrekt benannt, kostenbewusst. Konkret:

1. **Gewicht immer abfragen** beim SKU-Scan — auch wenn Angebot/Bestellung/Datenblatt bereits ein Gewicht hat.
2. **Kurze, kuratierte Produktliste** statt der 185 SendCloud-Methoden. Nomenklatur = Plakat. **Keine** Zusatzleistungen (Premium/Express/GoGreen/eco/Alterssichtprüfung/Transportversicherung/Service-Point/Locker/Filial-Routing).
3. **Auswahl nach Gewicht + Zielland gefiltert**, billigste gültige Option zuerst (Sparziel).
4. **Nicht-DE → nur internationale/EU-Produkte**; nationale Produkte sind für Auslandsadressen ausgeschlossen.
5. **Label mit exaktem v3-Code** erstellen — kein Fuzzy-Resolver-Raten mehr.

## 2. Nicht-Ziele

- Keine Preis-/Buchhaltungslogik. Plakat-Preise dienen nur der Reihenfolge (billigste zuerst), nicht der Kostenrechnung.
- Keine Maß-/Dimensionserfassung (Länge/Breite/Höhe). Das System kennt nur Gewicht; die Größen-/Silhouetten-Entscheidung (Großbrief ≤2cm vs. Warensendung ≤5cm vs. Kleinpaket ≤8cm) trifft der Packer physisch — das System bietet nur das nach Gewicht+Ziel gültige Menü an.
- Keine Änderung an Retouren, Rechnungen, Bestandslogik.

## 3. Ist-Zustand (verifiziert)

- **Ein Vorschau-Endpoint** (`GET /api/orders/:id/shipping-preview`) treibt den Flow: liefert Gewicht + `matches[]` aus den **Versandregeln** (`order_settings.carrierRules`, country-blind). UI: kein Gewicht → Popup; 1 Treffer → sofort versenden; >1 → `CarrierPickModal`.
- **Label-Erstellung** immer über SendCloud **v3 `shipping_option_code`** (String). Die gewählte numerische Methoden-ID wird von `_matchV3OptionCode` (`shipping-engine.js`) **fuzzy** zu einem v3-Code aufgelöst — Quelle aller jüngsten Versand-Incidents.
- **Belegte Fehl-Mappings** (echte Sendungen): Großbrief (1269) **und** Warensendung (2237) → beide `dp:buchersendung` (Büchersendung, nur für Bücher erlaubt); „DHL Paket" national auf GR-Bestellung → `dhl_de:weltpaket`.
- **Ohne-Tracking ist ein Nicht-Problem:** SendCloud vergibt für **jedes** v3-Produkt eine Sendungsnummer in `tracking_number` (Großbrief `A0063809DD…`, Warensendung, Maxibrief, Warenpost Int `UF…DE`). Diese wird bereits via `pushTrackingToMarketplace` an eBay/Kaufland gepusht (Kaufland akzeptiert sie). Null-Tracking tritt nur bei **fehlgeschlagenem** Announce (statusId 1002) auf.
- **Buyer-Country** = `order.customer.country` (ISO-2). eBay kann `null` liefern → Default `DE`. Kaufland: shipping→billing→`DE`.
- **Versandregeln-Verbraucher:** `shipping-preview` (`matchAllCarrierRules`), `shipOrder` Auto-Select (`matchCarrierRule`), Sammel-Versand „Auto (Regel)". Owner hat die Regel-**Daten** entfernt; Code läuft noch auf `DEFAULT_CARRIER_RULES`.
- Geteilte FE-Modals: `components/orders/ShippingDecisionDialog.tsx` (`WeightPromptModal`, `CarrierPickModal`), genutzt von `OrderDetail` (Desktop) + `MobileOperationsView` (Mobile).

## 4. Kuratierter Versand-Katalog

Neue Config-Datei `backend/config/shipping-catalog.js` (kein Firestore — bewusst versioniert im Code, editierbar ohne Deploy-Risiko, ein Ort der Wahrheit). Jeder Eintrag:

```js
{
  key: 'grossbrief',          // stabiler interner Schlüssel
  displayName: 'Großbrief',   // Plakat-Name (UI)
  carrier: 'dp',              // Badge (dp | dhl_de | dpd)
  v3Base: 'dp:grossbrief',    // EXAKTER v3-Basis-Produktcode (Modifier-frei) — SHIP nutzt genau diesen
  v2MethodId: 1269,           // Referenz/Fallback (verifiziert im shipping_methods-Katalog)
  scope: 'national',          // 'national' | 'international'
  maxWeightKg: 0.5,
  tracking: false,            // nur Anzeige-Indikator (Sendungsnummer existiert trotzdem)
  allowedCountries: ['DE'],   // eigene Whitelist (NICHT SendClouds permissive Liste)
  rank: 1,                    // Sortierung „billigste zuerst"
}
```

### Katalog-Inhalt (verifiziert gegen `shipping_methods` tenant=default)

**DEUTSCHLAND (scope: national, `allowedCountries: ['DE']`):**

| key | Anzeige | carrier | v2 ID | v3-Base (Ziel) | ≤ kg | Track | rank |
|---|---|---|---|---|---|---|---|
| grossbrief | Großbrief | dp | 1269 | `dp:grossbrief` ⚠️ | 0,5 | ✗ | 1 |
| warensendung | Warensendung | dp | 2237 | `dp:warensendung` ⚠️ | 1 | ✗ | 2 |
| kleinpaket | Kleinpaket | dhl_de | 2830 | `dhl_de:warenpost` ✓ | 1 | ✓ | 3 |
| dpd_classic | DPD Classic | dpd | 111/112/113/114 | `dpd:classic` ✓ | 31,5 | ✓ | 4 |
| dhl_paket | DHL Paket | dhl_de | 89 | `dhl_de:dhl_paket` ✓ | 31,5 | ✓ | 5 |
| maxibrief | Maxibrief | dp | 1224 | `dp:maxibrief` ⚠️ | 1 | ✗ | 2 |

**EU / INTERNATIONAL (scope: international):**

| key | Anzeige | carrier | v2 ID | v3-Base (Ziel) | ≤ kg | Track | allowedCountries |
|---|---|---|---|---|---|---|---|
| warenpost_int | Warenpost International | dhl_de | 4208 | `dhl_de:warenpostinternational` ✓ | 1 | ✗ | Zone1∪Zone2 (+ Fremdland-Warnung) |
| dpd_classic_europa | DPD Classic Europa | dpd | 111–114 | `dpd:classic` ✓ | 31,5 | ✓ | **nur** BE,LU,NL,AT,DK,CZ,FR |
| dhl_paket_int | DHL Paket International | dhl_de | 94 | `dhl_de:europaket`/`weltpaket` ⚠️ | 31,5 | ✓ | weltweit (Zone-1/2 normal, sonst Warnung) |

✓ = v3-Code aus echten Sendungen bestätigt. ⚠️ = **muss per Live-`shipping-options`-Capture bestätigt/gepinnt werden** (siehe §12, Implementierungs-Schritt 0). Insbesondere: existiert `dp:warensendung` überhaupt auf diesem Konto, oder liefert SendCloud nur `dp:buchersendung`? Falls Warensendung nicht sauber verfügbar ist, wird sie im Katalog markiert bzw. auf das korrekte DP-Produkt gemappt — **nie** stillschweigend Büchersendung.

### Zonen (Config)

```js
ZONE_1 = ['BE','DK','FR','LU','MC','NL','AT','PL','CZ']
ZONE_2 = ['AD','IT','SM','SE','SK','SI','ES','HU','VA']
DPD_EUROPA = ['BE','LU','NL','AT','DK','CZ','FR']  // Business-Regel, enger als SendClouds 32 Länder
```

**Wichtig:** Diese Grenzen sind TrendOcean-Regeln. SendCloud bietet DPD Classic für 32 und die International-Produkte für 199 Länder an — der Katalog erzwingt die Beschränkung selbst über `allowedCountries`; SendClouds `countries`-Liste wird dafür **nicht** herangezogen.

## 5. Ziel-/Zonen-Modell

Aus `order.customer.country` (Default `DE` wenn leer):

- **DE** → nationale Produkte.
- **∈ Zone 1 ∪ Zone 2** → internationale Produkte; DPD Classic Europa nur wenn Land ∈ `DPD_EUROPA`. Keine Warnung.
- **Sonstiges Land** (EU-Nicht-Zone wie GR/IE, oder Nicht-EU) → internationale Produkte (Warenpost Int / DHL Paket Int decken weltweit ab) **plus deutlicher Hinweis** „außerhalb Standard-Zonen — Teamlead fragen". **Kein harter Block** (Owner-Entscheidung; echte GR/IE-Sendungen existieren).
- Land leer/unbekannt → wie DE behandeln, aber Hinweis „Zielland fehlt — prüfen".

## 6. Pack-Flow (neu)

Gilt identisch für Mobile (`MobileOperationsView`) und Desktop (`OrderDetail`) über den geteilten `ShippingDecisionDialog`.

```
SKU scannen / „Versandlabel erstellen"
  └─ Schritt 1: GEWICHT (WeightPromptModal) — IMMER, vorbefüllt mit Schätzung,
     Pflicht-Bestätigung. Persistiert via updateOrderWeight.
  └─ Schritt 2: OPTIONEN laden — GET /api/orders/:id/shipping-options?weight=X
       → Ziel-Scope bestimmen, Live-v3-Optionen holen, auf kuratierte Produkte
         mappen, nach rank (billigste zuerst) sortieren.
       → Fremdland-Warnung falls außerhalb Zone 1/2.
       → keine gültige Option (z. B. >31,5 kg) → klare Fehlermeldung.
  └─ Schritt 3: EINE Liste, billigste zuerst (Plakat-Name · Carrier-Badge · Tracking ✓/✗).
     Packer tippt eine Option.
  └─ Schritt 4: LABEL — POST /api/orders/:id/ship { shippingOptionCode, weight }
     → createParcel nutzt den EXAKTEN Code (kein Fuzzy-Resolver) → drucken.
```

Der bisherige `CarrierPickModal` (Regel-Treffer) wird durch einen `ShippingOptionModal` (kuratierte Liste) ersetzt. `WeightPromptModal` bleibt, wird aber **immer** gezeigt (nicht nur wenn Gewicht fehlt) und vorbefüllt.

## 7. Backend-Änderungen

1. **Neuer Endpoint** `GET /api/orders/:orderId/shipping-options?weight=<kg>` (`routes/orders.js`, `orders:read`):
   - lädt Order → `customer.country` + Gewicht.
   - bestimmt Scope (DE / Zone / Fremdland).
   - ruft `_listV3ShippingOptions({ toCountry, toPostal, weightKg })`.
   - mappt die Live-Optionen über den Katalog auf kuratierte Produkte (Match per `v3Base`-Präfix, Modifier-frei, verbotene Modifier ausgeschlossen).
   - filtert nach `maxWeightKg` + `allowedCountries`.
   - liefert `{ weight, scope, warning?, blockedReason?, products: [{ key, displayName, carrier, tracking, shippingOptionCode, rank }] }`, sortiert nach `rank`.
2. **Neue Katalog-Lib** `backend/config/shipping-catalog.js` + `backend/lib/shipping-catalog-resolver.js` (`resolveCuratedOptions(options, scope, country, weight)` — deterministisch, exakt, testbar).
3. **`createParcel` / `shipOrder` akzeptieren `shippingOptionCode`** (neuer optionaler Parameter): wenn gesetzt, wird `_matchV3OptionCode` übersprungen und der Code direkt an `_createV3Shipment` gereicht. Bestehender numerischer Pfad bleibt (Rückwärtskompatibilität, Sammel-Versand).
4. **Verbotene Modifier** (hart ausgeschlossen im Resolver): `gogreen|eco_delivery|premium|service_point|locker|filial|alterssicht|agecheck|transportversicherung|insurance|express|sperrgut`. Ergänzt die bestehende `_needsServicePoint`-Logik.
5. **`ship`-Endpoint** akzeptiert `shippingOptionCode` im Body (zusätzlich zum bestehenden `shippingMethodId`).

## 8. Versandregeln-Entfernung

- Interaktiver Flow nutzt keine Regeln mehr. `shipping-preview` bleibt für Gewichts-/Adress-Diagnose, `matches[]` entfällt bzw. wird durch den neuen Options-Endpoint ersetzt.
- **Sammel-Versand** („Labels erstellen") wird auf den kuratierten Katalog umgestellt: pro Order billigstes gültiges Produkt nach Gewicht+Land (statt `matchCarrierRule`). Kein „Auto (Regel)" mehr.
- Toten Regel-Code entfernen: `matchCarrierRule`, `matchAllCarrierRules`, `DEFAULT_CARRIER_RULES`, `_sortCarrierRules`, `shipping-rule-matching.test.js`, und die Versandregeln-Sektion in `OrderSettingsView.tsx` + `carrierRules` in `OrderSettingsData`. Firestore-Feld `order_settings.carrierRules` wird **nicht** gelöscht (additive-only), nur nicht mehr gelesen.

## 9. Ohne-Tracking

Keine Sonderbehandlung nötig — SendCloud liefert für alle kuratierten Produkte eine Sendungsnummer, die der bestehende `pushTrackingToMarketplace`-Pfad überträgt. Einziger optionaler UX-Feinschliff: die Anzeige „Tracking ✗" im Modal (Info für den Packer), und die Warnbanner-Logik „Tracking fehlt" (`OrderDetail.tsx`) unangetastet lassen (sie greift nur bei echtem Null-Tracking = fehlgeschlagener Announce).

## 10. Edge-Cases

- **Gewicht > 31,5 kg** → kein Produkt gültig → Fehlermeldung „Übergewicht — Sondertransport, Teamlead fragen".
- **Zielland leer** → wie DE, Hinweis „Zielland fehlt".
- **DPD-Land nicht in den 7** (z. B. IT, ES, SE) → DPD Classic Europa erscheint nicht; Warenpost Int / DHL Paket Int schon.
- **Keine Live-Option für ein Katalog-Produkt** (SendCloud liefert den Code für diese Lane nicht) → Produkt wird nicht angezeigt (nie ein Produkt zeigen, das am Announce scheitert).
- **Packstation/Postfiliale** → bestehende `po_box`-Logik in `createParcel` bleibt; Service-Point-Produkte bleiben ausgeschlossen (wir liefern an Haus-/DHL-Postnummer-Adresse).
- **Alt-Verhalten:** `shipOrder` ohne `shippingOptionCode` (Sammel-Versand, Ops-Scripts) fällt weiter auf den numerischen Pfad zurück.

## 11. Tests

- Neu: `shipping-catalog-resolver.test.js` — Mapping Live-Optionen → kuratierte Produkte; Modifier-Ausschluss; Zonen/`allowedCountries`; DPD-7; Fremdland-Warnung; Übergewicht.
- Neu: `shipping-options-endpoint.test.js` — Endpoint-Contract (Scope, Warnung, Sortierung).
- Neu: `ship-with-option-code.test.js` — `createParcel`/`shipOrder` mit `shippingOptionCode` überspringt `_matchV3OptionCode`.
- Anpassen: `shipping-v3-*.test.js` (Resolver bleibt für Alt-Pfad), `shipping-rule-matching.test.js` (entfällt).
- Frontend: Flow-Test Gewicht-immer + Options-Liste + Fremdland-Warnung.

## 12. Offene Implementierungs-Schritte

- **Schritt 0 (zuerst, blockierend):** Live-`shipping-options` für repräsentative Lanes cappturen (DE-Brief ≤0,5kg, DE-Paket 2/15kg, EU-Paket FR/IT, Nicht-Zone GR, Übersee US) und die exakten v3-Basis-Codes für die ⚠️-Produkte pinnen — insbesondere Großbrief, Warensendung (existiert `dp:warensendung`?), Maxibrief, DHL Paket International (EU `europaket` vs. Welt `weltpaket`). Read-only Script `backend/scripts/probe-shipping-options.js`.
- Katalog-Codes final eintragen, dann Resolver + Endpoint + FE.

## 13. Rollout & Sicherheit

- **Feature-Flag** `PACK_CURATED_SHIPPING` (default `false`): neuer Options-Flow nur bei `true`. Erlaubt Dark-Deploy + Owner-Test, bevor der alte Flow ersetzt wird. Flip nach Abnahme.
- Yellow-Zone-Dateien (`routes/orders.js`, `api/client.ts`, `MobileOperationsView`, `OrderDetail`) → additive Änderungen, alter Pfad bleibt hinter dem Flag lauffähig.
- `cd backend && npm test` + `npm run build` grün vor jedem Commit. Ein Branch/PR, Owner-Abnahme vor Prod-Flip.

## 14. Risiken

- **v3-Code-Unsicherheit** (Warensendung/Großbrief/DHL-Paket-Int): mitigiert durch Schritt 0 (Live-Capture) vor Katalog-Finalisierung.
- **Büchersendung-Altlast:** vergangene Großbrief/Warensendung-Sendungen liefen als `dp:buchersendung` — Compliance-Risiko der Vergangenheit; der Umbau stoppt es nach vorn. Kein Rück-Reparatur-Scope hier.
- **Sammel-Versand-Verhalten** ändert sich (Regel → Katalog) — separat testen; ggf. hinter demselben Flag.
