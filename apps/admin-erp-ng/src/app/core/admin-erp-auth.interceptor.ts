import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { environment } from '../../environments/environment';
import { AdminErpSessionService } from './admin-erp-session.service';

/**
 * Attaches the ERP admin bearer token to `/api/*` calls. Supabase auth calls are left untouched.
 * A 401 clears the tab session once and returns to login instead of leaving stale UI — even
 * when the tab had already lost its token, so a modal cannot keep showing an English
 * "Authentication is required" (UAT TC_ACC_18).
 */
export const adminErpAuthInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.url.startsWith(environment.supabaseUrl) || req.url.startsWith(environment.supabaseAuthUrl)) {
    return next(req);
  }
  const session = inject(AdminErpSessionService);
  const router = inject(Router);
  const token = session.token();
  const signInRequest = req.url.endsWith('/api/auth/signin');
  const request = token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;
  return next(request).pipe(
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse && error.status === 401 && !signInRequest) {
        session.clear();
        void router.navigateByUrl('/login', { replaceUrl: true });
      }
      return throwError(() => error);
    }),
  );
};
