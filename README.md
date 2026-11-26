# Velura — Nền Tảng Thương Mại Điện Tử Thời Trang Ứng Dụng AI

**Học phần:** Phát triển Web Nâng cao  
**Mã lớp học phần:** `261BIE503101_07`  
**Kho mã nguồn chính thức (Canonical Repository):** https://github.com/Royal2005-coder/Velura-Angular  
**Hệ thống Production:** https://velura.royalai.dev

---

## 1. Thành viên nhóm thực hiện

| STT | Họ và tên | Mã số sinh viên | Mức độ đóng góp | Phạm vi phụ trách chính |
|---|---|---|---|---|
| 1 | Nguyễn Như Khải | K234060700 | 100% | Kiến trúc giao diện Frontend, Storefront Angular, hệ thống hình ảnh sản phẩm |
| 2 | Trần Diễm Quỳnh | K234060724 | 100% | Fullstack, Backend API, Chatbot AI & kiểm soát nghiệp vụ CSKH, CI/CD & hạ tầng |
| 3 | Nguyễn Tô Hoàng Gia | K234060689 | 100% | Fullstack, Backend API, CSDL Supabase, Thanh toán, AI Engine, DevOps/GitOps K3s |
| 4 | Nguyễn Phan Ngọc Hân | K234060691 | 100% | Phân tích nghiệp vụ, luồng mua hàng, đơn hàng, đổi trả/hoàn tiền và kiểm thử UAT |
| 5 | Nguyễn Trần Dạ Uyên | K234060737 | 100% | Thiết kế UI/UX, Frontend Angular (`user-ng`, `admin-erp-ng`), chuẩn hóa trải nghiệm người dùng |
| 6 | Đoàn Phương Ninh | K234060716 | 100% | Nghiệp vụ quản trị, khuyến mãi/voucher, nội dung, kiểm thử hệ thống và tài liệu |

---

## 2. Mục tiêu, Tầm nhìn và Sứ mệnh

### Mục tiêu
Xây dựng hoàn chỉnh một hệ thống thương mại điện tử thời trang theo chuẩn kiến trúc sản xuất (production-grade), tích hợp sâu các năng lực trí tuệ nhân tạo có kiểm soát (AI Stylist, Tìm kiếm ngữ nghĩa RAG, Thử đồ ảo Virtual Try-On, Chatbot tư vấn và CSKH phân tầng L0-L3), vận hành đồng bộ trên ba phân hệ chính (Storefront, Admin ERP, Backend HTTP API) với quy trình CI/CD và GitOps tự động.

### Tầm nhìn
Trở thành nền tảng bán lẻ thời trang trực tuyến cá nhân hóa lấy dữ liệu và trí tuệ nhân tạo làm trung tâm, nơi trải nghiệm tư vấn phong cách, chọn kích cỡ, thử trang phục và chăm sóc hậu mãi được số hóa nhất quán, minh bạch và đáng tin cậy.

### Sứ mệnh
- **Với khách hàng:** Rút ngắn hành trình từ cảm hứng phong cách đến quyết định mua hàng chính xác thông qua gợi ý dựa trên dữ liệu tồn kho và giá bán thời gian thực, quy trình thanh toán đa cổng an toàn và cơ chế theo dõi, đổi trả minh bạch.
- **Với đội ngũ vận hành:** Chuẩn hóa toàn bộ nghiệp vụ quản trị danh mục, tồn kho, đơn hàng, khuyến mãi, kiểm duyệt đánh giá và hỗ trợ khách hàng dựa trên phân quyền chi tiết (RBAC) và nhật ký kiểm toán (Audit Log).
- **Với tiêu chuẩn kỹ thuật:** Đảm bảo tính nhất quán dữ liệu ở tầng cơ sở dữ liệu (PostgreSQL RPC, khóa lạc quan, idempotency), tách biệt rõ ràng giữa lớp hiển thị, lớp nghiệp vụ và lớp dữ liệu, đồng thời duy trì khả năng kiểm chứng và tái lặp cao.

---

## 3. Các phân hệ triển khai (Production)

| Phân hệ | Mô tả | Liên kết Production |
|---|---|---|
| Storefront (Khách hàng) | Mua sắm, tài khoản, thanh toán, đổi trả, AI Stylist, VTO, Chatbot | https://velura.royalai.dev/ |
| Admin ERP | Phân hệ quản trị doanh nghiệp (RBAC 7 vai trò, CSKH, đơn hàng, sản phẩm, giá/khuyến mãi, nội dung, biểu đồ phân tích ECharts, mã QR vận hành) | https://admin-erp.royalai.dev/login |
| Backend HTTP API | Kiểm tra trạng thái dịch vụ và cổng API | https://velura.royalai.dev/api/health |

