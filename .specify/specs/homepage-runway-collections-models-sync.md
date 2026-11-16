# Feature Specification: Homepage 3D Runway & Lookbook Collections Model Synchronization (KAN-109)

## 1. Problem Statement & Motivation
In production, operators managing seasonal fashion collections in Admin ERP observed broken thumbnail icons on collection cards (`media_1794851829354_3b99fd2b.jpg`) and within the collection modal (`media_1794851702806_06768ccf.png`). Furthermore, the runway preview stage in the modal lacked rendered model silhouettes, and the Storefront homepage runway (`media_1794851747458_dc82f20b.jpg`) was mistakenly attempting to override the 3D runway models with generic horizontal banners (`home_hero`) rather than synchronizing with the active lookbook collections from the database.

## 2. Requirements & Acceptance Criteria
- **AC-1 (Zero Broken Images in Admin ERP)**:
  - Copy transparent cutout model PNGs (`model_cutout_1.png` to `model_cutout_5.png`, `floral_top.png`, `nhanhhoa1.png`) into `apps/admin-erp-ng/public/assets/images/models/`.
  - Configure `apps/admin-erp-ng/angular.json` to properly bundle assets.
  - Implement resilient image error fallback (`(error)="onModelImgError($event, ...)"`) in Admin ERP templates.
- **AC-2 (Admin ERP Collection Cards & Runway Preview)**:
  - In Admin ERP content page, all 5 model thumbnails per collection card must render crisp, contained previews.
  - In the Collection Edit Modal, "MÔ PHỎNG RUNWAY TRỰC TIẾP" must display the 5 models standing on the oval stage with gradient backdrop and drop shadows, mirroring the live storefront runway.
- **AC-3 (Storefront Homepage Runway Dynamic Collections Binding)**:
  - Eliminate the `catalog.getBanners('home_hero')` overwrite in `home.page.ts`.
  - In `loadHome()`, query `this.catalog.getCollections()`.
  - Dynamically map the collections into `heroLooks`:
    - `id`: collection `code`
    - `collectionName`: collection `name`
    - `title`: collection `story_headline` || collection `name`
    - `description`: collection `story_desc` || collection `home_story`
    - `image`: collection `models[0]` (or fallback to `model_cutout_X.png`)
    - `season`: collection `col_number`
    - `badge`: collection `badge`
    - `looksCount`: collection `kicker`
    - `link`: collection `category_link` || `/collections#${code}`
  - Keep built-in `HERO_LOOKS` as an instant initial paint and resilient offline fallback.
- **AC-4 (Storefront Collections Page Synchronization)**:
  - `/collections` displays all 5 collections with their respective 5 lookbook models, hero stories, and designs.
- **AC-5 (Automated Tests & PR CI Gates)**:
  - All existing unit tests pass without regression.
  - Full end-to-end promotion pipeline to `main` completes green.
