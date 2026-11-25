import {
  clearOAuthReturnUrl,
  consumeOAuthReturnUrl,
  peekOAuthReturnUrl,
  rememberOAuthReturnUrl,
  sanitizeReturnUrl,
} from './auth-return-url';

describe('auth-return-url helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('accepts safe relative storefront paths and normalizes them', () => {
    expect(sanitizeReturnUrl('/products/ao-so-mi?variant=v1&vto=1')).toBe('/products/ao-so-mi?variant=v1&vto=1');
    expect(sanitizeReturnUrl('  /products/dam-lua#details  ')).toBe('/products/dam-lua#details');
    expect(sanitizeReturnUrl('/')).toBe('/');
  });

  it('rejects external URLs, protocol-relative paths, backslashes, control chars, userinfo, and auth loop aliases', () => {
    for (const bad of [
      null,
      undefined,
      '',
      '   ',
      'https://evil.test/products/1',
      'http://localhost/products/1',
      'javascript:alert(1)',
      '//evil.test/products/1',
      '/\\evil.test/products/1',
      '/%2f/evil.test',
      '/%5cevil.test',
      '/products/1\\@evil.test',
      '/products/1\r\nLocation:https://evil.test',
      '/products/1\t@evil.test',
      '//user@evil.test/products/1',
      'https://user:pass@velura.royalai.dev/products/1',
      '/auth',
      '/auth/signin',
      '/auth/signup?returnUrl=/products/1',
      '/auth/callback#access_token=abc',
      '/login',
      '/signin',
      '/signup',
    ]) {
      expect(sanitizeReturnUrl(bad)).toBeNull();
    }
  });

  it('persists, peeks, consumes, and expires OAuth return URLs cleanly', () => {
    rememberOAuthReturnUrl('/products/ao-so-mi?variant=v1&vto=1', 1_000);
    expect(peekOAuthReturnUrl(1_500)).toBe('/products/ao-so-mi?variant=v1&vto=1');
    expect(consumeOAuthReturnUrl(2_000)).toBe('/products/ao-so-mi?variant=v1&vto=1');
    expect(peekOAuthReturnUrl(2_100)).toBeNull();

    rememberOAuthReturnUrl('/products/ao-so-mi?vto=1', 1_000);
    expect(peekOAuthReturnUrl(1_000 + 15 * 60 * 1000 + 1)).toBeNull();

    rememberOAuthReturnUrl('/products/ao-so-mi?vto=1', 1_000);
    rememberOAuthReturnUrl('/auth/signin', 2_000);
    expect(peekOAuthReturnUrl(2_100)).toBeNull();

    rememberOAuthReturnUrl('/products/ao-so-mi?vto=1', 1_000);
    clearOAuthReturnUrl();
    expect(peekOAuthReturnUrl(1_100)).toBeNull();
  });
});
