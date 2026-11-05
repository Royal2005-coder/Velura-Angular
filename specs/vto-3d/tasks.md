# Tasks: VTO 3D

**Input:** [spec.md](./spec.md), [plan.md](./plan.md)

## M1 — Worker (apps/ai-worker)
- [x] T001 `apps/ai-worker/reconstruction_3d.py`: u2net cutout (onnxruntime) → TSR forward → `render()` 24 view → một sheet PNG tiled (6×4, tile 512). hàm `turntable(image, frames)` trả `{sprite, frames, columns, rows, tile}`.
- [x] T002 Wiring đúng đường production: `production_service.py` nhận task `/ai/try-on-3d` (`virtual_try_on_3d`) chạy **sau** khi 2D đã lưu, deadline riêng 420s. (`infer.py` không nằm trong image → block 3D ở đó đã bị gỡ.)
- [x] T003 Capability: `/ready` và `/health` trả `tasks.virtual_try_on_3d` chỉ khi CUDA + weights + vendor tree hợp lệ; `weights-manifest.json` velura-worker-v3 thêm `TripoSR/config.yaml` (MIT) và `TripoSR/image_tokenizer/config.json` (Apache-2.0) với checksum publisher; receipt `verified-inventory.json` do `bootstrap_weights.py` ghi.
- [x] T004 Vendoring + deps: `vendor_triposr.py` tải `tsr/` theo revision pin, verify blob sha1, vá torchmcubes→scikit-image / omegaconf→`tsr_config.py` / rembg+imageio→lazy import, loại `bake_texture.py`; `requirements-production.txt` thêm `transformers==4.44.2 tokenizers==0.19.1 scikit-image==0.24.0 scipy==1.13.1 imageio==2.36.1 tifffile==2024.8.30 lazy-loader==0.4` (đã verify resolve với `--only-binary`, numpy 1.26.4 giữ nguyên).
- [x] T005 Unit tests mock (`test_reconstruction_3d.py`): availability fail-closed từng điều kiện, cutout không kéo `rembg` vào, `_condition` centring, sheet slicing, thiếu frame → RuntimeError. `python -m unittest discover -s apps/ai-worker`.

## M2 — API (apps/api)
- [x] T006 `ai-service.ts`: `render3d` chỉ nhận cho `virtual_try_on`, bền hoá trong `job.worker.render_3d` (nằm trong idempotency fingerprint) → resume/poll vẫn biết khách có yêu cầu 3D.
- [x] T007 Stage + serving: `cluster-worker.turntable()` gọi `/ai/try-on-3d` (binding + attestation như try-on thường), `publishTurntable()` cắt sheet bằng `sharp` rồi ghi `render3d/frame-0NN.png`; `resultFile()` chỉ phục vụ basename có trong `job.frames3d`; `view()` publish `frames3d`.
- [x] T008 Tests API (`tests/api/ai-engine.test.ts`): studio + render3d → 12 frames slicing đúng ô, tên lạ → `RESULT_UNAVAILABLE`; stage fail (503) → job 2D vẫn `success` và `frames3d` absent.

## M3 — Frontend (apps/user-ng)
- [x] T009 `ai-image-workbench`: gửi `render3d: mode === 'studio'`, `load3dArtifacts()` fetch frame theo basename, drag→index, autospin delta-time; tilt-CSS là fallback khi không có frames.
- [ ] T010 Nút "Tải mô hình 3D (.glb)": **hoãn** — xem T016.
- [x] T011 Thẻ scene (US-002): badge trùng title bị bỏ hẳn (`modelDisplayTitle` tách 'Người mẫu Nữ / Bối cảnh / occasion' khỏi label), nên thẻ chỉ còn title = bối cảnh + dấu chọn khi đang hoạt động.
- [x] T012 Loading panel: stepper có bước 5 "360°" và message "Đang dựng tuần tự 24 góc nhìn…" khi mode studio (không để người dùng đoán vì sao job lâu).

## M4 — Cluster & tài liệu
- [x] T013 Dockerfile ai-worker: bước `python vendor_triposr.py --destination=/vendor` trong stage dependencies, `PYTHONPATH=/app:/opt/vendor`, copy `reconstruction_3d.py` + `tsr_config.py`; `worker.yaml` đặt `TRIPOSR_IMAGE_TOKENIZER_CONFIG=/weights/TripoSR/image_tokenizer` (không có flag `VTO_3D_ENABLED` — capability do worker báo).
- [ ] T014 Canary + đo: apply Job `provision-weights` (velura-worker-v3) trước, rồi cho Flux roll ảnh worker mới; chạy một try-on studio thật, ghi VRAM đỉnh + latency vào `specs/vto-3d/converge.md`.
- [ ] T015 PR theo pipeline (develop → sync → promote → release → pin → reconcile), spec-kit converge: mọi FR có acceptance xanh.
- [ ] T016 `.glb` export (deferred): một response chỉ mang một artifact, nên mesh cần kênh riêng (multipart hoặc request thứ hai trả `model/gltf-binary`). UI đã bỏ nút tải để không hứa thứ chưa có.

## Dependencies
- T002→T001; T006/T007→T002; T009→T006/T007; T013→T003/T004; T014→T013+T015. T011 độc lập.
