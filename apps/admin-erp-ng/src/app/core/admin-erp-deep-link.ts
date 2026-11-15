import { DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, type ParamMap } from '@angular/router';
import { skip } from 'rxjs';

/** Filter state as it appears in the URL; empty/undefined/false/default values are omitted. */
export type ListQuery = Record<string, string | number | boolean | null | undefined>;

/**
 * Applies the query params of the current navigation, then every later change, so a link from
 * another workspace behaves the same whether this screen is opening or already on screen.
 */
export function watchQueryParams(route: ActivatedRoute, destroyRef: DestroyRef, handler: (params: ParamMap) => void): void {
  handler(route.snapshot.queryParamMap);
  route.queryParamMap.pipe(skip(1), takeUntilDestroyed(destroyRef)).subscribe(handler);
}

/**
 * Reads a param only when it names a value the screen knows. A hand-typed URL must not be able to
 * put a workspace into a state its own filters do not support.
 */
export function choiceParam(params: ParamMap, name: string, allowed: readonly string[], fallback = ''): string {
  const value = params.get(name);
  return value && allowed.includes(value) ? value : fallback;
}

/**
 * Reads a free-text param with the empty string as its neutral value.
 */
export function textParam(params: ParamMap, name: string): string {
  return params.get(name) || '';
}

/**
 * Reads a boolean param the way the API filters expect it (`true`, anything else is off).
 */
export function flagParam(params: ParamMap, name: string): boolean {
  return params.get(name) === 'true';
}

/**
 * Writes the list's current filters/tab/page into the URL (replacing history), so Back, refresh and a
 * shared link reopen the same view. Neutral values are dropped to keep URLs short. Pair with
 * `watchQueryParams`: its handler must skip reloading when the params already equal the screen's state.
 */
export function writeQueryParams(router: Router, route: ActivatedRoute, query: ListQuery): void {
  const queryParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '' || value === false) continue;
    queryParams[key] = String(value);
  }
  void router.navigate([], { relativeTo: route, queryParams, replaceUrl: true });
}

/** True when the URL already carries exactly these neutral-stripped params (no reload needed). */
export function queryMatches(params: ParamMap, query: ListQuery): boolean {
  const wanted = Object.entries(query).filter(([, v]) => !(v === null || v === undefined || v === '' || v === false));
  return params.keys.length === wanted.length && wanted.every(([key, value]) => params.get(key) === String(value));
}
