# Task Breakdown: SOTA Virtual Try-On Pipeline & 3D Spatial Refactor

**Feature ID**: `FEAT-VTO-REFACTOR-SOTA-3D`  
**Jira/Ticket**: `KAN-66`  

---

## Tasks

- [ ] `TASK-1`: Fix P0-3 in `apps/user-ng/src/app/shared/ai-image-workbench/ai-image-workbench.ts`: prevent `switchScene()` from invoking `selectStudio()` when `result()` is already populated, enabling seamless 3D scenario backdrop switching.
- [ ] `TASK-2`: Fix P0-4 in `apps/api/src/ai/ai-service.ts`: add HTTP 429 worker busy backoff handling in queue pump to avoid dropping concurrent requests.
- [ ] `TASK-3`: Fix P1-1 in `apps/ai-worker/maskless_vton.py`: wrap inference execution in `try ... finally: torch.cuda.empty_cache()` for strict VRAM recycling.
- [ ] `TASK-4`: Add unit test in `ai-image-workbench.spec.ts` verifying that `switchScene()` preserves active `result()` and updates 3D scenario without wiping state.
- [ ] `TASK-5`: Run full test suite (`npm run test:api`, `npm run test:user`) and all production builds (`npm run build:api`, `npm run build:user`, `npm run build:admin`, `npm run build:admin-erp`).
- [ ] `TASK-6`: Commit, PR to `develop`, auto-merge, promote to `main`, and verify production deployment.
