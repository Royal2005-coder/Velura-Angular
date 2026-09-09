# Bài practice — train tay Jira + GitLab + CI

Mục tiêu: mỗi người **một lần** đi *Jira → branch từ develop → MR vào develop → CI xanh + note:mr*. **Không merge.**

Mẫu lead: [KAN-13](https://webadvance.atlassian.net/browse/KAN-13). Năm thành viên **không** dùng chung KAN-13. Mỗi người một Task.

Không tạo `docs/KAN-n.md`. Context nằm trên MR. Practice chỉ thêm **một dòng** vào roster chung.

## A. Chuẩn bị

1. [ONBOARDING.md](./ONBOARDING.md) mục 2–3.
2. Hôm nay: `git checkout feature/KAN-13-team-onboarding && git pull` (bộ SDLC chưa trên `develop`). Sau khi lead merge: `git checkout develop && git pull origin develop`.
3. Board: https://webadvance.atlassian.net/jira/software/projects/KAN/board

## B. Tạo việc trên Jira

1. **Create** → **Task**.
2. Summary: `[Practice] <tên bạn> — first MR (do not merge)`
3. Parent: Storefront → [KAN-4](https://webadvance.atlassian.net/browse/KAN-4) · Admin → [KAN-5](https://webadvance.atlassian.net/browse/KAN-5)
4. Labels: `process` + `team-storefront` hoặc `team-admin`
5. Copy key, ví dụ `KAN-14`. In Progress. Assignee = bạn.

Thay mọi `KAN-14` bằng **key của bạn**.

## C. Branch + một dòng roster

```bash
git checkout develop   # hoặc feature/KAN-13-team-onboarding nếu develop chưa có SDLC
git pull
git checkout -b feature/KAN-14-onboarding-practice
```

Thêm **một dòng** vào `docs/practice-logs/ROSTER.md` (không tạo file md riêng):

```
| KAN-14 | Your Name | Storefront | gitlab-username |
```

```bash
git add docs/practice-logs/ROSTER.md
git commit -m "KAN-14 add onboarding practice roster line"
git push -u origin HEAD
```

## D. Merge Request

| Field | Giá trị |
|---|---|
| Source | `feature/KAN-14-onboarding-practice` |
| Target | **`develop`** |
| Title | `KAN-14 Practice roster for <tên>` |
| Description | Template Default |
| Draft | **Mark as draft** |

## E. Pipeline (phần train chính)

MR → **Pipelines**. Không có `deploy:production`.

Bắt buộc xanh:

1. `validate:workspace` + `validate:mr-contract`
2. `test:api`
3. `test:angular`
4. `build:angular`
5. `note:mr` — **bắt buộc**; Notes của MR có git log + `diff --stat`

Đỏ: sửa trên **cùng branch**, push lại. Không mở MR thứ hai cho cùng key.

## F. Jira Development

Issue `KAN-14`: panel Development có branch + MR. Nếu trống: thiếu `KAN-n` trên branch/title.

Kéo **Waiting for Review**.

## G. Kết thúc

1. **Close** MR (không Merge) hoặc giữ Draft.
2. Jira Close: `Practice complete; MR not merged.`

Lead: 5 người, 5 key, 5 MR draft, CI xanh, **zero merge**.

## H. Việc thật

Cùng B–F. Khác: sửa folder team, [ANGULAR-STANDARDS.md](./ANGULAR-STANDARDS.md), reviewer merge khi CI xanh, staging rồi mới promote `main`.

## I. Lỗi hay gặp

| Hiện tượng | Sửa |
|---|---|
| Development Jira trống | Key `KAN-n` trên branch + title MR |
| `validate:mr-contract` fail target `main` | Đổi target sang `develop` |
| `note:mr` đỏ | Lead thêm `GITLAB_TOKEN` (api) nếu JOB-TOKEN 403 |
| Push `main` rejected | Đúng — chỉ MR |
| 5 người một issue | Mỗi người một Task |

[HOW-IT-WORKS.md](./HOW-IT-WORKS.md).
