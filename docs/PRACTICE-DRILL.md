# Bài practice — train tay Jira + GitLab + CI

Mục tiêu: mỗi người **một lần** đi hết vòng *kế hoạch → code → MR → CI xanh*, **không** đưa code lên production.

Merge `main` trong repo này **bật** `deploy:production`. Practice **dừng trước merge**, hoặc đóng MR.

Mẫu lead demo: [KAN-13](https://webadvance.atlassian.net/browse/KAN-13).  
Năm thành viên **không** dùng chung KAN-13 cho năm MR. Mỗi người tạo Task riêng.

## A. Chuẩn bị (5 phút)

1. Xong [ONBOARDING.md](./ONBOARDING.md) mục 2–3 (account + clone).
2. `git checkout main && git pull origin main`
3. Mở board: https://webadvance.atlassian.net/jira/software/projects/KAN/board

## B. Tạo việc trên Jira (bạn tự tạo)

1. **Create** → Type **Task**.
2. Summary: `[Practice] <tên bạn> — first MR (do not merge main)`
3. Parent:
   - Storefront → [KAN-4](https://webadvance.atlassian.net/browse/KAN-4)
   - Admin → [KAN-5](https://webadvance.atlassian.net/browse/KAN-5)
4. Labels: `process` + `team-storefront` hoặc `team-admin`
5. Create. Copy key, ví dụ `KAN-14`.
6. Kéo issue sang **In Progress**. Gán Assignee = bạn.

Từ đây thay mọi `KAN-14` bằng **key của bạn**.

## C. Branch + thay đổi nhỏ (an toàn)

Chỉ sửa file practice, không đụng app production.

```bash
git checkout main
git pull origin main
git checkout -b feature/KAN-14-onboarding-practice
```

Tạo file (đổi tên file theo key của bạn):

`docs/practice-logs/KAN-14.md`

Nội dung tối thiểu:

```markdown
# KAN-14

- Name:
- Team: Storefront | Admin | Lead
- Date:
- GitLab user:
- Checklist: branch có key, commit có key, MR title có key, CI MR xanh, không merge main
```

```bash
git add docs/practice-logs/KAN-14.md
git commit -m "KAN-14 add personal onboarding practice log"
git push -u origin HEAD
```

## D. Mở Merge Request đúng hợp đồng

GitLab sẽ hiện nút Create merge request. Bắt buộc:

| Field | Giá trị đúng |
|---|---|
| Source | `feature/KAN-14-onboarding-practice` |
| Target | `main` |
| **Title** | `KAN-14 Practice log for <tên>` (key đứng đầu) |
| Description | Template Default: điền Key, Team, Link Jira |
| Draft | bật **Mark as draft** (chặn merge nhầm) |

Template (copy vào description):

```markdown
## Jira
- Key: KAN-14
- Team: Storefront (`user-ng`) / Admin (`admin-ng` + `api`)
- Link: https://webadvance.atlassian.net/browse/KAN-14

## Summary
- Practice onboard: file log cá nhân, không đổi runtime.

## Architecture
- [x] Không đụng component/HTTP
- [x] Không `any`
- [x] Không đổi API

## Test plan
- [x] CI MR: validate:workspace, test:api, build:angular
- [ ] Không merge main

## Production
MR này **không** được merge. Production chỉ chạy trên `main`.
```

## E. Đọc pipeline (đây là phần train chính)

Mở MR → tab **Pipelines** → pipeline mới nhất.

Phải thấy **không** có job `deploy:production` và `verify:production`.

Phải xanh:

1. `validate:workspace` — repo đủ file, không có private key
2. `test:api` — `npm run test:api`
3. `build:angular` — `npm run build:user` và `build:admin`
4. `note:mr` — được phép fail; nếu xanh thì MR có comment SHA

Nếu đỏ: đọc log job, sửa **trên cùng branch**, `git commit` + `git push`. Không tạo branch mới, không mở MR thứ hai cho cùng key.

## F. Kiểm tra Jira đã “bắt” GitLab

Mở issue `KAN-14` trên Jira:

- [ ] Panel **Development** hiện branch `feature/KAN-14-onboarding-practice`
- [ ] Hiện merge request
- [ ] Click được sang GitLab

Nếu trống: title MR hoặc tên branch thiếu `KAN-14` đúng format (chữ `KAN` + gạch ngang + số).

Kéo Jira sang **Waiting for Review**.

## G. Kết thúc practice (bắt buộc)

1. Trên GitLab: **Close merge request** (không Merge). Hoặc giữ Draft mãi.
2. Xóa branch remote nếu team thống nhất: GitLab MR → Delete source branch sau khi close.
3. Jira: **Close** với comment `Practice complete; MR not merged to protect production.`

Lead xem 5 người: mỗi người một key, một MR draft, CI xanh, Development panel có data, **zero merge vào main**.

## H. Lần sau (việc thật)

Lặp B–F với issue thật dưới KAN-4 / KAN-5. Khác practice:

- Sửa đúng folder team
- Đi đủ checklist [ANGULAR-STANDARDS.md](./ANGULAR-STANDARDS.md)
- Reviewer khác merge khi CI xanh
- Pipeline `main` mới được phép chạy deploy

## I. Lỗi hay gặp

| Hiện tượng | Nguyên nhân | Sửa |
|---|---|---|
| Development Jira trống | Thiếu `KAN-n` trên branch/MR | Rename không cứu commit cũ; sửa title MR, branch nên tạo đúng từ đầu |
| Pipeline MR có deploy | Không xảy ra với `.gitlab-ci.yml` hiện tại nếu target/source đúng | Nếu thấy deploy trên MR: dừng, báo lead, **không** merge |
| `test:api` đỏ | Test/API local khác | Chạy `npm run test:api` máy bạn, sửa code, push lại |
| Push rejected `main` | Protected branch | Đúng; chỉ MR |
| 5 người một issue | Panel Development rối, review khó | Mỗi người một Task |

Cơ chế đầy đủ: [HOW-IT-WORKS.md](./HOW-IT-WORKS.md).
