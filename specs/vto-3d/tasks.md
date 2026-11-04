# Tasks: VTO 3D

**Input:** [spec.md](./spec.md), [plan.md](./plan.md)

## M1 — Worker (apps/ai-worker)
- [ ] T001 Tạo `apps/ai-worker/reconstruction_3d.py`: remove bg (rembg u2net) → TripoSR mesh → 24 khung turntable (PyTorch3D, fallback trimesh) → `frames3d/000.png…023.png` + `model.glb`; hàm pure `render_turntable(result_path, out_dir, frames=24)` dễ mock.
- [ ] T002 Wiring `apps/ai-worker/infer.py::virtual_try_on`: nếu `job.get("render_3d")` → chạy T001 sau `result.png`, unload model 2D + `torch.cuda.empty_cache()` trước; thêm `frames3d`, `glb_file` vào result dict; lỗi → `RENDER_3D_UNAVAILABLE` không phá result 2D.
- [ ] T003 Capability: `production_models.py` báo `tryon_3d: true` khi weights tồn tại; `bootstrap_weights.py` tải TripoSR + u2net (checksum, ghi license CC BY-NC-SA vào header comment — FR-007).
- [ ] T004 `requirements-production.txt`: +tripo (pinned), +rembg, +pytorch3d hoặc trimesh fallback; CI test không cài pytorch3d → fallback phải pass.
- [ ] T005 Unit tests mock (`apps/ai-worker/test_reconstruction_3d.py`): contract result, flag tắt → không import torch 3D, fail 3D → 2D vẫn success. Chạy `npm run test-ai-worker`.

## M2 — API (apps/api)
- [ ] T006 `ai-service.ts`: chấp nhận `render3d` boolean trong body try-on, forward vào job; validate chỉ khi task virtual_try_on.
- [ ] T007 Artifact serving: mở rộng danh sách file result (`frames3d/*.png`, `model.glb`) qua cùng signed-URL + retention; timeout job 3D ≥ 240s; 1 queue slot 3D riêng (FR-006).
- [ ] T008 Tests API: render3d off → payload như cũ; on → result có frames3d/glb; artifact ngoài allowlist bị chặn.

## M3 — Frontend (apps/user-ng)
- [ ] T009 `ai-image-workbench`: gửi `render3d` theo toggle "Xem 3D"; viewer tuần tự frames theo drag (index = angle), autospin dùng frames thật; fallback tilt-CSS hiện tại khi job không có frames (FR-004).
- [ ] T010 Nút "Tải mô hình 3D (.glb)" trong result toolbar (icon SVG cùng hệ, không emoji).
- [ ] T011 Sửa thẻ scene (US-002): badge = occasion tiếng Việt lấy từ `asset.occasion` (Đi học/Đi chơi/Sang trọng/Công sở…), bỏ badge tiếng Anh 'Atelier'…; title không đổi. Test spec: không asset nào có badge === title.
- [ ] T012 Loading panel thêm phase "Đang dựng mô hình 3D" khi render3d (stepper hiện có).

## M4 — Cluster & tài liệu
- [ ] T013 Dockerfile ai-worker: layer weights TripoSR/u2net vào image hoặc PVC `ai-private` như studio-assets; env `VTO_3D_ENABLED` mặc định false.
- [ ] T014 Canary: bật `VTO_3D_ENABLED` trên 1 product, đo VRAM đỉnh + p95 latency qua job metrics; ghi số liệu vào `specs/vto-3d/converge.md`.
- [ ] T015 PR theo pipeline (develop → promote → pin), spec-kit converge: mọi FR có acceptance xanh.

## Dependencies
- T002→T001; T006/T007→T002; T009→T006/T007; T013→T003; T014→T013. T011 độc lập (làm trước được).
