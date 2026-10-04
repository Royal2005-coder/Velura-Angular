/** Returns true only when a reviewer explicitly opens a preview URL. */
export function isPreviewMode(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('preview') === '1';
}

/** User preview routes receive a synthetic account session; normal routes never do. */
export function isUserPreview(): boolean {
  return isPreviewMode() && /(^|\/)(checkout\/user|account)(\/|$)/.test(window.location.pathname);
}

/** Guest preview routes stay anonymous while receiving frontend-only fixture data. */
export function isGuestPreview(): boolean {
  return isPreviewMode() && !isUserPreview();
}