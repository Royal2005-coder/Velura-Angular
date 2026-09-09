## Jira
- Key: KAN-___
- Team: Storefront (`user-ng`) / Admin (`admin-ng` + `api`) / Lead
- Link: https://webadvance.atlassian.net/browse/KAN-___

## Summary
- What changed and **why** (not a file list)

## Source of truth
- [ ] Follows [docs/SOURCE-OF-TRUTH.md](../../docs/SOURCE-OF-TRUTH.md) (HTTP in services; API stays Node)
- [ ] UI: standalone + Signals ([ADR 0001](../../docs/adr/0001-angular-21-standalone-signals.md))
- [ ] No `any`; public methods have JSDoc
- [ ] Domain/API contracts unchanged **or** new ADR number below

## ADR (bắt buộc nếu đổi kiến trúc / ranh giới layer)
- ADR: none | `docs/adr/NNNN-title.md`
- Decision in one sentence:

## Test plan
- [ ] Local: `npm run start:api` + admin :4001 + user :4002
- [ ] `npm run test:api` if `apps/api` or `tests/api` changed
- [ ] Empty / error / pagination checked for UI
- [ ] Compared to lecture map: component does not call HttpClient

## GitLab notes (versioning / agent trace)
- Branch: `feature/KAN-___-…`
- Commits all contain `KAN-___`
- This MR is the trace log for the issue. Do not open a second MR for the same key unless the first is closed.

## Production
This MR **must not** deploy. Production runs only after merge to `main`.
Title **starts with** `KAN-___` so Jira Development / comments can attach to this version.
