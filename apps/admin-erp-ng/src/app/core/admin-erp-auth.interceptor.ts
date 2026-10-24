import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { environment } from '../../environments/environment';
import { AdminErpSessionService } from './admin-erp-session.service';

/**
 * Attaches the ERP admin bearer token to `/api/*` calls. Supabase auth calls are left untouched.
 */
export const adminErpAuthInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.url.startsWith(environment.supabaseUrl) || req.url.startsWith(environment.supabaseAuthUrl)) {
    return next(req);
  }
  const token = inject(AdminErpSessionService).token();
  if (!token) {
    return next(req);
  }
  return next(req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }));
};
