# Implementation Tasks: 3D Spatial Scenarios & Multi-Angle Female Model Viewer for VTO

**Feature ID**: `FEAT-VTO-3D-SCENARIOS`  
**Jira/Ticket**: `KAN-66`  

---

## Task List

- [ ] `TASK-1`: Harden `ai-image-workbench.ts` with normalized angle computation, delta-time auto-spin, ergonomic viewing arc, strict female whitelist, and title formatting.
- [ ] `TASK-2`: Update `ai-image-workbench.html` with `<dialog (cancel)="close()">` event binding, `normalizedAngle()` preset checks, and `activeScenario().id` scenario highlighting.
- [ ] `TASK-3`: Ensure `ai-image-workbench.css` adheres to 3D matrix preservation and stays well within the 24kB style budget.
- [ ] `TASK-4`: Expand `ai-image-workbench.spec.ts` with tests for female-only model filtering, 3D angle presets, auto-spin lifecycle teardown, zoom clamping, and scenario switching.
- [ ] `TASK-5`: Run full test suite (`test:user`, `test:api`, `test:admin-erp`) and verify build compliance (`build:user`, `build:api`).
- [ ] `TASK-6`: Commit, PR to develop, merge, and promote to production.
