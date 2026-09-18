## Why
<!-- Bối cảnh + trade-off. Đây là ADR của ticket. Không tạo docs/KAN-n.md. -->
-

## Decision
<!-- Một câu: giữ / đổi gì. -->
-

## What
- Jira: KAN-___ — https://webadvance.atlassian.net/browse/KAN-___
- Team: Storefront / Admin / Lead

## Trace
```bash
git log --oneline --show-notes --grep=KAN-___
git show --stat <sha>
```
CI job `note-pr` ghi log + artifact `pr-trace.md` + comment trên PR. Context sống trong **type/JSDoc**, commit, PR này, git notes.

## Checks
- [ ] Title starts with `KAN-n`
- [ ] Public symbols have JSDoc; no `any`; HTTP only in services
- [ ] Target **develop** (feature). Promote production = source **develop** → **main**
- [ ] No new ticket markdown; context in types/JSDoc, this PR, git notes

## Test plan
- [ ]