---

## 4. Công nghệ sử dụng (Tech Stack)

| Tầng hệ thống | Công nghệ chính | Vai trò |
|---|---|---|
| Frontend SPA | Angular 21 (Standalone Components, Signals), TypeScript 5.9, RxJS 7.8, Vitest 4 | Xây dựng phân hệ Storefront (`user-ng`) và Admin ERP (`admin-erp-ng`) không sử dụng `NgModule` |
| Trực quan hóa & QR | Apache ECharts 6 (`ngx-echarts`), `qrcode`, `jsqr` | Biểu đồ phân tích ERP, tạo và quét mã QR thanh toán/vận hành |
| Backend API | Node.js 22+ (ESM), TypeScript (`tsx` / `tsc`), HTTP Server thuần chuẩn hóa | Tách lớp `Router -> Service -> Repository`, kiểm soát nghiệp vụ, bảo mật, webhook và SSE |
| Cơ sở dữ liệu & Auth | Supabase (PostgreSQL, Auth/JWT, RLS, `pgvector`, SQL Migrations & RPC) | Lưu trữ giao dịch ACID, tìm kiếm vector 1536 chiều, xác thực thành viên và quản trị viên |
| Trí tuệ nhân tạo (AI/LLM) | LiteLLM Gateway, Google Gemini (`gemini-3.1-flash-lite-preview`, `gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-embedding-001`), Python AI Worker | Chatbot CSKH L0-L3 có kiểm duyệt, RAG sản phẩm, Decision Engine, Virtual Try-On (VTO) |
| Thanh toán & Thông báo | Stripe (Sandbox), VNPay (Sandbox/Signed Simulator), MoMo (Sandbox/Signed Simulator), COD, Nodemailer SMTP, Twilio/eSMS | Xử lý thanh toán đa phương thức, đối soát giao dịch, gửi email/OTP xác thực |
| Hạ tầng & DevOps | Docker, GitHub Actions, Cosign (Image Signing & SBOM), SOPS + Age, Kubernetes (K3s), Flux GitOps, Cloudflare, SeaweedFS S3 | Tự động kiểm thử, quét bảo mật, ký digest image, đồng bộ manifest và triển khai production |

---

## 5. Kiến trúc hệ thống và cấu trúc mã nguồn

### Nguyên tắc kiến trúc
- **Frontend (MVVM):** `View` = HTML Template; `ViewModel` = Angular Standalone Component sử dụng Signals; `Model` = Injectable Service giao tiếp qua `ApiService`. Không gọi `HttpClient` trực tiếp trong Page Component.
- **Backend (Layered Architecture):** `Router` chịu trách nhiệm phân tích HTTP và xác thực; `Service` sở hữu toàn bộ quy tắc nghiệp vụ, state machine và chính sách; `Repository` chịu trách nhiệm truy vấn Supabase/PostgreSQL RPC.
- **Data & AI Governance:**
  - Chuyển trạng thái đơn hàng, giữ tồn kho, tính điểm Loyalty và áp dụng voucher được kiểm soát chặt chẽ bằng máy trạng thái và ràng buộc cơ sở dữ liệu.
  - Chatbot vận hành theo cơ chế kiểm duyệt nội dung trước khi gửi cho CSKH, kiểm soát trích dẫn nguồn thực tế (grounding), chỉ tra cứu đơn hàng theo quyền sở hữu (Member) hoặc OTP xác thực (Guest), và giữ trạng thái fail-closed khi không đủ căn cứ pháp lý/chính sách.

### Cấu trúc thư mục

