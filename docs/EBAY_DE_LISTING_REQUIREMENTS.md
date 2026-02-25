# eBay.de Angebotsanforderungen & Best Practices (Quelle → AvyCloud Datasheet)

Ziel dieses Dokuments: **AvyCloud Datasheet‑Regeln sollen direkt aus eBay‑Quellen abgeleitet sein** (keine erfundenen Regeln). Jede Regel ist deshalb mit einer **offiziellen eBay‑Quelle** verlinkt und einer **AvyCloud‑Datenfeld‑Zuordnung** versehen.

> Begriffe: eBay nennt Artikelmerkmale auch **Item Specifics**/**Aspects**. In AvyCloud entspricht das primär `details.attributes`.

## 1) Titel (Listing Title) → `identification.name`

- **Hard**: eBay empfiehlt die **vollen 80 Zeichen** sinnvoll zu nutzen (und es gibt praktisch ein 80‑Zeichen‑Limit).
  - Quelle: `https://www.ebay.de/help/selling/listings/listing-tips/optimising-listings-best-match?id=4166`
- **Best Practice**: Titel klar, prägnant, fehlerfrei; relevante Suchbegriffe, die Käufer wirklich nutzen.
  - Quelle (Beispiel‑Titel + Suchbegriffe): `https://www.ebay.de/verkaeuferportal/angebote/optimieren/seo`
- **Hard/Policy**: Keine **artikelfremden, beliebten Keywords** oder irreführende Taktiken zur Manipulation von Suche/Browse.
  - Quelle: `https://www.ebay.de/help/policies/listing-policies/search-browse-manipulation-policy?id=4243`

## 2) Kategorie → `details.categoryId` (ID) + `identification.category` (Breadcrumb)

- **Hard**: Ein Angebot muss in einer passenden Kategorie eingestellt werden; viele Käufer filtern nach Kategorie.
  - Quelle: `https://www.ebay.de/help/selling/listings/creating-managing-listings/adding-category-listing?id=4149`
- **Hard/Policy‑nah**: Bei falscher Kategorie kann eBay die Kategorie ändern (Sichtbarkeit/Ranking leidet).
  - Quelle: `https://www.ebay.de/help/selling/listings/creating-managing-listings/adding-category-listing?id=4149`
- **Developer (für “valid/leaf categoryId”)**: Taxonomy API unterstützt die Auswahl der passenden Kategorie; falsche Kategorie kann Sichtbarkeit stark schädigen.
  - Quelle: `https://developer.ebay.com/api-docs/commerce/taxonomy/overview.html`

## 3) Artikelmerkmale / Item Specifics / Aspects → `details.attributes`

- **Hard (in vielen Kategorien)**: Artikelmerkmale sind **Pflicht** (kategorieabhängig) und zentral für Auffindbarkeit (Filter/Mobile).
  - Quelle: `https://www.ebay.de/verkaeuferportal/angebote/optimieren/artikelmerkmale`
- **Best Practice**: Möglichst viele relevante Merkmale hinterlegen (“je mehr Daten, desto bessere Sichtbarkeit”).
  - Quelle: `https://www.ebay.de/verkaeuferportal/angebote/optimieren/artikelmerkmale`
- **Hard (technisch für Listing‑APIs)**: Required Aspects je Leaf‑Kategorie über Taxonomy `getItemAspectsForCategory` ermitteln und befüllen.
  - Quelle: `https://developer.ebay.com/api-docs/commerce/taxonomy/resources/category_tree/methods/getItemAspectsForCategory`
- **Best Practice (Developer)**: Standardisierte/empfohlene Item Specific Names/Values nutzen; Required Aspects kommen zuerst im Response.
  - Quelle: `https://developer.ebay.com/api-docs/user-guides/static/trading-user-guide/item-specifics-names-values.html`

## 4) Beschreibung / Textfelder → `details.short_description` / `details.description`

- **Best Practice**: Beschreibung so schreiben, dass Käufer beim Überfliegen alles Wesentliche verstehen, aber auch Details finden.
  - Quelle: `https://www.ebay.de/help/selling/listings/ein-angebot-erstellen?id=4105`
- **Mobile‑Kontext (Best Practice)**: eBay nutzt für Mobilgeräte eine Kurzbeschreibung/Preview (relevant: “wichtigste Infos früh”).
  - Quelle: `https://www.ebay.de/help/selling/listings/ein-angebot-erstellen?id=4105`
- **Hard/Policy**: Kein **aktiver Inhalt** (z.B. JavaScript/Flash/Formulare) in textbasierten Feldern wie Beschreibung.
  - Quelle: `https://www.ebay.de/help/policies/listing-policies/grundsatz-zur-verwendung-von-skriptsprachen?id=4247`
- **Hard/Policy**: Keine Inhalte, die Käufer von eBay **weglenken** (Kontaktinfos/URLs/Links/Aufforderungen zu Off‑eBay‑Transaktionen).
  - Quelle: `https://www.ebay.de/help/policies/listing-policies/grundsatz-zur-nutzung-von-bildern-videos-und-anderen-inhalten?id=4240`

## 5) Bilder → `details.images[]`

- **Hard**: eBay‑Angebote müssen mindestens **1 Bild** haben; bis zu 24 Bilder möglich.
  - Quelle: `https://www.ebay.de/help/selling/listings/bilder-zu-angeboten-hinzufgen?id=4148&ra=true`
- **Best Practice**: Scharf, neutraler Hintergrund, Mängel zeigen, mehrere Perspektiven; Hauptfoto zeigt Artikel vollständig.
  - Quelle: `https://www.ebay.de/help/selling/listings/bilder-zu-angeboten-hinzufgen?id=4148&ra=true`
  - Ergänzend (Verkäuferportal Foto‑Tipps): `https://www.ebay.de/verkaeuferportal/angebote/foto-tipps`
- **Hard/Policy**: Keine Wasserzeichen/Badges/Logos/Urheberrechtshinweise; keine schlechten/verschwommenen Bilder.
  - Quelle: `https://www.ebay.de/help/selling/listings/bilder-zu-angeboten-hinzufgen?id=4148&ra=true`
  - Quelle (Content‑Policy allgemein): `https://www.ebay.de/help/policies/listing-policies/grundsatz-zur-nutzung-von-bildern-videos-und-anderen-inhalten?id=4240`
- **Hard**: Bei gebrauchten Artikeln keine Katalog-/Standardbilder als Hauptbild.
  - Quelle: `https://www.ebay.de/help/selling/listings/bilder-zu-angeboten-hinzufgen?id=4148&ra=true`

## 6) Preis → `details.pricing`

- **Best Practice**: Preis über Vergleich mit ähnlichen (auch beendeten) Angeboten festlegen; wettbewerbsfähig sein.
  - Quelle: `https://www.ebay.de/help/selling/getting-started-selling/pricing-items?id=4133&ra=true`
- **Developer (Evidence‑Quelle)**: Browse API `item_summary/search` liefert `price` + `itemWebUrl` (geeignet als Evidence‑URLs).
  - Quelle: `https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search`
  - Filter‑Syntax (z.B. price range, conditionIds): `https://developer.ebay.com/api-docs/buy/static/ref-buy-browse-filters.html`

## 7) Produktkennzeichnungen (EAN/GTIN/MPN/ISBN/UPC) → `details.identifiers` + `identification.barcodes`

- **Hard (kategorieabhängig)**: In manchen Kategorien sind Produktkennzeichnungen Pflicht (inkl. Validierungslogik, „Nicht zutreffend“).
  - Quelle: `https://www.ebay.de/help/selling/listings/ein-angebot-erstellen?id=4105`
- **Developer**: Suche/Abgleich über Browse `gtin` oder Taxonomy/Aspects, um Daten konsistent zu halten.
  - Quelle: `https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search`
  - Quelle: `https://developer.ebay.com/api-docs/commerce/taxonomy/overview.html`

## 8) eBay Katalog‑Inhalte (Produktdetails/Standardbilder) → optional, aber korrekt

- **Policy‑nah**: eBay‑Katalogdaten dürfen genutzt werden, aber **nur wenn das Katalog‑Produkt exakt dem Artikel entspricht**; sonst Policy‑Verstoß (“Manipulation von Suchergebnissen”).
  - Quelle: `https://www.ebay.de/help/listings/creating-managing-listings/listing-item-product-details-catalog?id=4653`
  - Cross‑link (Manipulation Policy): `https://www.ebay.de/help/policies/listing-policies/search-browse-manipulation-policy?id=4243`

## Umsetzung in AvyCloud (Kurzfassung)

- **Hard‑Checks (blockierend für Sync/Listing, nicht zwingend für Draft‑Save)**: gültige Kategorie‑ID (leaf), required aspects nicht leer, mind. 1 Bild, Titel ≤ 80, keine aktiven Inhalte/Off‑eBay‑Links.
- **Best‑Practice‑Checks (Warnungen/Score)**: Titel nutzt 80 Zeichen sinnvoll, viele relevante attributes, gute Bilder, wettbewerbsfähiger Preis, “wichtige Infos früh” (mobile).

