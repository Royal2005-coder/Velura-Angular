# Team workspace: fullstack, UI redesign và MVP release

Đây là quy trình chung cho người và AI. Đọc cùng [AGENTS](../AGENTS.md),
[kiến trúc](ARCHITECTURE.md), [Git/CI](GIT-AND-CI.md) và [runbook](HOW-IT-WORKS.md).
Jira `KAN-n` giữ backlog; Git/PR giữ phiên bản và lý do; docs giữ hợp đồng ổn định.

## 1. Vai trò và quyền

| Thành viên | GitHub | Phạm vi công việc |
|---|---|---|
| Royal | `Royal2005-coder` | Fullstack, backend, tích hợp, hạ tầng và release |
| Quỳnh | `trandiemquynhqw-maker` | Fullstack/backend ngang luồng làm việc của Royal; tích hợp API/DB/UI |
| Uyên | `uyenntd23406-svg` | Frontend redesign, user flow; có thể mở/merge PR release theo cùng CI gates |
| Khải | `khai0335814880-create` | Frontend redesign, component/layout và kiểm thử giao diện |

Repo Write cho phép làm branch/PR; phân vai trên là ownership công việc, không
phải ACL theo đường dẫn. Quyền mời thành viên cần được người nhận accept trước
khi dùng. MVP không yêu cầu approval; CODEOWNERS và mention để nắm thông tin.
CI đỏ/pending vẫn không được merge. Không push trực tiếp `develop`/`main`.

## 2. Vào workspace từ máy mới

```bash
gh auth login
git clone --branch develop https://github.com/Royal2005-coder/Velura-Angular.git
cd Velura-Angular
git remote -v
git fetch origin
git pull --ff-only origin develop
git switch -c feature/KAN-123-short-name
npm ci
```

`KAN-123` là ví dụ: thay bằng ticket thật. Dùng Node 22 như CI. Mỗi người cấu hình
Git name/email của chính mình, khớp email GitHub hoặc noreply của tài khoản đó;
không dùng identity chung hoặc giả danh đồng đội. Lead cấp env local/sandbox
qua kênh bảo mật; không copy production Secrets về máy frontend.

Nếu đã clone `main`, không code trực tiếp ở đó: giữ thay đổi đang làm trên branch
riêng, fetch rồi tạo feature branch từ `origin/develop`. Không reset/xóa công việc
chưa commit để đổi branch. `main` chỉ dùng đối chiếu production và nguồn release.

Trước khi sửa code cũ:

```bash
git status -sb
git log --oneline --show-notes -15
git log --oneline --grep=KAN-123
git diff origin/develop...HEAD --stat
```

Đọc type/JSDoc, route, service và specs thật. Không suy diễn endpoint, field,
permission, trạng thái đơn hàng hay deploy thành công từ tên ticket.

## 3. Hai luồng phát triển cùng một codebase

### Royal / Quỳnh: fullstack và backend

1. Xác định contract: DTO/type, permission, error code, API route và RPC hiện có.
2. Có đổi dữ liệu: migration mới, rồi repository/service/router; không sửa DB
   production ngoài một thao tác migration được owner phê duyệt.
3. Wire Angular Model vào API thật; ViewModel Signals xử lý state; HTML trình bày.
4. Chạy typecheck/API tests và Angular tests cho phần bị ảnh hưởng, rồi build.
5. PR vào develop; mô tả thay đổi contract và cách frontend tích hợp trong PR.

### Uyên / Khải: phủ UI mới và redesign user flow

Được đổi layout, SCSS/tokens, typography, copy, component trình bày, responsive,
navigation và tương tác UX trong ticket. Vẫn giữ Angular standalone + Signals.

Giữ nguyên các hợp đồng sau nếu ticket không được fullstack xác nhận thay đổi:

- URL route/deep-link, input/output component và method của Model hiện có.
- Endpoint/method/payload/response/error code, auth/session và RBAC.
- Scope cart theo user/guest, OTP/guest lookup, giá/voucher/loyalty,
  thanh toán, cancellation/return/refund và state machine phía server.
- Loading/error/empty/disabled/permission states và kiểm tra form quan trọng.

Không thay API thật bằng dữ liệu giả trong runtime để màn hình trông hoàn chỉnh.
Mock chỉ nằm trong test/preview được tách rõ. Không thêm HttpClient vào page,
không gọi Supabase service-role từ browser, không tự tính lại nghiệp vụ tiền/điểm
ở frontend. Không nhét secret, `any`, NgModule hoặc framework frontend thứ hai.

Nếu flow mới cần contract mới: ghi rõ nhu cầu ngay trong ticket/PR, tag Royal và
Quỳnh. Fullstack bổ sung contract trước hoặc cùng một PR có kiểm thử liên tầng;
UI dùng adapter/Model typed đó. Không đoán field hoặc đổi tên enum để khớp mockup.

