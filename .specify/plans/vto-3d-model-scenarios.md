# Technical Implementation Plan: 3D Spatial Scenarios & Multi-Angle Female Model Viewer for VTO

**Feature ID**: `FEAT-VTO-3D-SCENARIOS`  
**Jira/Ticket**: `KAN-66`  
**Status**: READY FOR IMPLEMENTATION  

---

## 1. Architecture Overview

```
[Storefront User SPA]
  └─ AiImageWorkbench Component
       ├─ Mode: Studio Lookbook (Strictly Female Models Whitelist)
       ├─ Scenario System: 8 Standard Scenarios (VTO_SCENARIOS)
       │    ├─ Basic (Studio Chuẩn)
       │    ├─ Spring (Mùa Xuân)
       │    ├─ Summer (Mùa Hạ)
       │    ├─ Autumn (Mùa Thu)
       │    ├─ Winter (Mùa Đông)
       │    ├─ Work (Công sở)
       │    ├─ Street (Dạo phố)
       │    └─ Party (Dạ tiệc)
       └─ 3D Spatial Viewer Engine
            ├─ Continuous viewing arc (-65° to +65°) & vertical tilt (±16°)
            ├─ Discrete angle presets: 0° (Front), 45° (Profile), 180° (Back)
            ├─ Tailored back silhouette mapping with spine seam & darts
            ├─ Delta-time normalized auto-spin loop (36°/s)
            ├─ Native <dialog> cancel/close event hooks (zero RAF leak)
            └─ 3D floor podium & panoramic parallax layer
```

---

## 2. Granular Implementation Steps

### Step 1: Frontend Logic & Safety Hardening (`ai-image-workbench.ts`)
1. Implement `normalizedAngle = computed(() => ((this.orbitAngle() % 360) + 360) % 360)`.
2. Add delta-time tracking to `startAutoSpin()` using `performance.now()`.
3. In `onStagePointerMove()`, implement ergonomic viewing arc:
   - When in front-facing mode, clamp continuous drag to $[-65^\circ, +65^\circ]$ and vertical tilt to $[-16^\circ, +16^\circ]$.
   - When user clicks `180° Sau lưng`, transition smoothly to $180^\circ$ back view.
4. Enforce strict female whitelist:
   - `if (asset.gender !== 'female') return false;`
   - In `chooseMode('studio')` and `open()`, pick initial model from `filteredStudioAssets()` rather than unfiltered raw capabilities.
5. Fix title regex in `modelDisplayTitle`:
   - `/^(Người mẫu\s*)?(Nữ|Nam)\s*[-–]?\s*/i` to display crisp scenario titles on cards.
6. Delete obsolete `switchGender` dead code.
7. Hook `stopAutoSpin()` in `close()` and `onDestroy()`.

### Step 2: Template Bindings & Dialog Event Safety (`ai-image-workbench.html`)
1. Bind `<dialog #dialog (cancel)="close()" (close)="close()">` to ensure `ESC` key stops the animation frame loop.
2. Bind active preset classes to `normalizedAngle()`:
   - `Trước (0°)`: `normalizedAngle() <= 20 || normalizedAngle() >= 340`
   - `Nghiêng (45°)`: `normalizedAngle() >= 30 && normalizedAngle() <= 65`
   - `Sau lưng (180°)`: `normalizedAngle() >= 160 && normalizedAngle() <= 200`
3. Result scenario toolbar:
   - Bind active class: `activeScenario().id === sc.id` so a pill is always active even if `selectedScene` was `'all'`.

### Step 3: CSS 3D Layering & Budget Compliance (`ai-image-workbench.css`)
1. Ensure `.model-face` declares `transform-style: preserve-3d;` so `.perspective-card__tag` translates along Z-axis properly.
2. Keep component style size well under the 24kB hard build error budget.

### Step 4: Unit Test Suite Expansion (`ai-image-workbench.spec.ts`)
1. Add test: female-only model filtering (rejects male or unspecified models).
2. Add test: 3D orbit angle presets (`setAnglePreset(0)`, `setAnglePreset(45)`, `setAnglePreset(180)`).
3. Add test: `autoSpin` lifecycle cancellation on modal close and component destroy.
4. Add test: Zoom clamping ($1.0\times - 1.8\times$).
5. Add test: Scenario backdrop switching.
