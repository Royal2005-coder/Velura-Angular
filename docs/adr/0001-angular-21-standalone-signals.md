# ADR 0001: Angular 21 standalone + Signals

Date: 2026-09-09  
Status: Accepted  
Trace: `git log --oneline --show-notes --grep=KAN-12`

## Decision

UI production = **standalone + Signals**. Không `NgModule`. Slide Module → `app.config.ts` / `features/`.