## 4. Tích hợp redesign theo từng lát nhỏ

| Phase | Kết quả có thể nghiệm thu |
|---|---|
| Inventory | Route/page, Model method, DTO, quyền và states đang dùng được chỉ ra trong PR |
| UI slice | Một nhóm route/component hoàn chỉnh, giữ các binding và nghiệp vụ hiện tại |
| Fullstack integration | Royal/Quỳnh kiểm tra payload/response thật và sửa adapter/service khi cần |
| Regression | API/Angular/build xanh; kiểm tra luồng thành công và lỗi của phần đã đổi |
| Release | Promote main, signed digests, reviewed pins, Flux và runtime revision khớp |

Chia ownership theo route để hai người không cùng sửa một page lớn. Với shell,
tokens hoặc shared components, đồng bộ trước trong PR và giữ API component
tương thích cho các page chưa redesign. Backend fix và UI fix dùng PR riêng khi
không phụ thuộc; không chờ một nhánh redesign khổng lồ mới tích hợp toàn hệ thống.

Trước khi merge feature: fetch và merge `origin/develop` vào feature branch,
giải quyết conflict theo contract mới nhất, chạy lại checks. Không lấy bản của
mình đè toàn bộ file backend/UI của đồng đội. Với branch đã chia sẻ, không rebase
hoặc force-push nếu chưa thống nhất.

## 5. PR và kiểm thử

```bash
npm run typecheck:api
npm run test:api
npm run test:ng
npm run build
git diff --check
git push -u origin HEAD
gh pr create --base develop --title "KAN-123: short business purpose" \
  --body-file .github/pull_request_template.md
```

Điền template thật, không để heading trống. `## Why` nêu mục tiêu nghiệp vụ;
Decision/Trace nêu contract, test và ticket. UI PR đính kèm bằng chứng giao diện
responsive/interaction thực tế. Tag người liên quan, ví dụ:
`cc @Royal2005-coder @trandiemquynhqw-maker @uyenntd23406-svg`.
Không có review gate nhưng người merge chịu trách nhiệm đọc diff và chờ tất cả
required checks xanh. Không `[skip ci]`, không fake test result.

## 6. Từ develop tới web đang chạy

MVP có một môi trường production; không cần staging project thường trực.

```text
feature PR → develop (CI xanh)
→ develop → main (CI xanh)
→ main publisher: build + scan + SBOM + sign
→ production pins PR → develop → main
→ Flux root / platform / production
→ verify-production: chữ ký + schema/gateway + image-baked revision/build ID
```

Khi `VELURA_AUTO_PROMOTE_MAIN=true`, GitHub App mở/auto-merge các PR đồng bộ và
promotion sau CI. Nếu main có ancestry mới, bot mở PR sync về develop trước;
conflict phải được giải quyết trên Git. Team vẫn có thể mở PR `develop` → `main`
bằng tay. Không feature → main; không đẩy image trực tiếp bằng kubectl.

CI xanh của source chưa đồng nghĩa release đã chạy. Xác minh run publish,
production-pins PR, Flux revision/digests và `release.json`/ops readiness theo
[HOW-IT-WORKS](HOW-IT-WORKS.md). Kubeconfig không phải điều kiện để frontend dev
làm việc hay release qua PR.

## 7. Rollback có lịch sử

1. Xác định feature/source commit gây lỗi bằng git log, PR và release build ID.
2. Tạo `feature/KAN-n-rollback-...` từ develop mới nhất; revert đúng source commit.
   Nếu revert merge commit, kiểm tra parent trước và chỉ dùng `-m 1` cho merge
   có parent chính phù hợp. Không `reset --hard` hoặc force-push main/develop.
3. PR vào develop → CI xanh → main. Pipeline build/scan/sign bản source đã revert,
   tạo bundle pins mới và Flux rollout. Cấu hình hạ tầng được revert bằng PR tương tự.
4. Kiểm tra lại revision/health. Ghi ticket/PR nguyên nhân và kết quả.

Không sửa riêng một digest/revision hoặc chép evidence không khớp để rollback;
CI sẽ từ chối bundle sai. Rollback code không tự rollback schema/data. Migration
lỗi cần forward-fix tương thích hoặc restore có owner approval và bằng chứng backup.

## 8. AI phải dừng ở đâu

Không tự khai báo pipeline/rollout thành công khi job bị skipped, PR chưa merge,
Flux suspended/khác revision hoặc endpoint chỉ trả index.html. Không sửa branch
protection, secret scope, API/RPC contract hay business rules trong ticket UI.
Thiếu credential/quyền/contract phải nêu đúng blocker; không tạo token hoặc
bằng chứng giả. Atlas và Atlassian là hai công cụ khác nhau: xem [ATLAS-CLI](ATLAS-CLI.md)
và [MCP-SETUP](MCP-SETUP.md).
