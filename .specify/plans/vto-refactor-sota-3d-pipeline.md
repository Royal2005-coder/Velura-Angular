# Technical Implementation Plan: SOTA Virtual Try-On Pipeline & 3D Spatial Refactor

**Feature ID**: `FEAT-VTO-REFACTOR-SOTA-3D`  
**Jira/Ticket**: `KAN-66`  
**Status**: APPROVED FOR EXECUTION  

---

## 1. Architectural Strategy & EGM Verdict Summary

```
                      [ User Interaction: Storefront ]
                                     │
           ┌─────────────────────────┴────────────────────────┐
           ▼                                                  ▼
   [ Mode 1: Personal Photo ]                         [ Mode 2: Studio 3D 360° ]
   • Validates person/pose/quality                    • Whitelist: Strictly female models
   • Uploads private asset                            • 8 Curated Scenarios
           │                                                  │
           └─────────────────────────┬────────────────────────┘
                                     ▼
                          [ AI Cluster Gateway ]
                          • Job Queue & Concurrency Control
                          • Safe Retry / 429 Backoff (P0-4)
                          • Registry & Asset Whitelisting
                                     │
                                     ▼
                        [ K3s Python GPU Worker ]
                        • Model: FASHN-VTON 1.5 (bfloat16, 3.82GB VRAM)
                        • Memory: Strict 8GB VRAM envelope (4GB headroom)
                        • Cleanup: try...finally torch.cuda.empty_cache() (P1-1)
                        • Rejection: IDM-VTON (OOM), TripoSR (OOM), ICON (OOM/License)
                                     │
                                     ▼
                        [ Photorealistic 2D Output ]
                                     │
                                     ▼
                   [ Hardware-Accelerated 3D Spatial Room ]
                   (apps/user-ng: ai-image-workbench)
                   • Full 360° Horizontal Orbit + ±20° Vertical Tilt
                   • Volumetric Model (Front, Back tailored seams, Side thickness ribs)
                   • Dynamic 3D Room Floor, Walls, Ceiling & Spotlight
                   • Real-Time Scenario Background Switching (P0-3)
                   • 0 KB external bundle overhead (60 - 120 FPS on mobile)
```

---

## 2. Component Refactoring & Implementation Plan

### Phase 1: Frontend Scenario & 3D State Bug Fixes (`@velura/user-ng`)
1. **Fix P0-3 (`switchScene` wipes result)**:
   In `ai-image-workbench.ts`:
   ```typescript
   switchScene(scene: string): void {
     if (this.busy()) return;
     this.selectedScene.set(scene);
     // Only change studio model if NOT currently viewing a try-on result
     if (this.mode() === 'studio' && !this.result()) {
       const first = this.filteredStudioAssets()[0];
       if (first) {
         void this.selectStudio(first.id);
       }
     }
   }
   ```
2. **Preserve 3D Room Environment during Scenario Switching**:
   Ensure `activeScenario` updates immediately and transforms the 3D room's floor, walls, and spotlight without triggering re-render or clearing images.

### Phase 2: AI Gateway Queue & Memory Hardening (`@velura/api`)
1. **Fix P0-4 (Queue pump 429 backoff)**:
   In `apps/api/src/ai/ai-service.ts`:
   When worker returns HTTP 429 `WORKER_BUSY`, do not mark the job `failed`. Leave the job in `queued` status and retry on the next pump cycle after a 3000ms delay.
2. **Validate `studio_asset_id` against registry**:
   In `create()` method, verify that `studio_asset_id` exists in the registered female studio assets list.

### Phase 3: AI Worker CUDA Memory Safety (`@velura/ai-worker`)
1. **Fix P1-1 (`torch.cuda.empty_cache()` on teardown)**:
   In `apps/ai-worker/maskless_vton.py`:
   Wrap inference in `try ... finally: torch.cuda.empty_cache()` to prevent memory fragmentation and ensure 100% VRAM release.

### Phase 4: Test Suite & Regression Verification
1. Verify `ai-image-workbench.spec.ts` covers `switchScene` without wiping `result`.
2. Verify `test:api` passes 100%.
3. Verify `build:user`, `build:api`, `build:admin`, `build:admin-erp` pass with zero errors.
