import { DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, type ParamMap } from '@angular/router';
import { skip } from 'rxjs';

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
