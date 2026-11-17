import { Router, UrlTree } from '@angular/router';

/**
 * Checks whether a CMS-configured CTA URL points to an external HTTPS destination
 * rather than an internal SPA route (allowed by CMS validation FR-S3 / FR-19).
 */
export function isExternalCmsLink(url: string | null | undefined): boolean {
  return /^https?:\/\//i.test((url ?? '').trim());
}

/**
 * Parses an internal CMS destination (including query strings like `/products?category=dam-vay`
 * and hash fragments) into an Angular `UrlTree` so `[routerLink]` never percent-encodes `?` or `=`.
 */
export function parseInternalCmsLink(
  router: Pick<Router, 'parseUrl'>,
  url: string | null | undefined,
  fallback = '/products',
): UrlTree | string {
  const raw = (url ?? '').trim();
  const normalized = !raw || isExternalCmsLink(raw) ? fallback : raw.startsWith('/') ? raw : `/${raw}`;
  if (typeof router?.parseUrl === 'function') {
    return router.parseUrl(normalized);
  }
  return normalized;
}

/**
 * Navigates to a CMS CTA link: opens external HTTPS links safely in a new tab,
 * or routes internal paths (with query params) via `Router.navigateByUrl`.
 */
export function navigateCmsLink(
  router: Pick<Router, 'navigateByUrl'>,
  url: string | null | undefined,
  fallback = '/products',
): void {
  const raw = (url ?? '').trim();
  if (isExternalCmsLink(raw)) {
    window.open(raw, '_blank', 'noopener,noreferrer');
    return;
  }
  const normalized = !raw ? fallback : raw.startsWith('/') ? raw : `/${raw}`;
  void router.navigateByUrl(normalized);
}