```text
velura-angular/
├── apps/
│   ├── user-ng/                # SPA khách hàng (Storefront, Checkout, Account, AI, Chatbot)
│   ├── admin-erp-ng/           # SPA quản trị doanh nghiệp (RBAC, Orders, Products, Promotions, CSKH, ECharts, QR, Audit)
│   ├── api/                    # Node.js TypeScript Backend API (Router -> Service -> Repository)
│   └── ai-worker/              # Python Worker xử lý tác vụ hình ảnh AI / Virtual Try-On
├── database/
│   └── migrations/             # Chuỗi SQL migration chuẩn hóa (schema, pgvector, RPC, governance)
├── deploy/
│   ├── k8s/                    # Manifests Kustomize (velura, observability/litellm, SOPS secrets)
│   ├── releases/               # Khóa phiên bản production digest đã ký
│   └── scripts/                # Công cụ hỗ trợ Git notes và vận hành
├── docs/                       # Tài liệu kiến trúc, quy trình Git/CI, onboarding, ADR
├── scripts/                    # Script migration, đánh giá AI Decision, kiểm tra hợp đồng hạ tầng
├── tests/                      # Bộ kiểm thử API, nghiệp vụ thanh toán, RBAC, chatbot, AI
├── tools/ops/                  # CLI vận hành và kiểm tra sức khỏe hạ tầng
├── .env.example                # Mẫu biến môi trường cho chạy cục bộ (không chứa secret)
└── package.json                # npm workspaces và các script build/start/test chuẩn hóa
```

---

## 6. Các phân hệ nghiệp vụ chính

1. **Xác thực, Tài khoản và Bảo mật (Auth & RBAC):**
   - Đăng ký/đăng nhập thành viên kèm OTP, đăng nhập SSO, quản lý hồ sơ, sổ địa chỉ hành chính Việt Nam, lịch sử đơn hàng, danh sách yêu thích, khóa tài khoản tạm thời/vĩnh viễn đồng bộ phiên theo thời gian thực.
   - Phân quyền quản trị 7 vai trò (`super_admin`, `admin_operator_sanpham`, `admin_operator_donhang`, `admin_operator_gia_km`, `admin_operator_danhgia_review`, `admin_operator_cskh_dt`, `admin_viewer`) kèm nhật ký kiểm toán.
2. **Danh mục, Giỏ hàng và Thanh toán đa cổng:**
   - Lọc và tìm kiếm sản phẩm theo từ khóa lẫn ngữ nghĩa (`pgvector`), đồng bộ tồn kho theo biến thể màu/kích cỡ.
   - Hỗ trợ 4 phương thức thanh toán: **COD**, **Thẻ quốc tế (Stripe Sandbox)**, **VNPay**, **Ví MoMo** kèm máy trạng thái đơn hàng, tự động giải phóng giữ chỗ tồn kho khi hết hạn thanh toán.
3. **Khuyến mãi, Voucher và Điểm thưởng (Loyalty):**
   - Ví voucher tự động đánh giá tính hợp lệ và đề xuất mã tối ưu cho cả Khách vãng lai và Thành viên; mã ưu đãi đăng ký nhận tin; tích lũy điểm thưởng, lịch sử giao dịch và mã giới thiệu bạn bè.
4. **Hậu mãi, Đổi trả / Hoàn tiền (RMA) và Đánh giá:**
   - Luồng yêu cầu đổi hàng / hoàn hàng / hoàn tiền theo chính sách 7 ngày và giới hạn số lần thành công trên từng đơn vị sản phẩm, theo dõi tiến trình xử lý và kiểm duyệt đánh giá sản phẩm.
5. **Hệ sinh thái AI (Stylist, VTO, Chatbot CSKH L0-L3, Blog AI):**
   - Trắc nghiệm phong cách (Style Quiz) và hồ sơ Style Profile; gợi ý trang phục cá nhân hóa; phòng thử đồ ảo (Virtual Try-On).
   - Chatbot Velura Assistant (SSE Streaming) hỗ trợ cả Guest và Member với đầy đủ 4 tầng xử lý: L0 (chính sách chính thức), L1 (tư vấn sản phẩm/size theo tồn kho thực), L2 (xử lý khiếu nại và xoa dịu không upsell), L3 (chuyển tiếp CSKH và tạo phiếu hỗ trợ), kèm bảng tra cứu đơn hàng bảo mật.

---

## 7. Quy trình phát triển, CI/CD và Vận hành

Nhánh **`main`** là nguồn chân lý duy nhất cho hệ thống Production hiện hành. Mọi thay đổi đều tuân theo quy trình GitOps khép kín:

```text
feature/KAN-n -> PR vào develop -> CI kiểm thử toàn diện (API, Angular, AI Worker, Manifests, Migrations)
              -> PR develop vào main -> Build Docker Images -> Quét lỗ hổng & sinh SBOM -> Ký Cosign
              -> PR cập nhật Production Image Digests -> develop -> main
              -> Flux GitOps tự động đồng bộ vào cụm Kubernetes (K3s) -> Xác minh Health & Revision
```

