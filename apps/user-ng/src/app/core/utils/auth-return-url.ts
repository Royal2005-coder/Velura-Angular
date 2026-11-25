const OAUTH_RETURN_URL_KEY = 'velura-user-oauth-return-url';
const OAUTH_RETURN_URL_TTL_MS = 15 * 60 * 1000;
const AUTH_LOOP_PATH_RE = /^\/(?:auth|login|signin|signup)(?:\/|$)/i;
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

interface StoredOAuthReturnUrl {
  url: string;
  expiresAt: number;
}

/**
 * Validates and normalizes an internal post-authentication redirect path.
 * Blocks external URLs, protocol-relative paths, C0/control characters, backslashes, embedded userinfo,
 * and auth route loops (`/auth`, `/auth/*`, `/login`, `/signin`, `/signup`).
 */
export function sanitizeReturnUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  if (CONTROL_CHAR_RE.test(trimmed)) return null;
  if (!/^\/(?![/\\])/.test(trimmed)) return null;
  if (trimmed.includes('\\')) return null;

  try {
    const decodedOnce = decodeURIComponent(trimmed);
    if (CONTROL_CHAR_RE.test(decodedOnce) || decodedOnce.includes('\\')) return null;
    if (/^\/(?=[/\\])/.test(decodedOnce)) return null;
  } catch {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed, 'https://velura.invalid');
  } catch {
    return null;
  }
  if (parsed.origin !== 'https://velura.invalid' || parsed.username || parsed.password) {
    return null;
  }
  if (AUTH_LOOP_PATH_RE.test(parsed.pathname)) {
    return null;
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function hasStorage(): boolean {
  return typeof localStorage !== 'undefined';
}

/**
 * Persists a validated OAuth return URL for up to 15 minutes right before leaving for Google SSO.
 * Clears any stale value when called with `null` or an invalid URL.
 */
export function rememberOAuthReturnUrl(raw: string | null | undefined, now = Date.now()): void {
  if (!hasStorage()) return;
  const safe = sanitizeReturnUrl(raw);
  if (!safe) {
    clearOAuthReturnUrl();
    return;
  }
  const payload: StoredOAuthReturnUrl = { url: safe, expiresAt: now + OAUTH_RETURN_URL_TTL_MS };
  localStorage.setItem(OAUTH_RETURN_URL_KEY, JSON.stringify(payload));
}

/**
 * Reads a stored OAuth return URL without removing it (used on retryable OAuth error screens).
 */
export function peekOAuthReturnUrl(now = Date.now()): string | null {
  if (!hasStorage()) return null;
  const raw = localStorage.getItem(OAUTH_RETURN_URL_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredOAuthReturnUrl>;
    if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt < now) {
      clearOAuthReturnUrl();
      return null;
    }
    const safe = sanitizeReturnUrl(parsed.url);
    if (!safe) {
      clearOAuthReturnUrl();
      return null;
    }
    return safe;
  } catch {
    clearOAuthReturnUrl();
    return null;
  }
}

/**
 * Consumes and removes the stored OAuth return URL once authentication succeeds.
 */
export function consumeOAuthReturnUrl(now = Date.now()): string | null {
  const url = peekOAuthReturnUrl(now);
  clearOAuthReturnUrl();
  return url;
}

/**
 * Removes any pending OAuth return URL from browser storage.
 */
export function clearOAuthReturnUrl(): void {
  if (!hasStorage()) return;
  localStorage.removeItem(OAUTH_RETURN_URL_KEY);
}
