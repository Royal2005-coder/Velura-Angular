import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { AdminApiService } from './admin-api.service';
import { AdminSessionService } from './admin-session.service';

/**
 * Mirrors vanilla `checkAuth()`: require token, refresh `/api/auth/me`, then role pages.
 */
export const adminAuthGuard: CanActivateFn = (route) => {
  const session = inject(AdminSessionService);
  const api = inject(AdminApiService);
  const router = inject(Router);
  const page = String(route.data['page'] || 'dashboard');

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
      if (!session.canOpen(page, next)) {
        return router.createUrlTree([session.firstRoute(next)]);
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
        return router.createUrlTree([session.firstRoute(next)]);
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
 * Sends authenticated admins away from login/register.
 */
export const adminGuestGuard: CanActivateFn = () => {
  const session = inject(AdminSessionService);
  const api = inject(AdminApiService);
  const router = inject(Router);
  if (!session.token()) {
    return true;
  }
  return api.me().pipe(
    map((context) => {
      const next = session.applyAuthContext(context);
      return router.createUrlTree([session.firstRoute(next)]);
    }),
    catchError(() => {
      session.clear();
      return of(true);
    }),
  );
};
