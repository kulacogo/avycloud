# Repo Cruft Audit — 2026-05-18

Repo root: `/Users/oguz/Dev/avycloud`
Total findings: 3592

## backup-legacy (2)

| Path | Type | Size | LastModified | Suggested-Action | Reason |
|------|------|------|--------------|------------------|--------|
| archive/uiv2/backend/services/enrichment_backup.js | backup-legacy | 42.9KB | 2026-01-30 | DELETE | Backup file (_backup) |
| backend/services/enrichment_backup.js | backup-legacy | 43.4KB | 2026-05-10 | DELETE | Backup file (_backup) |

## baselinker-script (24)

| Path | Type | Size | LastModified | Suggested-Action | Reason |
|------|------|------|--------------|------------------|--------|
| backend/scripts/add-ebay-categories-to-inventory.js | baselinker-script | 4.4KB | 2026-03-13 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/backfill-baselinker-orders.js | baselinker-script | 9.2KB | 2026-03-14 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/backfill-kaufland-marketplace-id.js | baselinker-script | 2.8KB | 2026-03-15 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/check-bl-order-fields.js | baselinker-script | 2.4KB | 2026-03-16 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/check-current-dupes.js | baselinker-script | 2.5KB | 2026-03-17 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/check-dupes-and-counts.js | baselinker-script | 1.7KB | 2026-03-16 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/check-kaufland-dupes.js | baselinker-script | 1.8KB | 2026-03-15 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/check-orders-now.js | baselinker-script | 1.9KB | 2026-03-15 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/check-todays-dupes2.js | baselinker-script | 1.9KB | 2026-03-15 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/delete-remaining-bl-ebay.js | baselinker-script | 3.7KB | 2026-03-15 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/export-inventory-categories.js | baselinker-script | 246B | 2026-03-13 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/find-all-bl-ebay-dupes.js | baselinker-script | 1.9KB | 2026-03-17 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/find-bl-dupes.js | baselinker-script | 1008B | 2026-03-17 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/find-order-dupes.js | baselinker-script | 1.6KB | 2026-03-17 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/fix-bl-storniert-orders.js | baselinker-script | 2.5KB | 2026-03-16 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/fix-source-field.js | baselinker-script | 1.0KB | 2026-03-15 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/generate-ebay-map.js | baselinker-script | 7.4KB | 2026-03-13 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/inspect-bl-order.js | baselinker-script | 1.3KB | 2026-03-15 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/inspect-kl-order.js | baselinker-script | 939B | 2026-03-15 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/inspect-kl-raw.js | baselinker-script | 989B | 2026-03-15 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/inspect-new-dup.js | baselinker-script | 1.5KB | 2026-03-17 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/investigate-issues.js | baselinker-script | 3.4KB | 2026-03-16 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/purge-all-bl-orders.js | baselinker-script | 1.3KB | 2026-03-17 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |
| backend/scripts/remove-bl-ebay-duplicates.js | baselinker-script | 6.6KB | 2026-03-15 | DELETE | BaseLinker is TABU (CLAUDE.md rule #9) |

## binary-doc (634)

| Path | Type | Size | LastModified | Suggested-Action | Reason |
|------|------|------|--------------|------------------|--------|
| ~$yCloud_Analyse_Marktbewertung_2026-03-17.docx | binary-doc | 162B | 2026-03-20 | ARCHIVE | Binary doc (.docx) |
| ~$yCloud_Marktanalyse_MultiChannel.docx | binary-doc | 162B | 2026-03-19 | ARCHIVE | Binary doc (.docx) |
| 04_baselinker_categories.xlsx | binary-doc | 554.9KB | 2026-02-06 | ARCHIVE | Binary doc (.xlsx) |
| 2022_September_Kategorien_mit_Fahrzeugdaten_202301.xlsx | binary-doc | 164.1KB | 2026-01-16 | ARCHIVE | Binary doc (.xlsx) |
| all ebay kategorien mit struktur.csv | binary-doc | 507.0KB | 2026-02-08 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/04_baselinker_categories.xlsx | binary-doc | 554.9KB | 2026-02-06 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/2022_September_Kategorien_mit_Fahrzeugdaten_202301.xlsx | binary-doc | 164.1KB | 2026-01-16 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/all ebay kategorien mit struktur.csv | binary-doc | 507.0KB | 2026-02-08 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/backend/ebay/DE_New_Structure_(May2023).csv | binary-doc | 729.7KB | 2025-12-11 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/backend/exports/baselinker-inventory-categories-78659-2026-02-08T01-03-01-345Z.csv | binary-doc | 1.25MB | 2026-02-08 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/backend/exports/baselinker-inventory-categories-91387-2026-02-07T09-25-17-593Z.csv | binary-doc | 1.25MB | 2026-02-07 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/backend/exports/baselinker-inventory-categories-91388-2026-02-07T09-25-20-859Z.csv | binary-doc | 680.3KB | 2026-02-07 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/backend/exports/gpsr-audit/gpsr-variance-20260201-122100.csv | binary-doc | 214B | 2026-02-01 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/backend/exports/gpsr-coverage/gpsr-coverage-report-20260131-125845.csv | binary-doc | 26.4KB | 2026-01-31 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/backend/exports/gpsr-coverage/gpsr-coverage-report-20260131-134632.csv | binary-doc | 24.9KB | 2026-01-31 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/backend/exports/gpsr-coverage/gpsr-missing-required-20260131-180258.csv | binary-doc | 22.0KB | 2026-01-31 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/backend/exports/hood/categories-hood.csv | binary-doc | 2.05MB | 2026-01-30 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/backend/exports/marketplace-params/marketplace-params-by-category-20260131-010756.csv | binary-doc | 1.22MB | 2026-01-31 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/backend/exports/marketplace-params/marketplace-params-by-category-20260131-010915.csv | binary-doc | 1.30MB | 2026-01-31 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/backend/exports/title-normalize/20260120-002424/dryrun_rows.csv | binary-doc | 2.0KB | 2026-01-19 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/backend/kaufland/attribute_values_all_languages.csv | binary-doc | 1.19MB | 2025-12-11 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/backend/kaufland/category_tree_all_languages.csv | binary-doc | 4.07MB | 2025-12-11 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/Base.com - online sales management.pdf | binary-doc | 2.47MB | 2026-02-01 | ARCHIVE | Binary doc (.pdf) |
| archive/uiv2/Bericht zur Angebotsqualität für trendocean - DE - 29.01.2026 03-32 MEZ.xlsx | binary-doc | 180.7KB | 2026-01-31 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/BL__Products__default_CSV_2025-12-17_18_28.csv | binary-doc | 281.7KB | 2025-12-17 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/bl_nventory_cat.xlsx | binary-doc | 692.0KB | 2026-02-06 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/categories-hood.csv | binary-doc | 202.6KB | 2026-01-30 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/Cloud Run – avycloud – Google Cloud Console.pdf | binary-doc | 383.5KB | 2025-11-16 | ARCHIVE | Binary doc (.pdf) |
| archive/uiv2/DE_Motorradliste_2025_06.xlsx | binary-doc | 3.17MB | 2026-01-27 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/DE_MVL_2025_10.xlsx | binary-doc | 3.94MB | 2026-01-27 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/docs/rulebook/Highlights_Regeln.csv | binary-doc | 5.3KB | 2026-01-28 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/docs/rulebook/Titel_Regeln.csv | binary-doc | 3.5KB | 2026-01-28 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/ebay/aktuelle_artikelmerkmale_radsport.xlsx | binary-doc | 259.3KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/alle ebay kategorien.xlsx | binary-doc | 352.2KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/artikelmerkmale_agrar_forst_kommune.xlsx | binary-doc | 45.8KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/artikelmerkmale_baugewerbe.xlsx | binary-doc | 38.7KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/artikelmerkmale_buero_schreibwaren.xlsx | binary-doc | 148.7KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/artikelmerkmale_camping_outdoor.xlsx | binary-doc | 145.3KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/artikelmerkmale_fitness_jogging.xlsx | binary-doc | 218.6KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/artikelmerkmale_gastro_nahrungsmittel.xlsx | binary-doc | 451.2KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/artikelmerkmale_transport_logistik.xlsx | binary-doc | 95.9KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/verpflichtende_artikelmerkmale_auto_motorradteile_24.10.2023.xlsx | binary-doc | 28.4KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/verpflichtende_artikelmerkmale_beauty_gesundheit_juli_2022.xlsx | binary-doc | 9.0KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/verpflichtende_artikelmerkmale_business_industrie_juli_2022.xlsx | binary-doc | 9.0KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/verpflichtende_artikelmerkmale_elektronik_2020.xlsx | binary-doc | 81.6KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/verpflichtende_artikelmerkmale_fashion_22022021.xlsx | binary-doc | 31.5KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/verpflichtende_artikelmerkmale_foto_camcorder_juli_2022.xlsx | binary-doc | 9.0KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/verpflichtende_artikelmerkmale_haus_garten_juli_2022.xlsx | binary-doc | 20.6KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/verpflichtende_artikelmerkmale_medien_12072021.xlsx | binary-doc | 10.5KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/verpflichtende_artikelmerkmale_modellbau_februar_2022.xlsx | binary-doc | 11.3KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/Verpflichtende_Artikelmerkmale_Moebel_Wohnen_Dekoration_Februar 2023.xlsx | binary-doc | 12.0KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/verpflichtende_artikelmerkmale_musikinstrumente_februar_2022.xlsx | binary-doc | 12.2KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/Verpflichtende_Artikelmerkmale_Schmuck_September 2022.xlsx | binary-doc | 8.7KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/verpflichtende_artikelmerkmale_spielzeug_februar_2022.xlsx | binary-doc | 10.2KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/verpflichtende_artikelmerkmale_sport_februar_2022.xlsx | binary-doc | 18.8KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/ebay/verpflichtende_artikelmerkmale_sport_juli_2022.xlsx | binary-doc | 10.4KB | 2026-01-14 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/exports/audit/20260105-033109/audit_rows.csv | binary-doc | 79.6KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/audit/20260105-041357/audit_rows.csv | binary-doc | 82.1KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/audit/20260105-050524/audit_rows.csv | binary-doc | 83.1KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/audit/20260105-051305/audit_rows.csv | binary-doc | 85.5KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/audit/20260105-100641/audit_rows.csv | binary-doc | 84.8KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/audit/20260105-101826/audit_rows.csv | binary-doc | 81.7KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/audit/20260105-141151/audit_rows.csv | binary-doc | 81.7KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/audit/20260105-160127/audit_rows.csv | binary-doc | 81.0KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/audit/20260105-160626/audit_rows.csv | binary-doc | 81.0KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/audit/20260105-160919/audit_rows.csv | binary-doc | 81.0KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/audit/20260105-194142/audit_rows.csv | binary-doc | 81.4KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/audit/20260107-023937/audit_rows.csv | binary-doc | 81.1KB | 2026-01-07 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/avy-taxonomy/avy-taxonomy.csv | binary-doc | 19.5KB | 2026-02-03 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/avy-taxonomy/pruned2/avy-taxonomy.csv | binary-doc | 11.6KB | 2026-02-03 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/avy-taxonomy/pruned3/avy-taxonomy.csv | binary-doc | 11.5KB | 2026-02-03 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/avystock_channable_import.csv | binary-doc | 1.49MB | 2026-01-20 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/avystock_shopify_import.csv | binary-doc | 1.04MB | 2026-01-20 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/barcode-web-impact/20260107-050254/impact_report.csv | binary-doc | 8.6KB | 2026-01-07 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/barcode-web-impact/20260107-050449/impact_report.csv | binary-doc | 13.3KB | 2026-01-07 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-allowed-categories-from-mapping.csv | binary-doc | 16.3KB | 2026-02-03 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-audit/2026-01-29T23-58-34-263Z/rows.csv | binary-doc | 122.3KB | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-audit/2026-01-29T23-58-58-213Z/rows.csv | binary-doc | 122.3KB | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-audit/2026-01-29T23-59-23-186Z/rows.csv | binary-doc | 122.3KB | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-audit/latest/rows.csv | binary-doc | 122.3KB | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/2026-01-29T22-09-22-311Z/matches.csv | binary-doc | 283B | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/2026-01-29T22-09-22-311Z/mismatches.csv | binary-doc | 145.6KB | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/2026-01-29T22-09-22-311Z/missing_in_avycloud.csv | binary-doc | 166B | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/2026-01-29T22-09-22-311Z/missing_in_baselinker.csv | binary-doc | 694B | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/2026-01-29T22-10-53-939Z/matches.csv | binary-doc | 283B | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/2026-01-29T22-10-53-939Z/mismatches.csv | binary-doc | 145.4KB | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/2026-01-29T22-10-53-939Z/missing_in_avycloud.csv | binary-doc | 166B | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/2026-01-29T22-10-53-939Z/missing_in_baselinker.csv | binary-doc | 694B | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/2026-01-29T22-13-20-995Z/matches.csv | binary-doc | 187.1KB | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/2026-01-29T22-13-20-995Z/mismatches.csv | binary-doc | 305B | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/2026-01-29T22-13-20-995Z/missing_in_avycloud.csv | binary-doc | 166B | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/2026-01-29T22-13-20-995Z/missing_in_baselinker.csv | binary-doc | 694B | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/2026-01-29T22-50-04-185Z/matches.csv | binary-doc | 177.6KB | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/2026-01-29T22-50-04-185Z/mismatches.csv | binary-doc | 301B | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/2026-01-29T22-50-04-185Z/missing_in_avycloud.csv | binary-doc | 166B | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/2026-01-29T22-50-04-185Z/missing_in_baselinker.csv | binary-doc | 694B | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/latest/matches.csv | binary-doc | 177.6KB | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/latest/mismatches.csv | binary-doc | 301B | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/latest/missing_in_avycloud.csv | binary-doc | 166B | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-category-compare/latest/missing_in_baselinker.csv | binary-doc | 694B | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-import/2026-01-29T21-15-02-023Z/products-part01.csv | binary-doc | 414.4KB | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-import/2026-01-29T21-23-21-099Z/products-part01.csv | binary-doc | 1.15MB | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-import/2026-01-29T21-24-18-523Z/products-part01.csv | binary-doc | 1.15MB | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-import/2026-01-29T21-27-04-960Z/products-part01.csv | binary-doc | 1.71MB | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-import/2026-01-29T21-27-04-960Z/products-part02.csv | binary-doc | 1.71MB | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-import/2026-01-29T21-27-04-960Z/products-part03.csv | binary-doc | 1.71MB | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-import/2026-01-29T21-27-04-960Z/products-part04.csv | binary-doc | 1.71MB | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-import/2026-01-29T21-27-04-960Z/products-part05.csv | binary-doc | 388.0KB | 2026-01-29 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-02T19-16-12-972Z.csv | binary-doc | 122.5KB | 2026-02-02 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-02T19-46-02-530Z.csv | binary-doc | 108.0KB | 2026-02-02 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-02T19-51-59-865Z-consolidated.csv | binary-doc | 107.0KB | 2026-02-02 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-02T19-51-59-865Z-consolidation-map.csv | binary-doc | 157.1KB | 2026-02-02 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-02T19-51-59-865Z.csv | binary-doc | 104.1KB | 2026-02-02 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-03T01-26-23-061Z-consolidated.csv | binary-doc | 105.9KB | 2026-02-03 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-03T01-26-23-061Z-consolidation-map.csv | binary-doc | 152.3KB | 2026-02-03 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-03T01-26-23-061Z-semantic-duplicates.csv | binary-doc | 16.6KB | 2026-02-03 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-03T01-26-23-061Z.csv | binary-doc | 101.4KB | 2026-02-03 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-03T01-29-21-978Z-semantic-duplicates.csv | binary-doc | 16.6KB | 2026-02-03 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-03T01-29-21-978Z.csv | binary-doc | 101.4KB | 2026-02-03 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-03T01-30-53-414Z.csv | binary-doc | 99.9KB | 2026-02-03 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-03T01-32-04-673Z.csv | binary-doc | 99.8KB | 2026-02-03 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-repair/2026-01-30T00-05-23-665Z/report.csv | binary-doc | 23.0KB | 2026-01-30 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-repair/2026-01-30T00-07-09-328Z/report.csv | binary-doc | 24.9KB | 2026-01-30 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-repair/2026-01-30T00-07-35-167Z/report.csv | binary-doc | 24.9KB | 2026-01-30 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-repair/latest/report.csv | binary-doc | 24.9KB | 2026-01-30 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-sync/20260114-200604/products.csv | binary-doc | 67.2KB | 2026-01-14 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-sync/20260114-200615/products.csv | binary-doc | 67.2KB | 2026-01-14 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-sync/20260114-214750/products.csv | binary-doc | 67.2KB | 2026-01-14 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-sync/20260114-220010/products.csv | binary-doc | 67.2KB | 2026-01-14 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-sync/20260115-033326/products.csv | binary-doc | 67.1KB | 2026-01-15 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-sync/20260115-034136/products.csv | binary-doc | 67.1KB | 2026-01-15 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-sync/20260115-104811/products.csv | binary-doc | 67.0KB | 2026-01-15 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-sync/20260116-104304/products.csv | binary-doc | 67.0KB | 2026-01-16 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-sync/20260116-165047/products.csv | binary-doc | 67.0KB | 2026-01-16 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-sync/20260116-221535/products.csv | binary-doc | 67.1KB | 2026-01-16 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-sync/20260122-205508/products.csv | binary-doc | 86.7KB | 2026-01-22 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-sync/20260122-205522/products.csv | binary-doc | 86.7KB | 2026-01-22 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-sync/20260122-235606/products.csv | binary-doc | 86.7KB | 2026-01-22 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/baselinker-sync/20260123-000308/products.csv | binary-doc | 86.7KB | 2026-01-22 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/Bericht zur Angebotsqualität für trendocean - DE - 07.01.2026 03-32 MEZ.xlsx | binary-doc | 182.6KB | 2026-01-16 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/exports/bin_mismatches.csv | binary-doc | 94B | 2025-12-24 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/BL products.csv | binary-doc | 29.9KB | 2025-12-24 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/brand-normalize/20260115-112703/rows.csv | binary-doc | 408B | 2026-01-15 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/brand-normalize/20260115-113101/rows.csv | binary-doc | 5.1KB | 2026-01-15 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/category_review_remaining_20260105-192227.csv | binary-doc | 16.6KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/category_review_root_mismatches_20260122-032218.csv | binary-doc | 66.6KB | 2026-01-22 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/category_review_root_mismatches_20260122-055412.csv | binary-doc | 31.1KB | 2026-01-22 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/category_review_root_mismatches_20260122-060240.csv | binary-doc | 55.5KB | 2026-01-22 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/category_review_root_mismatches_20260122-061010.csv | binary-doc | 27.1KB | 2026-01-22 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/category_review_root_mismatches_latest.csv | binary-doc | 62.7KB | 2026-01-22 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/category_review_suspicious_roots__suggested_20260105-134822.csv | binary-doc | 40.2KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/category_review_suspicious_roots__suggested_20260105-192241.csv | binary-doc | 43.8KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/category_review_suspicious_roots_20260105-120301__autofilled.csv | binary-doc | 26.1KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/category_review_suspicious_roots_20260105-120301__llm_suggested_smoketest2.csv | binary-doc | 20.2KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/category_review_suspicious_roots_20260105-120301__llm_suggested_smoketest3.csv | binary-doc | 20.2KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/category_review_suspicious_roots_20260105-120301__llm_suggested_smoketest4.csv | binary-doc | 20.1KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/category_review_suspicious_roots_20260105-120301__llm_suggested_smoketest5.csv | binary-doc | 20.2KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/category_review_suspicious_roots_20260105-120301__llm_suggested_smoketest6.csv | binary-doc | 20.2KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/category_review_suspicious_roots_20260105-120301__llm_suggested.csv | binary-doc | 20.2KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/category_review_suspicious_roots_20260105-120301.csv | binary-doc | 16.0KB | 2026-01-05 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/condition_audit/20260108-213405/zustand_used.csv | binary-doc | 6.4KB | 2026-01-08 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/condition_audit/20260108-214448/zustand_used.csv | binary-doc | 6.6KB | 2026-01-08 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/DE_MVL_2025_10.decrypted.xlsx | binary-doc | 3.87MB | 2026-01-16 | ARCHIVE | Binary doc (.xlsx) |
| archive/uiv2/exports/firestore/baselinker_sku_index.csv | binary-doc | 33.1KB | 2025-12-24 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/firestore/identificationJobs.csv | binary-doc | 4.43MB | 2025-12-24 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/firestore/improveJobs.csv | binary-doc | 16.48MB | 2025-12-24 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/firestore/inventories.csv | binary-doc | 3.4KB | 2025-12-24 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/firestore/inventorySyncLogs.csv | binary-doc | 259.3KB | 2025-12-24 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/firestore/orders.csv | binary-doc | 188.6KB | 2025-12-24 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/firestore/products.csv | binary-doc | 2.81MB | 2025-12-24 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/firestore/trendocean.csv | binary-doc | 139B | 2025-12-24 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/firestore/warehouseBins.csv | binary-doc | 120.8KB | 2025-12-24 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/firestore/warehouseZones.csv | binary-doc | 339B | 2025-12-24 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/identify_audit/20260108-222309/not_ebay_ready.csv | binary-doc | 17.6KB | 2026-01-08 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-categories-id-breadcrumb-20260208-032927.csv | binary-doc | 997.5KB | 2026-02-08 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-categories-id-breadcrumb-20260208-033005.csv | binary-doc | 997.5KB | 2026-02-08 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-categories-id-breadcrumb-ebay-mapped-20260208-032927.csv | binary-doc | 1008.7KB | 2026-02-08 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-categories-id-breadcrumb-ebay-mapped-20260208-033005.csv | binary-doc | 1.04MB | 2026-02-08 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-categories-id-breadcrumb-ebay-mapped-only-20260208-032927.csv | binary-doc | 555B | 2026-02-08 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-categories-id-breadcrumb-ebay-mapped-only-20260208-033005.csv | binary-doc | 1011.1KB | 2026-02-08 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-categories-id-breadcrumb-ebay-unmapped-20260208-033005.csv | binary-doc | 54.7KB | 2026-02-08 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-categories-id-breadcrumb-kaufland-mapped-20260208-040426.csv | binary-doc | 1008.6KB | 2026-02-08 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-categories-id-breadcrumb-kaufland-mapped-only-20260208-040426.csv | binary-doc | 45B | 2026-02-08 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-categories-id-breadcrumb-kaufland-mapped-suffix-20260208-040759.csv | binary-doc | 1.05MB | 2026-02-08 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-categories-id-breadcrumb-kaufland-mapped-suffix-only-20260208-040759.csv | binary-doc | 182.0KB | 2026-02-08 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-categories-id-breadcrumb-kaufland-unmapped-20260208-040426.csv | binary-doc | 1.07MB | 2026-02-08 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-categories-id-breadcrumb-kaufland-unmapped-suffix-20260208-040759.csv | binary-doc | 947.5KB | 2026-02-08 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-categories-list.csv | binary-doc | 73.0KB | 2026-02-03 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-categories-used.csv | binary-doc | 16.7KB | 2026-02-03 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-marketplace-category-low-confidence.csv | binary-doc | 32.3KB | 2026-02-03 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-marketplace-category-suggestions.csv | binary-doc | 84.3KB | 2026-02-03 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-title-findings.csv | binary-doc | 17.5KB | 2026-02-03 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-titles-list.csv | binary-doc | 35.0KB | 2026-02-03 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/inventory-78659-titles-with-categories.csv | binary-doc | 56.7KB | 2026-02-03 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/Main_2026-01-20_05_00_2_import_long.csv | binary-doc | 1.65MB | 2026-01-20 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/Main_2026-01-20_05_00_2_import.csv | binary-doc | 1.47MB | 2026-01-20 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/Main_2026-01-20_05_00_2_shopify_import.csv | binary-doc | 1.64MB | 2026-01-20 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/offer-quality-trendocean-20260107-0332/category_summary.csv | binary-doc | 440B | 2026-01-16 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/offer-quality-trendocean-20260107-0332/google_shopping_rejected.csv | binary-doc | 884B | 2026-01-16 | ARCHIVE | Binary doc (.csv) |
| archive/uiv2/exports/offer-quality-trendocean-20260107-0332/offers_long.csv | binary-doc | 10.6KB | 2026-01-16 | ARCHIVE | Binary doc (.csv) |
| ... | | | | | 434 more (truncated) |

## html-asset (13)

| Path | Type | Size | LastModified | Suggested-Action | Reason |
|------|------|------|--------------|------------------|--------|
| AvyCloud_KnowledgeBase.html | html-asset | 55.4KB | 2026-03-10 | ARCHIVE | HTML in . |
| dashboard.html | html-asset | 95.4KB | 2026-03-01 | ARCHIVE | HTML in . |
| ebay-template-preview.html | html-asset | 8.1KB | 2026-04-07 | ARCHIVE | HTML in . |
| enrichment-rules.html | html-asset | 73.5KB | 2026-05-10 | ARCHIVE | HTML in . |
| index.html | html-asset | 1.1KB | 2026-03-13 | ARCHIVE | HTML in . |
| Marketplace_Taxonomy_Masterplan.html | html-asset | 71.2KB | 2026-03-10 | ARCHIVE | HTML in . |
| oms-audit-report.html | html-asset | 59.7KB | 2026-03-15 | ARCHIVE | HTML in . |
| prototype.html | html-asset | 100.9KB | 2026-03-05 | ARCHIVE | HTML in . |
| template.html | html-asset | 13.9KB | 2025-11-30 | ARCHIVE | HTML in . |
| ui-mockup-mobile.html | html-asset | 29.9KB | 2026-03-04 | ARCHIVE | HTML in . |
| ui-mockup.html | html-asset | 41.1KB | 2026-03-04 | ARCHIVE | HTML in . |
| ui-theme-alternatives.html | html-asset | 31.1KB | 2026-03-04 | ARCHIVE | HTML in . |
| versandkarton-empfehlung.html | html-asset | 14.7KB | 2026-03-27 | ARCHIVE | HTML in . |

## large-file (2872)

| Path | Type | Size | LastModified | Suggested-Action | Reason |
|------|------|------|--------------|------------------|--------|
| api/client.ts | large-file | 196.5KB | 2026-05-17 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/api/client.ts | large-file | 101.8KB | 2026-02-27 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/backend/data/ebay-categories.json | large-file | 696.2KB | 2025-12-12 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/backend/data/kaufland-categories.json | large-file | 670.3KB | 2025-12-12 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/backend/ebay-data/categories.json | large-file | 2.76MB | 2025-12-26 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/backend/ebay-data/required-aspects.json | large-file | 217.9KB | 2025-11-24 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/backend/exports/baselinker-dual-sync/20260207-112431/results-all.json | large-file | 112.2KB | 2026-02-07 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/backend/exports/baselinker-dual-sync/20260207-113721/results-all.json | large-file | 107.0KB | 2026-02-07 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/backend/exports/baselinker-inventory-categories-78659-2026-02-08T01-03-01-345Z.json | large-file | 2.26MB | 2026-02-08 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/backend/exports/baselinker-inventory-categories-91387-2026-02-07T09-25-17-593Z.json | large-file | 2.26MB | 2026-02-07 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/backend/exports/baselinker-inventory-categories-91388-2026-02-07T09-25-20-859Z.json | large-file | 1.21MB | 2026-02-07 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/backend/exports/hood/categories-hood.json | large-file | 2.90MB | 2026-01-30 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/backend/index.js | large-file | 205.6KB | 2026-02-27 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/backend/lib/firestore.js | large-file | 128.4KB | 2026-02-21 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/backend/package-lock.json | large-file | 157.3KB | 2026-02-14 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/backend/services/enrichment.js | large-file | 106.1KB | 2026-02-21 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/components/AdminTable.tsx | large-file | 107.2KB | 2026-02-27 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/downloaded-logs-20251226-222028.json | large-file | 812.7KB | 2025-12-26 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/avy-category-llm/20260203-041643/apply_report.json | large-file | 717.8KB | 2026-02-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/avy-category-llm/20260203-042824/apply_report.json | large-file | 723.2KB | 2026-02-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/barcode-cleanup/20260105-101724/dryrun_report.json | large-file | 282.3KB | 2026-01-05 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/baselinker-audit/2026-01-29T23-58-34-263Z/rows.json | large-file | 268.7KB | 2026-01-29 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/baselinker-audit/2026-01-29T23-58-58-213Z/rows.json | large-file | 268.7KB | 2026-01-29 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/baselinker-audit/2026-01-29T23-59-23-186Z/rows.json | large-file | 268.7KB | 2026-01-29 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/baselinker-inventory-78659-categories.json | large-file | 237.4KB | 2026-01-25 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/baselinker-inventory-91387-categories-created.json | large-file | 2.62MB | 2026-02-07 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/baselinker-inventory-91388-categories-created.json | large-file | 1.45MB | 2026-02-07 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-02T19-16-12-972Z.json | large-file | 247.3KB | 2026-02-02 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-02T19-46-02-530Z.json | large-file | 220.3KB | 2026-02-02 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-02T19-51-59-865Z-consolidated.json | large-file | 626.9KB | 2026-02-02 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-02T19-51-59-865Z.json | large-file | 211.5KB | 2026-02-02 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-03T01-26-23-061Z-consolidated.json | large-file | 611.1KB | 2026-02-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-03T01-26-23-061Z.json | large-file | 205.0KB | 2026-02-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-03T01-29-21-978Z.json | large-file | 205.0KB | 2026-02-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-03T01-30-53-414Z.json | large-file | 201.9KB | 2026-02-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/baselinker-inventory-categories-78659-2026-02-03T01-32-04-673Z.json | large-file | 201.7KB | 2026-02-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/bulk-improve-sync/20260201-022212/results.jsonl | large-file | 1.06MB | 2026-02-01 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/bulk-improve-sync/20260201-024634/results.jsonl | large-file | 944.2KB | 2026-02-01 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/category_review_suspicious_roots__suggested_20260105-134822.json | large-file | 279.4KB | 2026-01-05 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/category_review_suspicious_roots__suggested_20260105-192241.json | large-file | 302.4KB | 2026-01-05 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/category-backfill/20260122-032440/dryrun_report.json | large-file | 105.5KB | 2026-01-22 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/category-backfill/20260122-060217/dryrun_report.json | large-file | 105.5KB | 2026-01-22 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/category-normalize/20260105-034906/dryrun_report.json | large-file | 165.0KB | 2026-01-05 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/category-normalize/20260105-035028/dryrun_report.json | large-file | 165.0KB | 2026-01-05 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/channable_example_csv.png | large-file | 191.5KB | 2026-01-20 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/cleanup/20260105-031612/dryrun_report.json | large-file | 723.3KB | 2026-01-05 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/cleanup/20260105-031733/dryrun_report.json | large-file | 230.3KB | 2026-01-05 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/DE_Motorradliste_2025_06.compact.jsonl | large-file | 5.65MB | 2026-01-27 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/DE_MVL_2025_10.compact.jsonl | large-file | 9.69MB | 2026-01-16 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/products_with_bins_qty_ge1.json | large-file | 5.83MB | 2026-01-17 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/reconciliation/attribute-keys-audit_20260122-024128.json | large-file | 1.37MB | 2026-01-22 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/reconciliation/attribute-keys-audit_20260122-055344.json | large-file | 634.7KB | 2026-01-22 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/reconciliation/category-profiles-draft_20260122-030156.json | large-file | 200.0KB | 2026-01-22 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/title-normalize/20260105-095754/dryrun_report.json | large-file | 163.9KB | 2026-01-05 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/title-normalize/20260114-031147/dryrun_report.json | large-file | 780.9KB | 2026-01-14 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/title-normalize/20260114-031616/dryrun_report.json | large-file | 756.4KB | 2026-01-14 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/title-normalize/20260114-031722/dryrun_report.json | large-file | 756.4KB | 2026-01-14 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/title-normalize/20260114-031851/dryrun_report.json | large-file | 1.18MB | 2026-01-14 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/exports/title-normalize/20260114-031919/apply_report.json | large-file | 157.5KB | 2026-01-14 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/firebase-debug.log | large-file | 308.5KB | 2026-02-20 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/00e2a8bb-4d8f-4071-8eab-4fa06368db13/1763974298075_a8c76cf5_IMG_3688.jpeg.jpeg | large-file | 2.50MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/00e2a8bb-4d8f-4071-8eab-4fa06368db13/1763974298089_e5b52944_IMG_3689.jpeg.jpeg | large-file | 2.68MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/00e2a8bb-4d8f-4071-8eab-4fa06368db13/1763974298090_53d54a97_IMG_3690.jpeg.jpeg | large-file | 2.70MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/00e2a8bb-4d8f-4071-8eab-4fa06368db13/1763974298090_7032af7e_IMG_3691.jpeg.jpeg | large-file | 2.27MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/00e2a8bb-4d8f-4071-8eab-4fa06368db13/1763974298091_817d4291_IMG_3695.jpeg.jpeg | large-file | 3.10MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/0728be70-076d-438b-a7ee-4bfd857df6ba/1764036360008_32be8cf7_IMG_3674.jpeg.jpeg | large-file | 2.39MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/085ab8fe-fd4b-48ef-a974-37f97bc4773d/1763737490632_663b1b71_image.jpg.jpeg | large-file | 3.79MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/085ab8fe-fd4b-48ef-a974-37f97bc4773d/1763737490634_4b20f977_IMG_3659.jpeg.jpeg | large-file | 3.12MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/085ab8fe-fd4b-48ef-a974-37f97bc4773d/1763737490635_0af9e7d7_IMG_3657.jpeg.jpeg | large-file | 3.14MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/085ab8fe-fd4b-48ef-a974-37f97bc4773d/1763737490635_89240579_IMG_3658.jpeg.jpeg | large-file | 2.51MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/085ab8fe-fd4b-48ef-a974-37f97bc4773d/1763737490637_6978d44a_IMG_3656.jpeg.jpeg | large-file | 2.49MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/08eaceb0-a20a-42b5-8287-cc7bcfca90a1/1763918412706_427a0159_IMG_1068.jpeg.jpeg | large-file | 1.36MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/08eaceb0-a20a-42b5-8287-cc7bcfca90a1/1763918412712_f8a9043b_IMG_1067.jpeg.jpeg | large-file | 1.46MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/08eaceb0-a20a-42b5-8287-cc7bcfca90a1/1763918412713_5887ea8a_IMG_1066.jpeg.jpeg | large-file | 1.87MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/08eaceb0-a20a-42b5-8287-cc7bcfca90a1/1763918412714_536becea_IMG_1065.jpeg.jpeg | large-file | 1.25MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/0a6a2885-5407-40b8-81cd-8d3a57142f0e/1763735724529_7b6d710e_image.jpg.jpeg | large-file | 3.28MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/0c22e4c9-099b-4d0f-9913-ada94081ab64/1764030867214_253050b0_IMG_3678.jpeg.jpeg | large-file | 4.06MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/1201c74c-4c07-480a-913c-c5000ab9a7c5/1763764107047_30442016_WhatsApp_Image_2025-11-21_at_23.25.09.jpeg.jpeg | large-file | 141.9KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/149b1450-df0b-4c02-bb25-e485fc6e0501/1763973966166_7f6bd6b4_IMG_3688.jpeg.jpeg | large-file | 2.50MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/149b1450-df0b-4c02-bb25-e485fc6e0501/1763973966168_460d5a1b_IMG_3689.jpeg.jpeg | large-file | 2.68MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/149b1450-df0b-4c02-bb25-e485fc6e0501/1763973966169_e0688047_IMG_3690.jpeg.jpeg | large-file | 2.70MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/149b1450-df0b-4c02-bb25-e485fc6e0501/1763973966170_00fa6130_IMG_3695.jpeg.jpeg | large-file | 3.10MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/149b1450-df0b-4c02-bb25-e485fc6e0501/1763973966170_0e4e9881_IMG_3691.jpeg.jpeg | large-file | 2.27MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/14c02201-f4b2-44a1-8452-792a0097a462/1764038968012_d20aa302_IMG_3674.jpeg.jpeg | large-file | 2.39MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/17c8b1a0-5710-434b-9d4f-4c68522e7d6a/1764030867430_3952a316_IMG_1073.jpeg.jpeg | large-file | 3.52MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/17c8b1a0-5710-434b-9d4f-4c68522e7d6a/1764030867431_55f8c24b_IMG_1072.jpeg.jpeg | large-file | 1.61MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/17df7710-22bb-4c53-95ea-1537497da8e0/1763951088889_aa893a67_IMG_3688.jpeg.jpeg | large-file | 2.50MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/17df7710-22bb-4c53-95ea-1537497da8e0/1763951088894_2dc000b6_IMG_3689.jpeg.jpeg | large-file | 2.68MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/17df7710-22bb-4c53-95ea-1537497da8e0/1763951088898_e963803e_IMG_3691.jpeg.jpeg | large-file | 2.27MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/17df7710-22bb-4c53-95ea-1537497da8e0/1763951088898_ee4ad111_IMG_3690.jpeg.jpeg | large-file | 2.70MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/17df7710-22bb-4c53-95ea-1537497da8e0/1763951088899_7a07e0fe_IMG_3694.jpeg.jpeg | large-file | 2.86MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/17df7710-22bb-4c53-95ea-1537497da8e0/1763951088899_bb60bc7a_IMG_3695.jpeg.jpeg | large-file | 3.10MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/1a874f7c-008c-4c0c-b5b2-3a3fa9b82f90/1763292057051_2606f789_IMG_0868.jpeg.jpeg | large-file | 2.40MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/1a874f7c-008c-4c0c-b5b2-3a3fa9b82f90/1763292057057_3ff3c0a9_IMG_0870.jpeg.jpeg | large-file | 2.15MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/1d80338b-97ec-4f74-bd4e-5b9be8735e61/1763921808058_738732fa_IMG_3672.jpeg.jpeg | large-file | 2.61MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/21a64a79-d1b6-490c-9c89-44afed946856/1763950265615_9b0668cc_IMG_3695.jpeg.jpeg | large-file | 3.10MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/21a64a79-d1b6-490c-9c89-44afed946856/1763950265616_6d139385_IMG_3691.jpeg.jpeg | large-file | 2.27MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/21a64a79-d1b6-490c-9c89-44afed946856/1763950265617_b196e4b4_IMG_3689.jpeg.jpeg | large-file | 2.68MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/21a64a79-d1b6-490c-9c89-44afed946856/1763950265617_e59bca07_IMG_3690.jpeg.jpeg | large-file | 2.70MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/21a64a79-d1b6-490c-9c89-44afed946856/1763950265618_60f6282a_IMG_3688.jpeg.jpeg | large-file | 2.50MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/21a64a79-d1b6-490c-9c89-44afed946856/1763950265618_f301bc24_IMG_3687.jpeg.jpeg | large-file | 2.67MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/25b56f8d-a54f-473e-97f0-78bae961696d/1764756380668_4ceb5049_Gro____IMG_0967_.jpeg.jpeg | large-file | 252.5KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/26eb11d4-5829-4c80-b3c1-1f8efe859309/1764757395832_81302d2b_Gro____IMG_0967_.jpeg.jpeg | large-file | 252.5KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/2ede4cf9-7239-47e8-b05b-5611b3d6ff2d/1763737840539_6a2ec0bc_IMG_3659.jpeg.jpeg | large-file | 3.12MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/2ede4cf9-7239-47e8-b05b-5611b3d6ff2d/1763737840541_c436e2ba_IMG_3658.jpeg.jpeg | large-file | 2.51MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/2f345baa-0c91-4e62-9fd6-1b645ca0c14b/1763295972902_88788184_IMG_0868.jpeg.jpeg | large-file | 2.40MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/2f345baa-0c91-4e62-9fd6-1b645ca0c14b/1763295972912_008a00d7_IMG_0870.jpeg.jpeg | large-file | 2.15MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/30e2c780-ac45-46a3-8185-86b30152694a/1763670564896_feaa19a6_image.jpg.jpeg | large-file | 1.95MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/3296438d-c8c5-4d90-a83b-311f83effb48/1764041955080_a4347eab_IMG_3677.jpeg.jpeg | large-file | 3.24MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/45c1efbe-5b6c-462f-ab1a-e8b330d43c9c/1763937700846_cc0867ea_IMG_3687.jpeg.jpeg | large-file | 2.67MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/45c1efbe-5b6c-462f-ab1a-e8b330d43c9c/1763937700849_a0bb4b68_IMG_3688.jpeg.jpeg | large-file | 2.50MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/45c1efbe-5b6c-462f-ab1a-e8b330d43c9c/1763937700850_5dd433b6_IMG_3689.jpeg.jpeg | large-file | 2.68MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/45c1efbe-5b6c-462f-ab1a-e8b330d43c9c/1763937700850_6baec0b5_IMG_3690.jpeg.jpeg | large-file | 2.70MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/45c1efbe-5b6c-462f-ab1a-e8b330d43c9c/1763937700851_0f6675e3_IMG_3692.jpeg.jpeg | large-file | 3.20MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/45c1efbe-5b6c-462f-ab1a-e8b330d43c9c/1763937700851_dd46133b_IMG_3691.jpeg.jpeg | large-file | 2.27MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/45c1efbe-5b6c-462f-ab1a-e8b330d43c9c/1763937700852_74d43204_IMG_3693.jpeg.jpeg | large-file | 2.87MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/45c1efbe-5b6c-462f-ab1a-e8b330d43c9c/1763937700853_5be3963c_IMG_3694.jpeg.jpeg | large-file | 2.86MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/45c1efbe-5b6c-462f-ab1a-e8b330d43c9c/1763937700855_1e8b6a09_IMG_3695.jpeg.jpeg | large-file | 3.10MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/4a090835-b332-4cf1-ba0d-fd82ed3a8865/1764038968395_4a909312_IMG_3675.jpeg.jpeg | large-file | 3.76MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/4a090835-b332-4cf1-ba0d-fd82ed3a8865/1764038968400_1dd3a913_IMG_3676.jpeg.jpeg | large-file | 3.68MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/4aa2f3f0-6665-46a2-b3a5-7c22c58263c1/1764030867908_1653ef2b_IMG_3676.jpeg.jpeg | large-file | 3.68MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/4aa2f3f0-6665-46a2-b3a5-7c22c58263c1/1764030867910_b4b3d66d_IMG_3675.jpeg.jpeg | large-file | 3.76MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/4b5d1362-1f1c-46f7-863e-1450c649f350/1764772872405_38b36a14_Gro____IMG_0967_.jpeg.jpeg | large-file | 252.5KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/4d3e5218-2fe9-4939-9f12-22327bc5619c/1764006614524_22cc350c_IMG_3688.jpeg.jpeg | large-file | 2.50MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/4d3e5218-2fe9-4939-9f12-22327bc5619c/1764006614529_5e61643d_IMG_3689.jpeg.jpeg | large-file | 2.68MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/4d3e5218-2fe9-4939-9f12-22327bc5619c/1764006614530_4561fdcf_IMG_3690.jpeg.jpeg | large-file | 2.70MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/4d3e5218-2fe9-4939-9f12-22327bc5619c/1764006614531_50026812_IMG_3691.jpeg.jpeg | large-file | 2.27MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/4d3e5218-2fe9-4939-9f12-22327bc5619c/1764006614532_c4547af9_IMG_3695.jpeg.jpeg | large-file | 3.10MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/4d55441b-f365-4c82-a498-a7be0e143074/1764036360208_4540dcba_IMG_3676.jpeg.jpeg | large-file | 3.68MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/4d55441b-f365-4c82-a498-a7be0e143074/1764036360209_6731c9f3_IMG_3675.jpeg.jpeg | large-file | 3.76MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/5c0735a7-09de-46da-8aa1-9638b0d9f25b/1763738455516_bfb3e827_image.jpg.jpeg | large-file | 3.48MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/5c4a8c32-7392-4f15-a7d5-f6823d802ebc/1763736042118_a68ee42e_image.jpg.jpeg | large-file | 2.75MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/5d96c98f-278e-41e1-a2e0-a4f5bb65d4e3/1763738191620_6e562206_image.jpg.jpeg | large-file | 3.72MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/5ec8b3e4-8558-406d-94b6-bc21bf87ad7d/1764030865880_a74a3144_IMG_3691.jpeg.jpeg | large-file | 2.27MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/5f37568d-c6f0-421f-a195-4f0352616a3f/1763297588309_bd337fb7_IMG_0868.jpeg.jpeg | large-file | 2.40MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/5f37568d-c6f0-421f-a195-4f0352616a3f/1763297588310_22f5762d_IMG_0870.jpeg.jpeg | large-file | 2.15MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/606182f1-ce6e-48e0-8e2d-940905b22c54/1763948276754_6de7761f_IMG_1065.jpeg.jpeg | large-file | 1.15MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/606182f1-ce6e-48e0-8e2d-940905b22c54/1763948276759_708522f7_IMG_1066.jpeg.jpeg | large-file | 1.91MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/606182f1-ce6e-48e0-8e2d-940905b22c54/1763948276760_ce7a26ad_IMG_1068.jpeg.jpeg | large-file | 1.30MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/606182f1-ce6e-48e0-8e2d-940905b22c54/1763948276761_7497bb0a_IMG_1070.jpeg.jpeg | large-file | 1.04MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/606182f1-ce6e-48e0-8e2d-940905b22c54/1763948276761_cde1de05_IMG_1071.jpeg.jpeg | large-file | 1.35MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/606182f1-ce6e-48e0-8e2d-940905b22c54/1763948276763_38250a6d_IMG_1072.jpeg.jpeg | large-file | 1.61MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/60f3e9f5-0f81-4372-82a9-ca59aabf5b3f/1764030866144_b673c68e_IMG_3689.jpeg.jpeg | large-file | 2.68MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/62f8406b-16f4-4a36-bdcb-815f0ec4cc62/1763690910215_fdc707ee_Gro____IMG_0982_.jpeg.jpeg | large-file | 224.8KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/62f8406b-16f4-4a36-bdcb-815f0ec4cc62/1763690910221_09c977ce_Gro____IMG_0983_.jpeg.jpeg | large-file | 235.3KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/62f8406b-16f4-4a36-bdcb-815f0ec4cc62/1763690910222_51aa22cb_Gro____IMG_0984_.jpeg.jpeg | large-file | 239.6KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/62f8406b-16f4-4a36-bdcb-815f0ec4cc62/1763690910224_e1b081d5_IMG_0891.jpeg.jpeg | large-file | 2.46MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/62f8406b-16f4-4a36-bdcb-815f0ec4cc62/1763690910229_84ec4f26_IMG_0874.jpeg.jpeg | large-file | 2.62MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/62f8406b-16f4-4a36-bdcb-815f0ec4cc62/1763690910230_92413c46_IMG_0875.jpeg.jpeg | large-file | 2.70MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/63020c0f-e7c9-45fc-b0c3-6f6c3a8bf30d/1763296816414_91a3222e_IMG_0868.jpeg.jpeg | large-file | 2.40MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/63020c0f-e7c9-45fc-b0c3-6f6c3a8bf30d/1763296816452_aa05da92_IMG_0870.jpeg.jpeg | large-file | 2.15MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/653aec51-45c4-4457-95ca-d45b49d958fe/1763346634793_951afe18_Gro____IMG_0936_.jpeg.jpeg | large-file | 270.3KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/653aec51-45c4-4457-95ca-d45b49d958fe/1763346634798_01b406ba_Gro____IMG_0941_.jpeg.jpeg | large-file | 208.9KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/653aec51-45c4-4457-95ca-d45b49d958fe/1763346634799_df36e6a0_Gro____IMG_0942_.jpeg.jpeg | large-file | 268.8KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/653aec51-45c4-4457-95ca-d45b49d958fe/1763346634800_283abda4_Gro____IMG_0944_.jpeg.jpeg | large-file | 351.9KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/653aec51-45c4-4457-95ca-d45b49d958fe/1763346634800_8fb984ed_Gro____IMG_0943_.jpeg.jpeg | large-file | 332.5KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/653aec51-45c4-4457-95ca-d45b49d958fe/1763346634801_aeeac759_Gro____IMG_0946_.jpeg.jpeg | large-file | 190.4KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/653aec51-45c4-4457-95ca-d45b49d958fe/1763346634801_f2faacb8_Gro____IMG_0950_.jpeg.jpeg | large-file | 279.1KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/653aec51-45c4-4457-95ca-d45b49d958fe/1763346634802_4ea6851d_Gro____IMG_0954_.jpeg.jpeg | large-file | 300.2KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/653aec51-45c4-4457-95ca-d45b49d958fe/1763346634804_e3a5ee65_Gro____IMG_0959_.jpeg.jpeg | large-file | 300.4KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/653aec51-45c4-4457-95ca-d45b49d958fe/1763346634805_386bbdb2_Gro____IMG_0962_.jpeg.jpeg | large-file | 200.6KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/653aec51-45c4-4457-95ca-d45b49d958fe/1763346634805_97d7c994_Gro____IMG_0961_.jpeg.jpeg | large-file | 331.6KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/653aec51-45c4-4457-95ca-d45b49d958fe/1763346634806_5e11d014_Gro____IMG_0963_.jpeg.jpeg | large-file | 282.6KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/66e53af1-780b-44bd-a0aa-3a9b0a8b75d5/1763737843892_53deae47_IMG_0796.jpeg.jpeg | large-file | 1.88MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/66fea54c-8610-4ff5-bd49-296cef45cf3d/1763736480508_e4af5193_image.jpg.jpeg | large-file | 2.75MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/68940453-4be0-4af1-97cc-842ebecc5fa1/1764030866008_8e280a38_IMG_3674.jpeg.jpeg | large-file | 2.39MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/6a5705c5-2a51-4055-b32d-72f107107368/1764759059981_97db5b10_Gro____IMG_0967_.jpeg.jpeg | large-file | 252.5KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/6b36faad-c82c-4380-834d-735425a06361/1763334718345_5d42195b_IMG_0950.jpeg.jpeg | large-file | 2.39MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/6b36faad-c82c-4380-834d-735425a06361/1763334718351_71f5a1c4_IMG_0953.jpeg.jpeg | large-file | 1.60MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/6b36faad-c82c-4380-834d-735425a06361/1763334718388_d3eb5c63_IMG_0952.jpeg.jpeg | large-file | 2.44MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/6b36faad-c82c-4380-834d-735425a06361/1763334718389_2d233c0d_IMG_0951.jpeg.jpeg | large-file | 2.22MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/6b36faad-c82c-4380-834d-735425a06361/1763334718390_67ed27fe_IMG_0946.jpeg.jpeg | large-file | 2.38MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/6b36faad-c82c-4380-834d-735425a06361/1763334718391_f6011db3_IMG_0945.jpeg.jpeg | large-file | 2.48MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/6b36faad-c82c-4380-834d-735425a06361/1763334718392_ec396d5c_IMG_0942.jpeg.jpeg | large-file | 2.66MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/6b36faad-c82c-4380-834d-735425a06361/1763334718393_2560d6a2_IMG_0941.jpeg.jpeg | large-file | 1.49MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/6c3ed8fc-0aeb-45f1-8343-b631fe3e8757/1764758348188_b61a9cb3_Gro____IMG_0967_.jpeg.jpeg | large-file | 252.5KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/6cd7516a-ff25-4120-9654-24e0db771a88/1763335342688_92812fac_IMG_0961.jpeg.jpeg | large-file | 2.92MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/777a60fc-d463-4cb4-835b-c0110593f1ee/1763337473881_63e854b2_IMG_0950.jpeg.jpeg | large-file | 2.39MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/7ae756fa-ee02-47dc-8bc0-8fb76c67939f/1764012406758_bb12e717_IMG_3688.jpeg.jpeg | large-file | 2.50MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/7ae756fa-ee02-47dc-8bc0-8fb76c67939f/1764012406760_22f874a9_IMG_3689.jpeg.jpeg | large-file | 2.68MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/7ae756fa-ee02-47dc-8bc0-8fb76c67939f/1764012406761_54440cc5_IMG_3690.jpeg.jpeg | large-file | 2.70MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/7f0c8f91-03a9-4a51-9630-eca7c6a04f1c/1763390921544_b1a84fdb_IMG_0888.jpeg.jpeg | large-file | 2.17MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/7f0c8f91-03a9-4a51-9630-eca7c6a04f1c/1763390921550_975f5b69_IMG_0889.jpeg.jpeg | large-file | 1.27MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/828e609c-50b9-42ec-94bb-3f92bda32281/1763949315280_340f443d_IMG_1065.jpeg.jpeg | large-file | 1.15MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/828e609c-50b9-42ec-94bb-3f92bda32281/1763949315288_80feea05_IMG_1066.jpeg.jpeg | large-file | 1.91MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/828e609c-50b9-42ec-94bb-3f92bda32281/1763949315289_bbc4a5e5_IMG_1068.jpeg.jpeg | large-file | 1.30MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/828e609c-50b9-42ec-94bb-3f92bda32281/1763949315290_d92108e5_IMG_1070.jpeg.jpeg | large-file | 1.04MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/828e609c-50b9-42ec-94bb-3f92bda32281/1763949315291_06fb16b5_IMG_1071.jpeg.jpeg | large-file | 1.35MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/828e609c-50b9-42ec-94bb-3f92bda32281/1763949315291_40946d8e_IMG_1072.jpeg.jpeg | large-file | 1.61MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/83767b92-e405-4af1-95a7-3c281c8e6305/1764759826294_3dcbfe5a_Gro____IMG_0967_.jpeg.jpeg | large-file | 252.5KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/8417d25e-25db-4d79-8c80-d823ceef0df9/1763951949700_25d3176d_IMG_3688.jpeg.jpeg | large-file | 2.50MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/8417d25e-25db-4d79-8c80-d823ceef0df9/1763951949705_9a63f825_IMG_3689.jpeg.jpeg | large-file | 2.68MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/8417d25e-25db-4d79-8c80-d823ceef0df9/1763951949706_44c09dcd_IMG_3690.jpeg.jpeg | large-file | 2.70MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/8417d25e-25db-4d79-8c80-d823ceef0df9/1763951949707_bc0e7323_IMG_3691.jpeg.jpeg | large-file | 2.27MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/8417d25e-25db-4d79-8c80-d823ceef0df9/1763951949708_80d44e9b_IMG_3694.jpeg.jpeg | large-file | 2.86MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/8417d25e-25db-4d79-8c80-d823ceef0df9/1763951949709_d58faaf1_IMG_3695.jpeg.jpeg | large-file | 3.10MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/88c44362-52b1-415d-a60c-e3741492fa84/1764030866519_97f03ac6_IMG_3682.jpeg.jpeg | large-file | 2.96MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/8d6abeae-01b8-4c00-9539-be9da3b889af/1764773636131_dab22b00_Gro____IMG_0967_.jpeg.jpeg | large-file | 252.5KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/94b1ea54-0d19-4423-8761-4f9b793d778a/1764754638976_ddc1b1de_s-l1600__4_.webp.webp | large-file | 450.9KB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| archive/uiv2/jobs/97ef9c33-6b9a-48a1-88c7-be77b5b44bc3/1763335819317_df643563_IMG_0950.jpeg.jpeg | large-file | 2.39MB | 2025-12-03 | ARCHIVE | >100KB outside safe prefixes |
| ... | | | | | 2672 more (truncated) |

## plan-prompt-dir (4)

| Path | Type | Size | LastModified | Suggested-Action | Reason |
|------|------|------|--------------|------------------|--------|
| docs/plans | plan-prompt-dir | 1 files | 2026-03-14 | ARCHIVE | Plan/prompt directory (1 markdown files) |
| docs/prompts | plan-prompt-dir | 38 files | 2026-04-01 | ARCHIVE | Plan/prompt directory (38 markdown files) |
| docs/superpowers/plans | plan-prompt-dir | 3 files | 2026-04-06 | ARCHIVE | Plan/prompt directory (3 markdown files) |
| docs/superpowers/specs | plan-prompt-dir | 4 files | 2026-04-08 | ARCHIVE | Plan/prompt directory (4 markdown files) |

## system-junk (43)

| Path | Type | Size | LastModified | Suggested-Action | Reason |
|------|------|------|--------------|------------------|--------|
| .DS_Store | system-junk | 42.0KB | 2026-04-13 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/.DS_Store | system-junk | 32.0KB | 2026-02-26 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/backend/.DS_Store | system-junk | 12.0KB | 2026-01-05 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/backend/api/.DS_Store | system-junk | 6.0KB | 2025-11-28 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/backend/api/client.ts -> Wait wrong path? Actually file path /.DS_Store | system-junk | 6.0KB | 2025-11-28 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/backend/api/client.ts -> Wait wrong path? Actually file path /Users/.DS_Store | system-junk | 6.0KB | 2025-11-28 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/backend/api/client.ts -> Wait wrong path? Actually file path /Users/oguz/.DS_Store | system-junk | 6.0KB | 2025-11-28 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/backend/api/client.ts -> Wait wrong path? Actually file path /Users/oguz/Dev/.DS_Store | system-junk | 6.0KB | 2025-11-28 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/backend/api/client.ts -> Wait wrong path? Actually file path /Users/oguz/Dev/avycloud/.DS_Store | system-junk | 6.0KB | 2025-11-28 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/backend/exports/.DS_Store | system-junk | 6.0KB | 2026-01-30 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/backend/scripts/.DS_Store | system-junk | 8.0KB | 2025-12-24 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/backend/services/.DS_Store | system-junk | 6.0KB | 2025-12-08 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/components/.DS_Store | system-junk | 8.0KB | 2025-12-24 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/ebay/.DS_Store | system-junk | 6.0KB | 2026-02-08 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/exports/.DS_Store | system-junk | 6.0KB | 2025-12-24 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/exports/firestore/.DS_Store | system-junk | 6.0KB | 2025-12-24 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/google/.DS_Store | system-junk | 8.0KB | 2025-12-01 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/kaufland/.DS_Store | system-junk | 6.0KB | 2025-12-11 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/kb/.DS_Store | system-junk | 12.0KB | 2025-12-24 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/products/.DS_Store | system-junk | 14.0KB | 2025-12-05 | DELETE | .DS_Store (macOS metadata) |
| archive/uiv2/public/.DS_Store | system-junk | 6.0KB | 2026-02-26 | DELETE | .DS_Store (macOS metadata) |
| backend/.DS_Store | system-junk | 14.0KB | 2026-04-13 | DELETE | .DS_Store (macOS metadata) |
| backend/api/.DS_Store | system-junk | 6.0KB | 2025-11-28 | DELETE | .DS_Store (macOS metadata) |
| backend/api/client.ts -> Wait wrong path? Actually file path /.DS_Store | system-junk | 6.0KB | 2025-11-28 | DELETE | .DS_Store (macOS metadata) |
| backend/api/client.ts -> Wait wrong path? Actually file path /Users/.DS_Store | system-junk | 6.0KB | 2025-11-28 | DELETE | .DS_Store (macOS metadata) |
| backend/api/client.ts -> Wait wrong path? Actually file path /Users/oguz/.DS_Store | system-junk | 6.0KB | 2025-11-28 | DELETE | .DS_Store (macOS metadata) |
| backend/api/client.ts -> Wait wrong path? Actually file path /Users/oguz/Dev/.DS_Store | system-junk | 6.0KB | 2025-11-28 | DELETE | .DS_Store (macOS metadata) |
| backend/api/client.ts -> Wait wrong path? Actually file path /Users/oguz/Dev/avycloud/.DS_Store | system-junk | 6.0KB | 2025-11-28 | DELETE | .DS_Store (macOS metadata) |
| backend/exports/.DS_Store | system-junk | 6.0KB | 2026-01-30 | DELETE | .DS_Store (macOS metadata) |
| backend/scripts/.DS_Store | system-junk | 8.0KB | 2025-12-24 | DELETE | .DS_Store (macOS metadata) |
| backend/services/.DS_Store | system-junk | 6.0KB | 2025-12-08 | DELETE | .DS_Store (macOS metadata) |
| components/.DS_Store | system-junk | 8.0KB | 2025-12-24 | DELETE | .DS_Store (macOS metadata) |
| docs/.DS_Store | system-junk | 6.0KB | 2026-04-12 | DELETE | .DS_Store (macOS metadata) |
| ebay/.DS_Store | system-junk | 6.0KB | 2026-02-08 | DELETE | .DS_Store (macOS metadata) |
| exports/.DS_Store | system-junk | 6.0KB | 2025-12-24 | DELETE | .DS_Store (macOS metadata) |
| exports/firestore/.DS_Store | system-junk | 6.0KB | 2025-12-24 | DELETE | .DS_Store (macOS metadata) |
| favicon_io/.DS_Store | system-junk | 6.0KB | 2026-02-26 | DELETE | .DS_Store (macOS metadata) |
| google/.DS_Store | system-junk | 8.0KB | 2025-12-01 | DELETE | .DS_Store (macOS metadata) |
| kaufland/.DS_Store | system-junk | 6.0KB | 2025-12-11 | DELETE | .DS_Store (macOS metadata) |
| kb/.DS_Store | system-junk | 12.0KB | 2025-12-24 | DELETE | .DS_Store (macOS metadata) |
| mockups/.DS_Store | system-junk | 6.0KB | 2026-02-20 | DELETE | .DS_Store (macOS metadata) |
| products/.DS_Store | system-junk | 14.0KB | 2025-12-05 | DELETE | .DS_Store (macOS metadata) |
| public/.DS_Store | system-junk | 6.0KB | 2026-04-02 | DELETE | .DS_Store (macOS metadata) |
