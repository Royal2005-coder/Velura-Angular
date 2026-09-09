/**
 * Design token names only. Actual color values live in
 * `apps/user-ng/src/styles-velura` CSS variables so the visual system
 * can be reskinned without touching components.
 */
export const COLOR_TOKENS = {
  cream: 'var(--cream)',
  ink: 'var(--ink)',
  muted: 'var(--muted)',
  terracotta: 'var(--terracotta)',
  line: 'var(--line)',
  error: 'var(--error)',
} as const;
