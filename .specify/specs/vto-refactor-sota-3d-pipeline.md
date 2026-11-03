# Feature Specification: SOTA Virtual Try-On (2D Upload + 3D 360° Studio) Refactoring

**Feature ID**: `FEAT-VTO-REFACTOR-SOTA-3D`  
**Jira/Ticket**: `KAN-66`  
**Reference Repositories**:
1. `https://github.com/Miragic-AI/VirtualTryOn` (SOTA Diffusion Virtual Try-On: IDM-VTON, CatVTON, OOTDiffusion)
2. `https://github.com/areebrehmanai/styleai-virtual-tryon` (IDM-VTON + TripoSR / PyTorch3D single-image 3D mesh & 360° turntable)
3. `https://github.com/YuliangXiu/ICON` (Implicit Clothed humans from Normals: SMPL-X guided 3D avatar & garment geometry)

**Target Scope**:
- Storefront User SPA (`@velura/user-ng`): `ai-image-workbench` with Mode 1 (Personal Upload) and Mode 2 (Studio 3D 360°).
- Node.js API (`@velura/api`): VTO job orchestration, validation gates, asset staging.
- Python AI Worker (`@velura/ai-worker`): K3s GPU deployment, inference pipeline, VRAM memory management.
- K8s Cluster Infrastructure (`deploy/k8s/`): GPU node scheduling, resource limits, model weights storage.

---

## 1. System Requirements & User Modes

### Mode 1: Personal Photo Try-On (Gửi ảnh lên)
- **Input**: Customer uploads their personal full-body or half-body photo + selects a product variant (garment flat-lay).
- **Validation**: Photometric and pose quality gate (brightness, contrast, resolution, single person detection via OpenPose/DWPose).
- **Processing**: SOTA Diffusion Try-On model (preserving customer face, skin tone, hair, background scenery, while wrapping the garment with accurate texture, seams, and natural drape).
- **Output**: High-resolution photorealistic try-on result with before/after comparison and zoom.

### Mode 2: Studio 3D 360° Spatial Try-On (Model 3D 360° xoay trong không gian bối cảnh)
- **Input**: Selected female studio model avatar in 1 of 8 standard fashion scenarios (`Studio Chuẩn`, `Mùa Xuân`, `Mùa Hạ`, `Mùa Thu`, `Mùa Đông`, `Công sở`, `Dạo phố`, `Dạ tiệc`) + product variant.
- **3D Interactive Experience**:
  - Full 360° horizontal camera orbit rotation around the model.
  - Vertical tilt ($\pm 20^\circ$) to inspect from above (collar, shoulders) and below (hemline, drape).
  - Volumetric 3D spatial room with floor perspective, back/side panoramic scenario walls, and ceiling lighting.
  - Multi-angle perspectives: Mặt trước (0° Front), Nghiêng 45°, Cạnh hông (90°), and Sau lưng (180° Back) with tailored spine seam, darts, and zipper.
  - Auto-spin 360° loop and fabric zoom ($1.0\times - 1.8\times$).

---

## 2. Cluster Deployment & Hardware Feasibility Assessment

### Current Hardware Baseline:
- Worker Node: 1x NVIDIA GPU (RTX 4060 with 8GB VRAM) or equivalent cluster worker.
- Current Active Models:
  - FASHN-VTON TryOnModel (`bfloat16`, ~3.8GB VRAM)
  - OpenCLIP ViT-B/32 (CPU, 512-dim embedding)
  - Apache U2Net ONNX (CPU, background segmentation)
- Available VRAM Headroom: ~3.5GB to 4.0GB VRAM.

### Reference Models Evaluation:
1. **IDM-VTON (from Miragic-AI & styleai-virtual-tryon)**:
   - Base: SDXL (Stable Diffusion XL) + Garment UNet + IP-Adapter.
   - VRAM Requirements: Default requires 16GB+ VRAM; with FP16 + CPU offloading / xFormers / FlashAttention, can run in 7.5GB - 8.2GB VRAM.
   - Risk on 8GB VRAM: Severe OOM risk without strict memory optimization (sequential CPU offload, tile VAE, sliced attention).
2. **TripoSR (from styleai-virtual-tryon)**:
   - Base: LGM / NeRF-to-mesh feed-forward transformer.
   - VRAM Requirements: ~6GB VRAM, generates unrigged low-poly `.glb` mesh in 0.5s - 2s.
   - Risk: Output mesh lacks clean UV unwrapping and has muddy texture artifacts on thin fabric/seams. Running concurrently with VTON will immediately exceed 8GB VRAM.
3. **ICON (from YuliangXiu/ICON)**:
   - Base: SMPL-X body estimator + normal prediction network + IF-Net implicit function surface reconstruction.
   - Requirements: PyTorch3D, SMPL-X models, PyMAF, multiple complex CUDA extensions.
   - Latency: 30s - 90s per single image reconstruction.
   - VRAM: 8GB - 12GB during voxel marching cubes. Heavy dependency matrix with strict GCC/CUDA compiler versions.

---

## 3. Production Architecture Strategy

To deliver an ultra-responsive, production-grade 3D VTO experience that **does not crash the cluster GPU**:
1. **Decoupled 2-Stage Pipeline**:
   - **Stage A (2D Generative VTO)**: Fast diffusion try-on on GPU worker (generating photorealistic front view).
   - **Stage B (3D Spatial Presentation & Multi-View Reconstruction)**:
     - Real-time client-side hardware-accelerated 3D spatial room compositor with volumetric mannequin geometry, panoramic scenario environment, and tailored rear/profile perspective projection.
     - Asynchronous 3D mesh export (`.glb` / turntable) generated on-demand when requested by customer for 3D download.
