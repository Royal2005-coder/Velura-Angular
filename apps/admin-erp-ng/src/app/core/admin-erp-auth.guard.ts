import { inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { AdminErpApiService } from './admin-erp-api.service';
import { AdminErpSessionService } from './admin-erp-session.service';

/**
 * Requires an active admin session for the workspace shell.
 */
export const adminErpShellGuard: CanActivateFn = () => {
  const session = inject(AdminErpSessionService);
  const api = inject(AdminErpApiService);
  const router = inject(Router);
  if (!session.token()) {
    return router.createUrlTree(['/login']);
  }
  session.beginHydration();
  return api.me().pipe(
    map((context) => {
      const next = session.applyAuthContext(context);
      if (!next.isActive) {
        session.clear();
        return router.createUrlTree(['/login']);
      }
      if (next.type !== 'admin') {
        return router.createUrlTree(['/welcome']);
      }
      return true;
    }),
    catchError((error: unknown) => {
      if (isAuthFailure(error)) {
        session.clear();
        return of(router.createUrlTree(['/login']));
      }
      // Network/5xx blips must not sign the operator out; keep the tab-local session.
      session.restoreStoredSession();
      if (!session.session()) {
        session.clear();
        return of(router.createUrlTree(['/login']));
      }
      return of(true);
    }),
  );
};

/**
 * Lands `/` on the first workspace the role may open.
 */
export const adminErpHomeRedirectGuard: CanActivateFn = () => {
  const session = inject(AdminErpSessionService);
  const router = inject(Router);
  return router.parseUrl(session.firstRoute());
};

/**
 * Refreshes `/api/auth/me` and enforces the route's page keys.
 */
export const adminErpAuthGuard: CanActivateFn = (route) => {
  const session = inject(AdminErpSessionService);
  const api = inject(AdminErpApiService);
  const router = inject(Router);
  const page = String(route.data['page'] || '');

  if (!session.token()) {
    return router.createUrlTree(['/login']);
  }

  return api.me().pipe(
    map((context) => {
      const next = session.applyAuthContext(context);
      if (!next.isActive) {
        session.clear();
        return router.createUrlTree(['/login']);
      }
      if (next.type !== 'admin') {
        return router.createUrlTree(['/welcome']);
      }
      if (!page) {
        return router.parseUrl(session.firstRoute(next));
      }
      const alternatives: unknown = route.data['alternativePages'];
      const canOpenAlternative =
        Array.isArray(alternatives) &&
        alternatives.some((alternative: unknown) => typeof alternative === 'string' && session.canOpen(alternative, next));
      if (!session.canOpen(page, next) && !canOpenAlternative) {
        if (page === 'dashboard') {
          return router.parseUrl(session.firstRoute(next));
        }
        return router.createUrlTree(['/forbidden'], { queryParams: { from: page } });
      }
      return true;
    }),
    catchError((error: unknown) => {
      if (isAuthFailure(error)) {
        session.clear();
        return of(router.createUrlTree(['/login']));
      }
      // Network/5xx blips must not sign the operator out; keep the tab-local session.
      session.restoreStoredSession();
      if (!session.session()) {
        session.clear();
        return of(router.createUrlTree(['/login']));
      }
      return of(true);
    }),
  );
};

/**
 * Keeps signed-in members on the waiting page while admins continue to their workspace.
 */
export const adminErpWelcomeGuard: CanActivateFn = () => {
  const session = inject(AdminErpSessionService);
  const api = inject(AdminErpApiService);
  const router = inject(Router);
  if (!session.token()) {
    return router.createUrlTree(['/login']);
  }
  return api.me().pipe(
    map((context) => {
      const next = session.applyAuthContext(context);
      return next.type === 'admin' ? router.parseUrl(session.firstRoute(next)) : true;
    }),
    catchError((error: unknown) => {
      if (isAuthFailure(error)) {
        session.clear();
        return of(router.createUrlTree(['/login']));
      }
      // Network/5xx blips must not sign the operator out; keep the tab-local session.
      session.restoreStoredSession();
      if (!session.session()) {
        session.clear();
        return of(router.createUrlTree(['/login']));
      }
      return of(true);
    }),
  );
};

/**
 * Requires any signed-in session, including members waiting for admin rights.
 */
export const adminErpSessionGuard: CanActivateFn = () => {
  const session = inject(AdminErpSessionService);
  const api = inject(AdminErpApiService);
  const router = inject(Router);
  if (!session.token()) {
    return router.createUrlTree(['/login']);
  }
  return api.me().pipe(
    map((context) => {
      session.applyAuthContext(context);
      return true;
    }),
    catchError((error: unknown) => {
      if (isAuthFailure(error)) {
        session.clear();
        return of(router.createUrlTree(['/login']));
      }
      // Network/5xx blips must not sign the operator out; keep the tab-local session.
      session.restoreStoredSession();
      if (!session.session()) {
        session.clear();
        return of(router.createUrlTree(['/login']));
      }
      return of(true);
    }),
  );
};

/**
 * Login stays reachable so a leftover session can be replaced by another account.
 */
export const adminErpGuestGuard: CanActivateFn = () => true;

function isAuthFailure(error: unknown): boolean {
  return error instanceof HttpErrorResponse && (error.status === 401 || error.status === 403);
}
