import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { AdminApiService } from './admin-api.service';
import { AdminSessionService } from './admin-session.service';

/**
 * Requires an active admin session for the shell. Does not pin operators to HQ dashboard.
 */
export const adminShellGuard: CanActivateFn = () => {
  const session = inject(AdminSessionService);
  const api = inject(AdminApiService);
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
    catchError(() => {
      session.clear();
      return of(router.createUrlTree(['/login']));
    }),
  );
};

/**
 * Lands `/` on the role's first module instead of always `/dashboard`.
 */
export const adminHomeRedirectGuard: CanActivateFn = () => {
  const session = inject(AdminSessionService);
  const router = inject(Router);
  return router.parseUrl(session.firstRoute());
};

/**
 * Mirrors vanilla `checkAuth()`: require token, refresh `/api/auth/me`, then role pages.
 */
export const adminAuthGuard: CanActivateFn = (route) => {
  const session = inject(AdminSessionService);
  const api = inject(AdminApiService);
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
      if (!session.canOpen(page, next)) {
        if (page === 'dashboard') {
          return router.parseUrl(session.firstRoute(next));
        }
        return router.createUrlTree(['/forbidden'], { queryParams: { from: page } });
      }
      return true;
    }),
    catchError(() => {
      session.clear();
      return of(router.createUrlTree(['/login']));
    }),
  );
};

/**
 * Mirrors vanilla `welcome.html` `checkAuth()`: members stay; admins go to their first module.
 */
export const adminWelcomeGuard: CanActivateFn = () => {
  const session = inject(AdminSessionService);
  const api = inject(AdminApiService);
  const router = inject(Router);
  if (!session.token()) {
    return router.createUrlTree(['/login']);
  }
  return api.me().pipe(
    map((context) => {
      const next = session.applyAuthContext(context);
      if (next.type === 'admin') {
        return router.parseUrl(session.firstRoute(next));
      }
      return true;
    }),
    catchError(() => {
      session.clear();
      return of(router.createUrlTree(['/login']));
    }),
  );
};

/**
 * Requires any signed-in session, including members waiting for admin rights.
 */
export const adminSessionGuard: CanActivateFn = () => {
  const session = inject(AdminSessionService);
  const api = inject(AdminApiService);
  const router = inject(Router);
  if (!session.token()) {
    return router.createUrlTree(['/login']);
  }
  return api.me().pipe(
    map((context) => {
      session.applyAuthContext(context);
      return true;
    }),
    catchError(() => {
      session.clear();
      return of(router.createUrlTree(['/login']));
    }),
  );
};

/**
 * Login stays reachable so a leftover HQ session can be replaced by another account.
 */
export const adminGuestGuard: CanActivateFn = () => true;
