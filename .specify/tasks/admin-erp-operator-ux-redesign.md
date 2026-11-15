# Tasks: Admin ERP Operator UX & Interface Redesign (KAN-106)

## Phase 1: Shared Interaction & Compilation Recovery
- [x] `[T01]` [Role: frontend-architect] [Depends on: None] [Verify: npm run build:admin-erp]
  Fix TypeScript compilation errors in `AdminErpAccountsPage`, `AdminErpPricingPage`, `AdminErpOrdersPage`, and `AdminErpPromotionsPage`.
- [x] `[T02]` [Role: frontend-developer] [Depends on: T01] [Verify: npx vitest run apps/admin-erp-ng/src/app/shared/ui/admin-interaction.spec.ts]
  Ensure `admin-interaction.spec.ts` passes: test runner globals, filter debounce, stack-aware Escape, unsaved changes modal.

## Phase 2: Core Module Operator Ergonomics
- [x] `[T03]` [Role: frontend-developer] [Depends on: T01] [Verify: npm run test -w @velura/admin-erp-ng -- -t "AdminErpPricingPage"]
  Complete Pricing & Products Operator UX with `PriceChangeFormComponent`.
- [x] `[T04]` [Role: frontend-developer] [Depends on: T01] [Verify: npm run test -w @velura/admin-erp-ng -- -t "AdminErpAccountsPage"]
  Complete Accounts & Members Operator UX with reason requirement and quick actions.
- [x] `[T05]` [Role: frontend-developer] [Depends on: T01] [Verify: npm run test -w @velura/admin-erp-ng -- -t "AdminErpOrdersPage"]
  Complete Orders, Returns & Chat Desk Operator UX with explicit verbs, danger cancel tone, and uniform row-actions.
- [x] `[T06]` [Role: frontend-developer] [Depends on: T01] [Verify: npm run test -w @velura/admin-erp-ng -- -t "AdminErpPromotionsPage"]
  Complete Promotions, Reviews & Logs Operator UX with confirm reason, versioned toggling, and pagination selector.

## Phase 3: System Verification & Polish
- [x] `[T07]` [Role: qa-engineer] [Depends on: T02, T03, T04, T05, T06] [Verify: npm run build:admin-erp && npm run test:admin-erp]
  Full Admin ERP build and test suite execution: 35/35 test suites (272/272 tests) passed, build passes with zero errors.
