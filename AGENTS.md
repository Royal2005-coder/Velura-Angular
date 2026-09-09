# Agent contract (Velura)

Đọc file này trước. Không invent process thứ hai. Không tạo markdown theo ticket.

Clone **`develop`** để làm việc, **`main`** = production. Luồng: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## Read order

1. `AGENTS.md` (file này)
2. [README.md](README.md)
3. [docs/SOURCE-OF-TRUTH.md](docs/SOURCE-OF-TRUTH.md)
4. [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)
5. [docs/MCP-SETUP.md](docs/MCP-SETUP.md)
6. [docs/ANGULAR-STANDARDS.md](docs/ANGULAR-STANDARDS.md)
7. [docs/COMPLIANCE.md](docs/COMPLIANCE.md)
8. Code: `apps/user-ng` | `apps/admin-ng` | `apps/api`

Slide/sách ngoài Git: TinyBigCorp `docs/Angularframewor.md` / `Angularbooksourceoftruth.md` → map trong `docs/source-of-truth/`.

## Nguồn sự thật

| Loại | Ở đâu | Không làm |
|---|---|---|
| Kiến trúc | `docs/` + ADR 0001–0003 | ADR.md mỗi ticket |
| Backlog | Jira **KAN** | GitLab Issues |
| Version | GitLab MR + `note:mr` | `docs/KAN-n.md` |

```bash
git log --oneline --grep=KAN-n
git show --stat <sha>
```

## Non-negotiable

- Angular = SPA. `apps/api` Node (ADR 0002). Không viết API bằng Angular.
- `NgModule` → standalone + Signals (ADR 0001).
- Feature MR → **`develop`**. Production = `develop` → `main`.
- CI: validate + `test:api` + `test:angular` + build + `note:mr`. Cấm `[skip ci]`.
- Page specs mock Model. API TypeScript = ADR 0003 (Node, không phải Angular).

<Context>
  <Philosophy>Maintainability, typed UI, reviewable MRs. Map UEL lecture onto Angular 21.</Philosophy>
  <Scope>Storefront `apps/user-ng` (KAN-4). Admin `apps/admin-ng` + Node `apps/api` (KAN-5).</Scope>
</Context>

<Architecture>
  <Frontend_Pattern>View = HTML. ViewModel = standalone + signals. Model = injectable service. No HttpClient in pages. No `any`.</Frontend_Pattern>
  <Backend_Pattern>Router parses HTTP. Service owns rules. Repository owns Supabase.</Backend_Pattern>
</Architecture>

<Constraints>
  <DO>
    - Signals for derived UI; JSDoc on public methods
    - Design tokens in `src/app/theme`
    - `feature/KAN-n-kebab` → MR develop → staging → MR develop→main
    - Comment Jira với URL MR sau merge
  </DO>
  <DO_NOT>
    - NgModules, logic in templates, rewrite API to Angular/Python in a UI MR
    - Commit `.env` / `*.pem`
    - Feature → `main`, `[skip ci]`, ADR.md cho ticket thường
  </DO_NOT>
</Constraints>
