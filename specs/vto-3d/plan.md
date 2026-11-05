# Implementation Plan: VTO 3D

**Spec:** [spec.md](./spec.md) | **Performance:** 2D path unchanged; the 360° stage is a second worker request with its own 420s budget.

## Technical Context
- **Worker:** `apps/ai-worker` chạy production qua `production_service.py` (`/ai/try-on`). `infer.py` là đường Colab/simulation và **không có trong image** (`deploy/docker/ai-worker/Dockerfile` chỉ copy `production_*.py` + `maskless_vton.py` + `image_gate.py` + `bootstrap_weights.py`), nên stage 3D nối vào service thật, không nối vào `infer.py`.
- **Recon:** `tsr/` của TripoSR được **vendor** — `vendor_triposr.py` tải đúng revision đã pin, verify git blob sha1, rồi vá: `torchmcubes` → scikit-image marching cubes, `omegaconf` → `tsr_config.py`, `rembg`/`imageio` → import lazy, DINO-ViT `config.json` đọc từ PVC (pod không có egress). `tsr/bake_texture.py` loại khỏi tree (cần xatlas + OpenGL). Tham khảo kiến trúc `areebrehmanai/styleai-virtual-tryon`, không vendoring code repo đó.
- **Renderer:** `TSR.render()` (NeRF gốc) cho 24 view ở **tile 256** — đo trên RTX 4060: 39.5s và 2.17 GiB VRAM peak khi 2D model còn resident; 512 chết ở tensor ray-sample (không chunk). `trimesh.save_image` không dùng vì cần GL context; `.glb` export hoãn (T016).
- **Transport:** worker trả **một** PNG body + header `X-AI-Result` (base64 JSON) — sheet tiled thoả hợp đồng này mà không phải bịa kênh đa tệp. API cắt sheet bằng `sharp` (đã là dependency).
- **Bootstrap:** `weights-manifest.json` velura-worker-v3 thêm `TripoSR/config.yaml` và `TripoSR/image_tokenizer/config.json`; checksum lấy từ publisher, không tự đặt.
- **Frontend:** `ai-image-workbench` dùng frames theo góc (drag→index, autospin delta-time), tilt-CSS là fallback.

## Milestones
1. **M1 Worker** — `vendor_triposr.py` + `tsr_config.py` + `reconstruction_3d.turntable()` + task `/ai/try-on-3d` + capability `tasks.virtual_try_on_3d` + unit tests mock (CI không cần GPU).
2. **M2 API** — `render3d` bền hoá, stage call sau khi 2D success, `sharp` slice sheet, publish `frames3d`, serve theo basename đã ghi trong job, tests.
3. **M3 Frontend** — viewer turntable; fallback tilt khi thiếu frames; scene card badge fix (US-002).
4. **M4 Cluster** — ảnh worker mới + PVC weights (Job `provision-weights`), đo VRAM/latency thực tế trên RTX 4060; số liệu đưa vào report môn học.

## Risk / Decisions
- VRAM 8GB: 2D và 3D resident đồng thời (ProductionModels + TSR). Nếu OOM, stage fail `INFERENCE_FAILED`, 2D vẫn thành công — theo dõi log `AI_TURNTABLE_STAGE_FAILED` và giảm `TILE`/`frames` nếu cần.
- Marching cubes/`extract_mesh` không còn trên đường đi → chi phí GPU chủ yếu là `render()` 24 view.
- Một GPU slot: stage 3D chiếm slot nên job 2D song tốc nhận 429 + backoff (hành vi có chủ ý, không starvation).
- TripoSR trên người mặc đồ cho mesh "khối" hơn là người — chấp nhận ở mức demo môn học; UI mô tả là ảnh xoay góc tái tạo, không phải avatar 3D.
