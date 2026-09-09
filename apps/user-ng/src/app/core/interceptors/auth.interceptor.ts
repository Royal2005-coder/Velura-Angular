import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';

const PUBLIC_API_PREFIXES = ['/api/user/products', '/api/user/categories'];

/**
 * Attaches the Velura bearer token and guest session id used by the existing API.
 * Catalog reads stay anonymous so a stale JWT cannot block product pages.
 * Auth routes never send a leftover member token. Style quiz and chat retry without Bearer after 401.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const token = localStorage.getItem('velura_token');
  let guestSessionId = localStorage.getItem('velura_guest_session_id');
  if (!guestSessionId) {
    guestSessionId = `gs_${crypto.randomUUID()}`;
    localStorage.setItem('velura_guest_session_id', guestSessionId);
  }

  const isPublicCatalog = PUBLIC_API_PREFIXES.some((prefix) => req.url.includes(prefix));
  const isAuthApi = req.url.includes('/api/user/auth');
  const headers: Record<string, string> = {
    'X-Guest-Session-ID': guestSessionId,
  };
  if (token && !isPublicCatalog && !isAuthApi) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return next(req.clone({ setHeaders: headers })).pipe(
    catchError((error: HttpErrorResponse) => {
      const canRetryAsGuest =
        error.status === 401 &&
        Boolean(token) &&
        !isAuthApi &&
        (req.method === 'GET' ||
          req.url.includes('/api/user/style-quiz') ||
          req.url.includes('/api/v1/chat'));
      if (!canRetryAsGuest) {
        return throwError(() => error);
      }
      auth.signOut();
      return next(
        req.clone({
          headers: req.headers.delete('Authorization').set('X-Guest-Session-ID', guestSessionId),
        }),
      );
    }),
  );
};
