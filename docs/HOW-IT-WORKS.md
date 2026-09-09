# Jira ↔ GitLab hoạt động cụ thể thế nào

Cặp này **không** phải “Jira gửi ticket sang GitLab để GitLab có issue riêng”.  
Hai hệ thống chia việc:

| Hệ thống | Trả lời câu hỏi | Người dùng hàng ngày |
|---|---|---|
| **Jira KAN** | Làm gì? Ai làm? Tới đâu? | Board, Epic, Task, trạng thái |
| **GitLab** | Code nào? Test chưa? Lên production chưa? | Branch, Merge Request, Pipeline |

Sợi dây nối là **mã issue**, ví dụ `KAN-13`. GitLab đọc chuỗi đó trong **tên branch, message commit, title MR**. Jira hiện chúng trên panel **Development**.

## 1. Một vòng đời đầy đủ (đúng pipeline repo này)

```
1. Jira: tạo Task, parent = KAN-4 hoặc KAN-5, status To Do
2. Dev: kéo In Progress, checkout main, tạo branch feature/KAN-13-short-name
3. Dev: commit có "KAN-13 …", push origin
4. Dev: mở Merge Request, title bắt đầu bằng KAN-13, điền template
5. GitLab CI (nguồn = merge_request): 
     validate:workspace → test:api → build:angular → note:mr
   Không chạy deploy.
6. Reviewer đọc diff + checklist Angular. CI phải xanh.
7. Maintainer merge vào main.
8. GitLab CI (nhánh main):
     validate + test:api + build:angular
     → deploy:production (rsync lên Azure)
     → verify:production (curl storefront, /api/health, admin login)
9. Jira: panel Development có branch/MR; integration có thể comment / Close.
```

Production chỉ đổi ở bước 8. Feature branch và MR **không** đụng VM.

## 2. Job CI — nhớ đúng tên

File: `.gitlab-ci.yml`

| Khi nào | Jobs | Deploy? |
|---|---|---|
| Push `feature/*` (không có MR mở) | `validate:workspace`, `test:api`, `build:angular` | Không |
| **Merge Request** | cùng 3 job trên + `note:mr` (ghi note SHA lên MR; được phép fail) | Không |
| Push / merge **`main`** | 3 job trên + `deploy:production` + `verify:production` | **Có** |

`note:mr` chỉ chạy khi `CI_PIPELINE_SOURCE == merge_request_event`.

Deploy thật:

- rsync `apps/user-ng/dist` → `/var/www/velura/user/`
- rsync `apps/admin-ng/dist` → `/var/www/velura/admin/`
- rsync `apps/api` → `/opt/velura/api/`
- reload nginx + restart `velura-api`

Verify thật:

- `https://velura.royalai.dev/` HTTP 200
- `https://velura.royalai.dev/api/health` chứa `"ok":true`
- `https://admin.royalai.dev/login` HTTP 200 và trang có chữ Velura Admin

## 3. Chỗ nhìn “đã nối chưa” sau khi Connect GitLab–Jira

Trên **một issue Jira** (ví dụ KAN-13):

1. Mở issue.
2. Cột phải, mục **Development** (GitLab for Jira Cloud).
3. Sau khi push branch có `KAN-13` trong tên: hiện branch.
4. Sau khi mở MR title có `KAN-13`: hiện merge request.
5. Sau khi merge: hiện commit trên `main`.

Trên **GitLab MR**:

1. Title có `KAN-13` → widget Jira hiện link về https://webadvance.atlassian.net/browse/KAN-13
2. Tab **Pipelines**: 4 job MR (3 bắt buộc xanh + note).
3. Comment bot (nếu `GITLAB_TOKEN` / job token đủ quyền): pipeline note với SHA.

Nếu Development trống: branch/MR **thiếu key** `KAN-n`, hoặc app GitLab for Jira chưa link đúng group `boygia757-netizen`.

## 4. Ai làm gì trên board

Trạng thái Jira team-managed hiện tại:

`To Do` → `In Progress` → `Waiting for Review` → `Close`

| Thời điểm | Jira | GitLab |
|---|---|---|
| Nhận việc | To Do → In Progress | tạo branch |
| Push + mở MR | giữ In Progress hoặc → Waiting for Review khi MR sẵn sàng | MR + CI |
| CI đỏ | không Close | sửa trên **cùng branch**, push thêm |
| Review ok, merge | chờ pipeline `main` xanh | merge (maintainer) |
| Production verify xong | Close | xong |

Nếu GitLab integration bật **transition on merge**, bước Close có thể tự chạy. Vẫn kiểm tra tay: issue đúng thì Close, issue làm dở thì không.

## 5. Hai team, một repo

```
KAN-4 Storefront          KAN-5 Admin
   apps/user-ng              apps/admin-ng
                             apps/api
          \                  /
           packages/*, database/   ← MR cần reviewer cả hai team
```

Storefront không sửa admin HTML “cho tiện”. Admin không nhét HTTP vào template storefront. Contract API đổi thì ghi rõ trong MR và tag team kia.

## 6. Việc không làm

- Tạo GitLab Issue song song với Jira
- Push thẳng `main` (“hotfix 5 phút”)
- MR title `fix login` không có `KAN-12`
- Merge khi `test:api` hoặc `build:angular` đỏ
- Commit `.env`, `web_key.pem`, service-role key
- Deploy SSH tay lên `135.235.219.13` trừ khi CI gãy và lead quyết định hotfix có ghi nhận

## 7. Liên kết kỹ thuật

- Hợp đồng branch/MR: [JIRA-GITLAB.md](./JIRA-GITLAB.md)
- Biến CI và layout VM: [GITOPS.md](./GITOPS.md)
- Practice: [PRACTICE-DRILL.md](./PRACTICE-DRILL.md)
