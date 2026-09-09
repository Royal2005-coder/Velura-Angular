# Agent contract (Velura)

Đọc file này trước. Không invent process thứ hai. Không tạo markdown theo ticket.

## Trạng thái bàn giao (đọc trước khi clone)

| Branch | Có gì | Team clone cái này? |
|---|---|---|
| `main` | Onboarding v1 (`7822f6a`) + production hiện tại. **Chưa** có source-of-truth maps, staging, `test:angular`, `note:mr` bắt buộc, CODEOWNERS | Chỉ khi lead đã promote `develop` → `main` |
| `develop` | Hiện **trùng `main`** (`ab82af7`). Chưa nhận 2 commit SDLC | Sau khi MR feature → `develop` merge |
| `feature/KAN-13-team-onboarding` | Bộ docs + pipeline đầy đủ (file này, README, `docs/SOURCE-OF-TRUTH.md`, CI staging) | **Clone cái này hôm nay** cho đến khi merge `develop` |

Hai commit **chưa** trên `main` / `develop`:

- `ce31e9a` — source of truth, ADR kiến trúc, MCP
- `be5cb2e` (+ commit bàn giao này) — staging, CI Angular, CODEOWNERS, MR trace bắt buộc

Cấm merge feature thẳng `main`. Promote production = MR `develop` → `main` sau staging xanh.

## Read order (mọi agent, mọi thành viên)

1. `AGENTS.md` (file này)
2. [README.md](README.md) — clone, URL, pipeline
3. [docs/SOURCE-OF-TRUTH.md](docs/SOURCE-OF-TRUTH.md) — lecture + book → repo
4. [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) — Jira → MR → staging → production
5. [docs/MCP-SETUP.md](docs/MCP-SETUP.md) — Cursor Jira + GitLab
6. [docs/ANGULAR-STANDARDS.md](docs/ANGULAR-STANDARDS.md) — cách viết UI
7. [docs/COMPLIANCE.md](docs/COMPLIANCE.md) — đã xong / gap
8. Code: `apps/user-ng` | `apps/admin-ng` | `apps/api`

Slide/sách **không** copy vào Git (bản quyền). Map:

- Lecture TinyBigCorp `docs/Angularframewor.md` → [docs/source-of-truth/LECTURE-MAP.md](docs/source-of-truth/LECTURE-MAP.md)
- Book TinyBigCorp `docs/Angularbooksourceoftruth.md` → [docs/source-of-truth/BOOK-MAP.md](docs/source-of-truth/BOOK-MAP.md)

## Nguồn sự thật — md nhỏ + GitLab MR

| Loại | Ở đâu | Không làm |
|---|---|---|
| Kiến trúc ổn định | `docs/` (SOURCE-OF-TRUTH, ADR 0001/0002) | ADR.md cho mỗi bug/feature |
| Việc / backlog | Jira **KAN** | GitLab Issues |
| Context từng version | GitLab MR: git log, tab Changes, CI job `note:mr` | File `docs/KAN-n.md` |
| Trace CLI | `git log --grep=KAN-n` · `git show --stat <sha>` | Đoán từ chat |

## Non-negotiable

- Angular = **SPA frontend** only. `apps/api` Node JS là đúng (ADR 0002). Test API = `tests/api/*.test.js`.
- Lecture `NgModule` → **standalone + Signals** (ADR 0001). Không thêm `NgModule`.
- Feature MR target **`develop`**. Chỉ `develop` → `main` mới production.
- CI bắt buộc: `validate` + `test:api` + `test:angular` + `build` + `note:mr`. `[skip ci]` cấm.
- Page `*.spec.ts` mock Model (`ApiService` / `AdminApiService`). Không viết API bằng Angular. TypeScript API = [ADR 0003](docs/adr/0003-node-api-typescript.md) (Node runtime).
- Build xanh ≠ UI đúng: phải có `test:ng` và reviewer nhìn Changes.

<Context>
  <Philosophy>
    Maintainability, typed UI contracts, reviewable MRs. Map UEL lecture onto Angular 21.
  </Philosophy>
  <Scope>
    Storefront `apps/user-ng` (KAN-4). Admin `apps/admin-ng` + Node `apps/api` (KAN-5).
  </Scope>
</Context>

<Architecture>
  <Frontend_Pattern>
    View = HTML. ViewModel = standalone component + signals.
    Model = injectable service. No HttpClient in pages. No `any`.
  </Frontend_Pattern>
  <Backend_Pattern>
    Router parses HTTP. Service owns rules. Repository owns Supabase.
  </Backend_Pattern>
</Architecture>

<Constraints>
  <DO>
    - Signals for derived UI; JSDoc on public TS methods
    - Design tokens in `src/app/theme`
    - `feature/KAN-n-kebab` → MR `develop` → staging → MR `develop`→`main`
    - After merge, comment Jira with the MR URL
  </DO>
  <DO_NOT>
    - NgModules, logic in templates, rewrite API to Angular/Python in a UI MR
    - Commit `.env` / `*.pem`
    - Feature → `main`, `[skip ci]`, ADR.md cho ticket thường
  </DO_NOT>
</Constraints>
