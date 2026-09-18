# Agent contract (Velura)

Không invent process thứ hai. Không tạo `docs/KAN-n.md`. Context **không** nằm trong ADR dài.

Clone **`develop`**. `main` = production.  
**Trước khi code:** [docs/GIT-AND-CI.md](docs/GIT-AND-CI.md) + [docs/ONBOARDING.md](docs/ONBOARDING.md).  
Pipeline: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## Context as Code — đọc theo thứ tự này

| Lớp | Cái gì | Ở đâu |
|---|---|---|
| **1. Code** | Hợp đồng nghiệp vụ (cái gì / được phép gì) | `interface` / `type` + JSDoc cạnh symbol. Angular: `*.page.ts`, `core/services`. API: `apps/api/src/types.ts`, router → service → repository |
| **2. Git log** | Toàn bộ lịch sử version | `git log --oneline --grep=KAN-n` rồi `git show --stat <sha>` |
| **3. PR** | Tại sao, trade-off, Jira (mẫu ADR cho **mọi** ticket) | GitHub PR — template [.github/pull_request_template.md](.github/pull_request_template.md) |
| **4. Git notes** | Cảnh báo bên lề, không làm bẩn `git log` | `git log --show-notes --oneline`; `deploy/scripts/git-notes.sh` |
| **5. Jira** | Việc / trạng thái | **KAN-n** |
| **6. docs/** | Map ổn định (slide, DNS, CI, versioning) | [GIT-AND-CI.md](docs/GIT-AND-CI.md) khi onboard; còn lại khi lớp 1–4 không đủ |

Quyết định lâu dài (một câu): [docs/adr/README.md](docs/adr/README.md). **Why** của từng thay đổi = commit + PR + notes, không phải file markdown mới.

```bash
git fetch origin
git fetch origin refs/notes/commits:refs/notes/commits
git log --oneline --show-notes --grep=KAN-n
git show --stat <sha>
git diff origin/develop...HEAD --stat
```

Agent khác / teammate: **đừng hỏi lại Tuesday.** Chạy các lệnh trên, rồi đọc type/JSDoc của file đang sửa.

## Non-negotiable

- Angular = SPA TypeScript. `apps/api` = Node TypeScript. Không viết API bằng Angular.
- Standalone + Signals. Không `NgModule`. Không `any`. Không HttpClient trong page.
- Feature → PR **`develop`**. Production = `develop` → `main`. Cấm `[skip ci]`.
- Mỗi public method / interface: JSDoc (ý định nghiệp vụ). Mỗi commit: `KAN-n why`. Mỗi PR: `## Why`.
- Page specs mock Model.

<Architecture>
  <Frontend_Pattern>View = HTML. ViewModel = standalone + signals. Model = injectable service.</Frontend_Pattern>
  <Backend_Pattern>Router parses HTTP. Service owns rules. Repository owns Supabase.</Backend_Pattern>
</Architecture>

<Constraints>
  <DO>
    - Nhồi ý nghĩa vào type, tên, JSDoc trước khi viết docs
    - PR dùng template Default (Why / Decision / Trace)
    - `git notes` cho “đừng optimize / cố ý không cache” — không nhét vào ADR.md
    - Comment Jira với URL PR sau merge
  </DO>
  <DO_NOT>
    - Game plan / context repo / markdown theo ticket
    - ADR.md cho bug thường (chỉ 0001–0003 trừ khi rule mới **lâu dài**)
    - Feature → `main`, `.env` / `*.pem`
    - Đẩy CI lên GitLab (canonical = GitHub Actions)
  </DO_NOT>
</Constraints>
