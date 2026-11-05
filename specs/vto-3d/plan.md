# Implementation Plan: VTO 3D

**Spec:** [spec.md](./spec.md) | **Performance:** 2D path unchanged; 3D adds ~60–150s/job on RTX 4060.

## Technical Context
- **Worker:** `apps/ai-worker` (Python, LEFFA VTON hiện hữu, `infer.py::virtual_try_on` trả `result.png`). Stage 3D nối ngay sau `result.png` — không đụng model 2D.
- **Recon:** TripoSR (stabilityai, **MIT** — HF `license:mit`, ghi nguồn FR-007) + u2net (Apache-2.0) + PyTorch3D render, fallback `trimesh`. Tham khảo pipeline `areebrehmanai/styleai-virtual-tryon` (reconstruction_3d.py) — **không vendor code** của repo tham khảo vào source; chỉ tham khảo kiến trúc, tự implement.
- **Bootstrap:** `bootstrap_weights.py` thêm URL TripoSR + u2net, checksum như pattern `virtual_tryon_dc.pth`.
- **API:** `apps/api/src/ai/ai-service.ts` — trường `render3d` trong job body; artifact list mở rộng `frames3d/*` + `model.glb` qua cùng cơ chế signed URL.
- **Frontend:** `ai-image-workbench` viewer đổi sang tuần tự frames (drag→index, autospin theo delta-time đã có từ KAN-66); fallback tilt-CSS khi không có frames.

## Milestones
1. **M1 Worker** — module `reconstruction_3d.py` + wiring `infer.py` + capability `tryon_3d` + unit tests mock (không cần GPU trong CI).
2. **M2 API** — contract `render3d`, artifacts, timeout/queue slot riêng, tests.
3. **M3 Frontend** — turntable frames viewer, nút tải .glb, scene card badge fix (US-002 acceptance), spec-kit converge.
4. **M4 Cluster** — Dockerfile + PVC weights, canary `render3d=true` trên 1 sản phẩm, đo VRAM/latency thực tế; số liệu đưa vào report môn học.

## Risk / Decisions
- VRAM 8GB: 2D và 3D không load đồng thời — unload trước khi recon (torch.cuda.empty_cache giữa phase).
- TripoSR trên người mặc đồ cho mesh "khối" hơn là người — chấp nhận ở mức demo môn học; ghi rõ trong UI là "mô hình 3D tái tạo".
- Scene 3D: pha nền theo mùa bằng geometry đơn giản (floor+cyc+bảng màu mùa) trong render rig — không cần asset ngoài.
