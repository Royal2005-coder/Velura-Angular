# ADR 0003: TypeScript on the Node API

Date: 2026-09-09  
Status: Accepted  
Trace: `git log --oneline --show-notes --grep=KAN-15`

## Decision

Cùng runtime Node: `apps/api/**/*.ts`, `tests/api/*.test.ts`, `tsc` → `dist/`, systemd `node dist/server.js`. Không đổi API thành Angular.
