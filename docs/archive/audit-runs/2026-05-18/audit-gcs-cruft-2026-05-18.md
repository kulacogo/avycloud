# GCS Cruft Audit — 2026-05-18

Project: `avycloud`
Buckets scanned: 8
Sample per bucket: 200
Errors: 0

## Bucket × Prefix

| Bucket | Prefix | ObjectCount | TotalSizeMB | OldestObject | Classification |
|--------|--------|-------------|-------------|--------------|----------------|
| avycloud_cloudbuild | source | 96 | 10735.99 | 2025-11-09 (source/1762690962.396628-1a9cc8f9338644499c49495dba6c45be.tgz) | ACTIVE (91 objects > 90d) |
| avycloud-genai-images | jobs | 200 | 411.72 | 2025-12-01 (jobs/085ab8fe-fd4b-48ef-a974-37f97bc4773d/1763737490632_663b1b71_image.jpg.jpeg) | STALE (all 200 objects > 90d old) |
| avycloud-product-images | jobs | 200 | 367.26 | 2025-11-16 (jobs/1a874f7c-008c-4c0c-b5b2-3a3fa9b82f90/1763292057057_3ff3c0a9_IMG_0870.jpeg.jpeg) | STALE (all 200 objects > 90d old) |
| prodsandjobs | datasets | 1 | 9.69 | 2026-02-20 (datasets/DE_MVL_2025_10.compact.jsonl) | ACTIVE |
| prodsandjobs | default | 199 | 0.44 | 2026-03-17 (default/invoices/RE-1516.pdf) | ACTIVE |
| products-and-jobs | products | 80 | 153.27 | 2025-12-03 (products/homerella-badewanneneinlage-88x39-1/gemini_render_studio_1764563387130_1_fe84d52f2b9c7c955b5712565682fdd1.png) | STALE (all 80 objects > 90d old) |
| run-sources-avycloud-europe-west1 | services | 2 | 14.38 | 2026-02-27 (services/avycloud-backend/1772214950.445011-9fb87ea1d170438b8d22f17fb51615d9.zip) | ACTIVE |
| run-sources-avycloud-europe-west3 | services | 176 | 913.02 | 2025-11-09 (services/product-hub-backend/1762707729.092262-aedea91081f544d48d39506f5cd6dcdb.zip) | ACTIVE (85 objects > 90d) |
| trendocean | (root) | 7 | 0.49 | 2025-11-19 (Brand.png) | ACTIVE (5 objects > 90d) |
| trendocean | fsexport | 6 | 1.63 | 2025-12-12 (fsexport/) | STALE (all 6 objects > 90d old) |
| trendocean | jobs | 82 | 206.82 | 2025-11-27 (jobs/33742c17-e5f0-43dc-8c52-827e7f147a13/1764233349948_3a80c9fd_IMG_1103.jpeg.jpeg) | STALE (all 82 objects > 90d old) |
| trendocean | product_images | 52 | 124.24 | 2025-11-20 (product_images/) | STALE (all 52 objects > 90d old) |
| trendocean | products | 53 | 82.61 | 2025-11-29 (products/000144351296/other_e83224e6fb283c3d28966149f13ed808.png) | STALE (all 53 objects > 90d old) |
