# Feature Specification: 3D Spatial Scenarios & Multi-Angle Female Model Viewer for Velura Virtual Try-On

**Feature ID**: `FEAT-VTO-3D-SCENARIOS`  
**Jira/Ticket**: `KAN-66`  
**Status**: APPROVED (Incorporated EGM Adversarial Swarm Synthesis)  
**Date**: 2026-11-03  
**Target Architecture**: Hardware-accelerated CSS 3D perspective compositor + dynamic panoramic parallax and tailored dual-perspective inspection. Strictly 0 KB external bundle bloat.

---

## 1. Business Intent & Operational Scope

### 1.1 Intent
Velura Atelier is an exclusive contemporary women's fashion design house. The Virtual Try-On (VTO) experience must reflect Velura's luxury aesthetic:
1. **Exclusively Female Models**: Male model options are permanently eliminated across all layers (manifest, K8s ConfigMap, API filtering, and storefront UI).
2. **8 Curated Fashion Scenarios**:
   - `basic`: Studio Chuẩn (Atelier Minimalist Studio `#FAF6F0` with spotlight & podium)
   - `spring`: Mùa Xuân (Spring Blossom Garden with delicate pink dawn lighting)
   - `summer`: Mùa Hạ (Azure Coastal Terrace with Mediterranean golden sunlight)
   - `autumn`: Mùa Thu (Parisian Boulevard with warm amber foliage)
   - `winter`: Mùa Đông (Nordic Winter Lounge with silver crystal ambiance)
   - `work`: Công sở (Modern Glass Atrium & Executive Lounge)
   - `street`: Dạo phố (Chic European Boutique Promenade)
   - `party`: Dạ tiệc (Grand Gala Ballroom with champagne bokeh & chandelier illumination)
3. **Interactive 3D Spatial Viewer**:
   - Ergonomic continuous viewing arc ($-65^\circ \to +65^\circ$ azimuth, $\pm 16^\circ$ elevation) preventing cardboard cutout flattening.
   - Discrete inspection angle presets: `Trước (0°)`, `Nghiêng (45°)`, `Sau lưng (180°)`, and `Tự xoay 360° (Auto-spin)` with delta-time capped speed ($36^\circ/\text{s}$).
   - Tailored Back View ($180^\circ$) rendering the model's rear silhouette with spine seam line, waist darts, and matching back drape.
   - 3D panoramic parallax backdrop shifting smoothly with camera azimuth.
   - 3D rotating floor podium with radial contact shadow.
   - Zoom controls ($1.0\times - 1.8\times$) for close-up fabric inspection.

---

## 2. Technical Contracts & Invariants

### 2.1 Scenario Schema (`VtoScenario`)
```typescript
export interface VtoScenario {
  id: 'basic' | 'spring' | 'summer' | 'autumn' | 'winter' | 'work' | 'street' | 'party';
  label: string;
  badge: string;
  description: string;
  theme: 'light' | 'dark' | 'warm' | 'cool';
  backgroundGradient: string;
  lightingTone: string;
  vignetteStyle: string;
  podiumStyle: string;
}
```

### 2.2 Mathematical Modulo & Angle Invariant
- Normalized angle: `normalizedAngle = ((orbitAngle % 360) + 360) % 360`.
- Continuous drag clamped to $[-65^\circ, +65^\circ]$ in standard mode, or switched to discrete $180^\circ$ back view.
- Preset active highlights bind exclusively to `normalizedAngle`.

### 2.3 Lifecycle & Memory Safety
- Native `<dialog (cancel)="close()" (close)="close()">` prevents RAF loop leaks on keyboard `Escape`.
- `this.stopAutoSpin()` invoked on modal close, component destruction, and session reset.
- Pointer capture with `try / catch` release safety.

---

## 3. Acceptance Verification Criteria
1. `filteredStudioAssets` contains strictly female models (`asset.gender === 'female'`).
2. Switching scenarios in result toolbar immediately updates `activeScenario` background and highlights the active pill.
3. Native `ESC` key dismisses modal and terminates the auto-spin RAF loop completely.
4. Auto-spin rate is normalized by delta time ($\approx 36^\circ/\text{s}$) across 60Hz, 120Hz, and 240Hz screens.
5. All 22+ unit tests in `ai-image-workbench.spec.ts` pass, with new tests verifying all 3D controls, angle presets, and scenario switches.
