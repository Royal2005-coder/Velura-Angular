# VTO Studio: 10-pose try-on preview (3D/360 removed)

KAN-106. Supersedes `vto-3d-model-scenarios.md` and `vto-refactor-sota-3d-pipeline.md` for studio mode.

## Problem
Studio mode runs one try-on on a chosen pose, then an optional TripoSR 360 turntable (24 frames) that looks wrong
(see user screenshot: blurry reconstructed doll, invented back side). Customers want to see the garment on the
studio model in the 10 standard poses, not a 3D reconstruction.

## Behaviour
1. Studio tab input = the product photo of the selected colour/variant + the fixed standing model
   (`female-front-relaxed-v1`, first licensed asset). No pose picker before processing.
2. One job (`virtual_try_on`, `mode: studio`) runs the existing 2D try-on once per licensed studio pose
   (10 poses in `apps/ai-worker/assets/studio/manifest.json`), sequentially on the worker.
3. Output = up to 10 PNGs, one per pose. The standing pose is `result_url` (download/legacy path); every finished
   pose is published as it completes (`poses`), so the UI fills in progressively while status is `running`.
4. Viewer = large preview + 10 pose thumbnails (label from manifest). Selecting a thumbnail only switches the
   preview. No drag-rotate, auto-spin, zoom-orbit, angle presets, or 360 copy.
5. Personal-photo mode unchanged (single try-on).
6. Variant flow unchanged: `product_id` + `variant_id` bound per job; garment photo chosen by variant colour.

## Contract
- Request (studio): `{ task, mode: "studio", product_id, variant_id, consent: true, confirmed: true, idempotency_key }`.
  `studio_asset_id` and `render3d` are no longer accepted/used for studio.
- `AiJobView.poses?: { id: string; label: string; pose: string }[]` replaces `frames3d`/`stage3d`.
- `GET /api/user/ai/jobs/:id/poses/:poseId` → `image/png`, only for ids listed in the job record, success or running.
- Success rule: job `success` iff the standing pose passes the worker gate and binding check; other poses that fail
  are omitted from `poses` (UI shows "n/10 dáng").
- Deadline: 120 s per pose (job controller = 120 s x pose count). Cancel stops between/within poses; late results
  are never published.
- Retry limit, idempotency, owner/RBAC, product withdrawal check (`requireVtoSelectionSupported`) unchanged and
  also apply to pose files.

## Removal (clean cutover)
API: `render3d`, `stage3d`, `frames3d`, `TurntableStage`, `turntable*` worker members, `renderTurntable`,
`publishTurntable`, route `/render3d/:name`. Client: all 3D/orbit/auto-spin/zoom state, `frames3d`, `stage3d`,
`render3d`. Worker: `reconstruction_3d.py`, TripoSR vendor/state-dict/config files, their tests, `virtual_try_on_3d`
task + capability, Dockerfile lines, requirements and bootstrap entries only used by TripoSR.

## Acceptance
- API tests: studio job runs N poses, publishes each, serves only listed pose ids, failed non-standing pose is
  omitted, standing-pose failure fails the job, cancel mid-run publishes nothing late.
- Workbench spec: studio shows 10 thumbnails, switching changes preview; no 360 UI strings.
- `npx tsc --noEmit` (api), `ng build user-ng`, API + workbench tests green; grep finds no `3d`/`360`/`turntable`
  in `apps/api/src/ai`, workbench, ai-worker (outside git history).
