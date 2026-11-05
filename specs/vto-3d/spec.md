# Feature Specification: VTO 3D — Phòng thử đồ 3D đa khung hình theo bối cảnh

**Created:** 2026-11-04 | **Status:** Implemented (2D + 360° stage on the cluster) | **Branch:** KAN-66
**Input:** User requests a true 3D virtual try-on on the existing RTX 4060 cluster (TripoSR reconstruction, 360° turntable), female-only models, and per-season studio backdrops. Scope is an educational MVP, and `bootstrap_weights.py` still admits only MIT / Apache-2.0 artifacts, so every weight must be verifiably permissive before it is provisioned.

## User Stories

### US-001: Xoay 360° kết quả thử đồ (Priority: P1)
Khách thử đồ xong được **kéo/swipe xoay nhân vật đủ 360°**, thấy trước–sau–hai bên của trang phục, không chỉ một ảnh phẳng.

**Acceptance**
- Kết quả sinh ra ≥ 24 khung hình render từ các góc đều nhau của cùng một tái tạo; viewer phát lại theo drag và có autospin.
- Host ảnh tuân thủ retention hiện hành của pipeline VTO (xóa theo job, không CDN công khai).
- DEFERRED: nút tải `.glb`. Một response chỉ mang một artifact, nên mesh cần kênh riêng (T016) thay vì mở rộng transport cho cả khung hình.

### US-002: Bối cảnh theo mùa/occasion (Priority: P1)
Mỗi scene đã chọn (Studio Chuẩn, Mùa Xuân/Hạ/Thu/Đông, Công sở, Đạo phố, Dạ tiệc) điều khiển bối cảnh studio và prompt trang phục theo mùa.

**Acceptance**
- Scene chọn ở UI đổi ảnh nền studio và định hướng trang phục theo mùa.
- Đổi scene không đổi nhận dạng người mẫu; người mẫu luôn nữ (web thời trang nữ).
- Thẻ scene hiển thị title = bối cảnh, badge = occasion tiếng Việt (Đi học/Đi chơi/Sang trọng…), **không trùng title**.

### US-003: Ảnh của khách và ảnh studio (Priority: P2)
Hai mode hiện có (ảnh cá nhân / người mẫu studio) giữ nguyên consent flow; 3D bật theo mode studio.

**Acceptance:** Job không bật `render3d` cho kết quả 2D y như hôm nay (no regression); job bật 3D trả thêm `frames3d`, hết hạn theo cùng TTL artifact, và **2D vẫn success khi 3D fail**.

## Functional Requirements
- **FR-001:** Worker có task riêng `/ai/try-on-3d` (`virtual_try_on_3d`) chạy sau khi 2D đã lưu: u2net cutout → TSR (TripoSR) forward → `render()` 24 view NeRF → **một sheet PNG tiled** (6×4, tile 512px). API cắt sheet thành `render3d/frame-000.png…frame-023.png`. Không PyTorch3D, không `trimesh.save_image`: ảnh runtime không có OpenGL context.
- **FR-002:** Capability quảng bá qua `/ready` và `/health` bằng `tasks.virtual_try_on_3d`; nó chỉ true khi CUDA + weights + vendor tree hợp lệ. Thiếu một trong ba, API không gửi stage, người dùng vẫn nhận kết quả 2D.
- **FR-003:** API contract: request VTO chấp nhận `render3d: boolean` (bền hoá trong `job.worker.render_3d`, tính cả idempotency fingerprint); job view trả `frames3d: string[]`. Tên frame chỉ phục vụ khi khớp đúng bản ghi job (`resultFile` so basename, không đoán bằng regex).
- **FR-004:** Frontend viewer: tuần tự frames theo góc (image-based turntable) thay vì tilt CSS trên ảnh phẳng; giữ tilt làm fallback khi job không có frames.
- **FR-005:** Mọi nội dung model-facing giữ nguyên gate consent/validated-person hiện có; không mở đường sinh ảnh người thật mới.
- **FR-006:** Giới hạn tài nguyên: stage 3D có deadline riêng 420s (API nới abort tương ứng), dùng chung một GPU slot với 2D nên job 2D đồng thời nhận 429 và backoff — không starvation, không cần queue thứ hai.
- **FR-007:** License: `weights-manifest.json` là nguồn sự thật (TripoSR `model.ckpt` + `config.yaml`: MIT; u2net và DINO-ViT `config.json`: Apache-2.0); `bootstrap_weights.py` từ chối mọi license ngoài MIT/Apache-2.0 và ghi `verified-inventory.json` theo sha256 publisher.

## Out of Scope
- Realtime 60fps mesh rendering trên web (viewer là ảnh theo góc).
- Xuất `.glb` / mesh download (T016, cần kênh artifact đa tệp).
- May pattern / cloth physics mô phỏng rơi vải cơ học.
- Người mẫu nam (web nữ — đã chốt female-only).

## Clarifications
- [CLARIFY-001] VRAM 4060: **đã chốt** — tách thành request thứ hai cho cùng job, sau khi ảnh 2D đã ghi đĩa. Một request chứa cả hai phase sẽ vượt deadline 180s và giữ GPU slot quá lâu.
- [CLARIFY-002] Số khung: **đã chốt 24** (`MIN_FRAMES` 12, `MAX_FRAMES` 36). Sheet tiled 6×4 để giảm chi phí encode/decode so với 24 lần đọc PNG.
