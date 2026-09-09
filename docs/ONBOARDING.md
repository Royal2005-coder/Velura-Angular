# Onboarding — ngày 1 (5 người)

Đọc xong file này bạn phải: vào được Jira + GitLab, chạy được 3 app local, biết mình thuộc team nào, và làm [bài practice](./PRACTICE-DRILL.md).

## 1. Bạn thuộc team nào

Cùng **một repo**, khác folder, khác epic Jira.

| Team | Người (gợi ý 5 slot) | Folder | Epic | Production |
|---|---|---|---|---|
| Storefront | 2 | `apps/user-ng` | [KAN-4](https://webadvance.atlassian.net/browse/KAN-4) | https://velura.royalai.dev/ |
| Admin | 2 | `apps/admin-ng` + `apps/api` | [KAN-5](https://webadvance.atlassian.net/browse/KAN-5) | https://admin.royalai.dev/ |
| Lead / shared | 1 | CI, `docs/`, `packages/`, `database/` | cả hai epic khi đụng contract | cả hai URL |

Lead ghi tên 5 người vào bảng này khi chia slot. Đừng để hai người cùng sửa một file trên hai MR không rebase.

## 2. Account cần có trước khi code

1. Jira: https://webadvance.atlassian.net — project **KAN**
2. GitLab: https://gitlab.com/boygia757-netizen/velura-project — quyền **Developer** trở lên (tạo branch + MR). Không cần quyền push `main`.
3. Node.js **22** + npm. Git SSH hoặc HTTPS.

Lead mời người vào Jira project và GitLab project. Không share `.env`, không share `*.pem`.

## 3. Clone và chạy local

Repo production Angular:

```bash
git clone git@gitlab.com:boygia757-netizen/velura-project.git
cd velura-project
git checkout main
git pull
npm install
copy .env.example .env
```

Điền `.env` từ lead (Supabase). File này **không commit**.

```bash
npm run start:api
npm run start:admin
npm run start:user
```

| App | URL | Ghi chú |
|---|---|---|
| API | http://localhost:8787/health | |
| Admin | http://localhost:4001/login | Host phải là `localhost` (Google SSO), không dùng `127.0.0.1` |
| Storefront | http://localhost:4002/ | |

Kiểm tra nhanh:

```bash
npm run test:api
npm run build:user
npm run build:admin
```

## 4. Quy tắc vàng (thuộc lòng)

1. Việc mới = **Task Jira** dưới KAN-4 hoặc KAN-5. Không tạo GitLab Issue.
2. Branch: `feature/KAN-<số>-<ten-ngan>`
3. Mỗi commit và **title MR** chứa `KAN-<số>`
4. Điền template MR (`.gitlab/merge_request_templates/Default.md`)
5. Đợi CI **xanh** trên MR: `validate:workspace` → `test:api` → `build:angular` (và `note:mr`)
6. **Không** merge nếu CI đỏ. **Không** push `main`. **Không** deploy tay lên VM.
7. Merge `main` = production. Chỉ lead/maintainer merge khi review xong.

Chi tiết cơ chế: [HOW-IT-WORKS.md](./HOW-IT-WORKS.md).  
Code Angular: [ANGULAR-STANDARDS.md](./ANGULAR-STANDARDS.md).

## 5. Checklist ngày 1 (in / tick)

- [ ] Vào được board KAN
- [ ] Clone được GitLab, checkout `main`
- [ ] `.env` local, không nằm trong `git status` như file sẽ commit
- [ ] Mở được 4001 / 4002 / 8787
- [ ] Biết epic của mình (KAN-4 hoặc KAN-5)
- [ ] Làm xong [PRACTICE-DRILL.md](./PRACTICE-DRILL.md) với **issue Jira của riêng mình**
- [ ] MR practice **không** merge vào `main`
