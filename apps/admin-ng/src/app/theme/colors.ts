/**
 * Design token names only. Color values live in `styles-velura` CSS variables
 * so the admin SPA can be reskinned without touching component styles.
 */
export const COLOR_TOKENS = {
  cream: 'var(--cream)',
  ink: 'var(--ink)',
  muted: 'var(--muted)',
  terracotta: 'var(--terracotta)',
  line: 'var(--line)',
  error: 'var(--error)',
  fieldBg: 'var(--field-bg)',
  tabBg: 'var(--tab-bg)',
  checkoutBg: 'var(--checkout-bg)',
} as const;