Tài liệu kỹ thuật chi tiết đi kèm trong kho mã nguồn:
- Quy chuẩn kỹ thuật và ràng buộc dự án: [AGENTS.md](AGENTS.md)
- Kiến trúc tổng thể: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Quy trình Git và CI/CD: [docs/GIT-AND-CI.md](docs/GIT-AND-CI.md)
- Sổ tay vận hành hệ thống: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)
- Quy trình làm việc nhóm: [docs/TEAM-WORKFLOW.md](docs/TEAM-WORKFLOW.md)
- Hướng dẫn onboarding: [docs/ONBOARDING.md](docs/ONBOARDING.md)
- Các quyết định kiến trúc dài hạn: [docs/adr/README.md](docs/adr/README.md)

---

## 8. Hướng dẫn tái lặp và chạy cục bộ (Local Reproduction)

Toàn bộ mã nguồn trên nhánh `main` đã đồng bộ hoàn toàn với bản triển khai Production và có thể chạy tái lặp cục bộ trực tiếp trên máy cá nhân mà không cần dựng cụm Kubernetes hay LiteLLM.

### Yêu cầu môi trường
- **Node.js:** phiên bản `>= 22` và `< 25` (khuyến nghị Node.js 22 LTS hoặc 24)
- **npm:** phiên bản `>= 10`
- **Git**

### Bước 1: Tải mã nguồn và cài đặt thư viện

```bash
git clone https://github.com/Royal2005-coder/Velura-Angular.git
cd Velura-Angular
git checkout main
npm install
```

### Bước 2: Thiết lập biến môi trường cục bộ

Sao chép tệp mẫu môi trường:

```bash
# Windows (PowerShell / Command Prompt)
copy .env.example .env

# macOS / Linux
cp .env.example .env
```

Mở tệp `.env` vừa tạo và điền các khóa kết nối (Supabase Cloud, Gemini API Key, Stripe Sandbox, SMTP) theo **Tài liệu bàn giao thông tin kiểm thử và cấu hình bảo mật (.docx)** được nộp kèm bài báo cáo. Đảm bảo giữ nguyên `NODE_ENV=development` khi chạy cục bộ để API gọi trực tiếp Gemini API mà không yêu cầu LiteLLM nội bộ trong Kubernetes.

### Bước 3: Khởi chạy các phân hệ

Mở các cửa sổ terminal riêng biệt tại thư mục gốc dự án và chạy các lệnh tương ứng:

| Phân hệ | Lệnh khởi chạy | Địa chỉ truy cập cục bộ |
|---|---|---|
| Backend API | `npm run start:api` | http://localhost:8787/health |
| Storefront (Khách hàng) | `npm run start:user` | http://localhost:4002/ |
| Admin ERP (Cổng quản trị) | `npm run start:admin-erp` | http://localhost:4003/login |

Lưu ý: Khi khởi chạy `admin-erp-ng` và `user-ng` ở chế độ cục bộ, Angular Dev Server đã cấu hình sẵn `proxy.conf.json` / môi trường phát triển chuyển tiếp `/supabase` tới dự án Supabase Cloud và trỏ API tới `http://localhost:8787`.

---

## 9. Kiểm thử tự động và biên dịch (Build & Test)

Các lệnh kiểm chứng chất lượng mã nguồn dùng chung giữa môi trường cục bộ và GitHub Actions CI:

```bash
# Kiểm tra kiểu TypeScript cho Backend API
npm run typecheck:api

# Chạy toàn bộ kiểm thử Backend API (chạy tuần tự trên Windows để tránh tranh chấp file tạm)
npm run test:api

# Chạy bộ kiểm thử đơn vị Angular trong workspace
npm run test:ng

# Chạy đánh giá AI Decision Engine và kiểm thử vận hành
npm run eval:ai-decisions
npm run test:ops

# Biên dịch production cho toàn bộ workspace (API + 3 SPA Angular)
npm run build
```

---

## 10. Bảo mật và tài liệu bàn giao chấm điểm

- Kho mã nguồn công khai **không lưu trữ** tệp `.env`, khóa bí mật (API keys, Service Role keys, SMTP/Stripe secrets) hay mật khẩu tài khoản dưới dạng văn bản thuần. Toàn bộ secret trên hạ tầng Production được mã hóa bằng **SOPS + Age**.
- Toàn bộ tài khoản kiểm thử theo từng vai trò (Super Admin, các vai trò vận hành RBAC, Admin Viewer, Thành viên Storefront) cùng thông số biến môi trường cần thiết cho việc chạy tái lặp cục bộ được cung cấp riêng trong tệp tài liệu bàn giao `.docx` nộp kèm theo quy định của học phần.
