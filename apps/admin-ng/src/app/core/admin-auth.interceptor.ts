import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { environment } from '../../environments/environment';
import { AdminSessionService } from './admin-session.service';

/**
 * Attaches the admin bearer token used by vanilla `/api/v1/admin/*` routes.
 */
export const adminAuthInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.url.startsWith(environment.supabaseUrl) || req.url.startsWith(environment.supabaseAuthUrl)) {
    return next(req);
  }
  const token = inject(AdminSessionService).token();
  if (!token) {
    return next(req);
  }
  return next(req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }));
};
