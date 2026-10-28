import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { environment } from '../../environments/environment';
import { AdminErpSessionService } from './admin-erp-session.service';

/**
 * Attaches the ERP admin bearer token to `/api/*` calls. Supabase auth calls are left untouched.
 * A mid-session 401 clears the tab session once and returns to login instead of leaving stale UI.
 */
export const adminErpAuthInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.url.startsWith(environment.supabaseUrl) || req.url.startsWith(environment.supabaseAuthUrl)) {
    return next(req);
  }
  const session = inject(AdminErpSessionService);
  const router = inject(Router);
  const token = session.token();
  if (!token) {
    return next(req);
  }
  return next(req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })).pipe(
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse && error.status === 401 && session.token()) {
        session.clear();
        void router.navigateByUrl('/login', { replaceUrl: true });
      }
      return throwError(() => error);
    }),
  );
};
