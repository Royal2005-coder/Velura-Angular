# ADR 0001: Angular 21 standalone + Signals

Date: 2026-09-09  
Status: Accepted  
Jira: KAN-12 / KAN-13

## Context

Slide UEL dạy `NgModule` (Angular 2–13). TinyBigCorp và Angular 21 yêu cầu standalone components và Signals. GoalKicker mô tả module vì sách viết cho Angular 2+.

## Decision

Production UI dùng **standalone + Signals**. Module trên slide được map sang `app.config.ts`, `app.routes.ts`, và thư mục `features/`. Không thêm `NgModule`.

## Consequences

- Đúng CLI hiện tại, AOT, lazy `loadComponent`.
- Reviewer từ khóa học phải đọc [LECTURE-MAP.md](../source-of-truth/LECTURE-MAP.md), không revert sang `app.module.ts`.
- HTTP vẫn trong service (không đổi so với slide).
