# Harness² Persistent Memory & Experience Reflector

Lessons learned from autonomous task execution to guide future harness recursions:

- **[TASK-5.2]**: Angular 21 Signals viewChild inputs must have their DOM .value explicitly synchronized on route change to prevent stale search terms. OAuth GoTrue redirect URIs must be strictly allowed in Gotrue URI whitelist to prevent strand on origin.
- **[KAN-106-OPERATOR-UX]**: In Angular 21 Standalone + Signals, when migrating legacy page modals to shared components like `PriceChangeFormComponent`, completely eliminate unreferenced template properties/methods to prevent TS2339 errors. Confirmation dialogs (`AdminErpConfirmService`) must match strict interfaces (`confirmLabel`, `tone: 'primary' | 'danger'`, `requireReason`, `reasonLabel`, `reasonMinLength`), and keyboard handlers (`/`) must guard against `event.isComposing` and active form elements (`input, textarea, select`) to prevent Vietnamese IME collisions.
