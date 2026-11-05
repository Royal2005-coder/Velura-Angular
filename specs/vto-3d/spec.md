# Feature Specification: VTO 3D — Phòng thử đồ 3D đa khung hình theo bối cảnh

**Created:** 2026-11-04 | **Status:** Draft | **Branch:** KAN-66
**Input:** User requests a true 3D virtual try-on on the existing RTX 4060 cluster (IDM-VTON-style pipeline, TripoSR reconstruction, 360° turntable), female-only models, and per-season 3D backgrounds. Scope is an educational MVP, and `bootstrap_weights.py` still admits only MIT / Apache-2.0 artifacts, so every weight must be verifiably permissive before it is provisioned.

## User Stories

### US-001: Xoay 360° kết quả thử đồ (Priority: P1)
Khách thử đồ xong được **kéo/swipe xoay nhân vật đủ 360°** trong khung cảnh 3D, thấy trước–sau–hai bên của trang phục, không chỉ một ảnh phẳng.

**Acceptance**
- Kết quả sinh ra ≥ 24 khung hình render từ các góc đều nhau của cùng một mesh; viewer phát lại theo drag và có autospin.
- Có nút tải file `.glb` xem được ngoài Windows 3D Viewer/Blender.
- Host ảnh + mesh tuân thủ retention hiện hành của pipeline VTO (xóa theo job, không CDN công khai).

### US-002: Bối cảnh 3D theo mùa/occasion (Priority: P1)
Mỗi scene đã chọn (Studio Chuẩn, Mùa Xuân/Hạ/Thu/Đông, Công sở, Đạo phố, Dạ tiệc) là một **không gian 3D thật** (nền có chiều sâu, ánh sáng hợp mùa), không phải ảnh nền phẳng ghép sau.

**Acceptance**
- Scene chọn ở UI điều khiển cả môi trường render (geometry nền + lighting rig) lẫn prompt trang phục theo mùa.
- Đổi scene không đổi nhận dạng người mẫu; người mẫu luôn nữ (web thời trang nữ).
- Thẻ scene hiển thị title = bối cảnh, badge = occasion tiếng Việt (Đi học/Đi chơi/Sang trọng…), **không trùng title** (bug hiện trạng: "Mùa Thu / Mùa Thu").

### US-003: Ảnh của khách và ảnh studio (Priority: P2)
Hai mode hiện có (ảnh cá nhân / người mẫu studio) giữ nguyên consent flow; 3D bật theo lựa chọn, mặc định tắt để không chặn người yếu máy.

**Acceptance:** Job không bật `render_3d` cho kết quả 2D y như hôm nay (no regression); job bật 3D trả thêm frames+glb, hết hạn theo cùng TTL artifact.

## Functional Requirements
- **FR-001:** Worker thêm stage tái tạo 3D sau bước 2D: background-removal → single-image 3D reconstruction (TripoSR) → render turntable N khung (PyTorch3D, fallback trimesh software) → export `.glb`.
- **FR-002:** Capability mới `tryon_3d` quảng bá qua `/health` khi weights có sẵn; thiếu weights thì job 3D fail rõ mã `RENDER_3D_UNAVAILABLE`, job 2D không bị ảnh hưởng.
- **FR-003:** API contract: request VTO chấp nhận `render3d: boolean`; result có `frames3d: string[]` (URL ký tạm) + `glb_url` khi 3D thành công.
- **FR-004:** Frontend viewer: tuần tự frames theo góc (image-based turntable) thay vì tilt CSS trên ảnh phẳng; giữ cơ chế 3D tilt làm fallback khi job không có frames.
- **FR-005:** Mọi nội dung model-facing giữ nguyên gate consent/validated-person hiện có; không mở đường sinh ảnh người thật mới.
- **FR-006:** Giới hạn tài nguyên: job 3D chạy trên GPU worker với timeout riêng lớn hơn 2D (≥ 240s) và queue một slot 3D song song, không starvation job 2D.
- **FR-007:** License: chỉ dùng model weights được phép cho phạm vi môn học (NC); file spec ghi nguồn + license từng weight để hội đồng kiểm.

## Out of Scope
- Realtime 60fps mesh rendering trên web (WebGL viewer chỉ là viewer tĩnh .glb/frames).
- May pattern / cloth physics mô phỏng rơi vải cơ học.
- Người mẫu nam (web nữ — đã chốt female-only).

## Clarifications
- [CLARIFY-001] VRAM 4060: chạy tuần tự 2D→3D trong một job hay tách 2 job? Mặc định đề xuất: một job, hai phase, progress UI theo phase.
- [CLARIFY-002] Số khung: 24 hay 36? Mặc định 24 (khởi động nhanh, ~10MB/job); nâng 36 nếu chất lượng yêu cầu.
