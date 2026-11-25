import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { guestSessionId as currentGuestSessionId } from '../utils/guest-session';
import { showToast } from '../utils/toast';

const PUBLIC_API_PREFIXES = ['/api/user/products', '/api/user/categories'];

function extractLockedMessage(error: HttpErrorResponse): string {
  const payload = error.error && typeof error.error === 'object' ? (error.error as Record<string, unknown>) : null;
  const nested = payload?.['error'] && typeof payload['error'] === 'object' ? (payload['error'] as Record<string, unknown>) : null;
  const msg = (typeof nested?.['message'] === 'string' && nested['message'])
    || (typeof payload?.['message'] === 'string' && payload['message'])
    || '';
  return msg.trim() || 'Tài khoản của bạn đã bị khóa. Vui lòng liên hệ CSKH để được hỗ trợ.';
}

function isAccountLockedResponse(error: HttpErrorResponse): boolean {
  if (error.status === 423) return true;
  const payload = error.error && typeof error.error === 'object' ? (error.error as Record<string, unknown>) : null;
  const nested = payload?.['error'] && typeof payload['error'] === 'object' ? (payload['error'] as Record<string, unknown>) : null;
  return nested?.['code'] === 'ACCOUNT_LOCKED' || payload?.['code'] === 'ACCOUNT_LOCKED';
}

/**
 * Attaches the Velura bearer token and guest session id used by the existing API.
 * Catalog reads stay anonymous so a stale JWT cannot block product pages.
 * Auth routes never send a leftover member token. Locked sessions (423) are evicted immediately.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const token =
    (typeof localStorage !== 'undefined' ? localStorage.getItem('velura_token') : null) ||
    (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('velura_token') : null);
  const guestSessionId = currentGuestSessionId();

  const isPublicCatalog = PUBLIC_API_PREFIXES.some((prefix) => req.url.includes(prefix));
  // Logout phải mang token để API thu hồi đúng phiên (UAT #742); các auth route khác thì không.
  const isAuthApi = req.url.includes('/api/user/auth') && !req.url.includes('/api/user/auth/logout');
  const isMeApi = req.url.includes('/api/auth/me');
  const headers: Record<string, string> = {
    'X-Guest-Session-ID': guestSessionId,
  };
  if (token && !isPublicCatalog && !isAuthApi) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return next(req.clone({ setHeaders: headers })).pipe(
    catchError((error: HttpErrorResponse) => {
      if (Boolean(token) && !isAuthApi && isAccountLockedResponse(error)) {
        const message = extractLockedMessage(error);
        if (auth.kickOutLocked(message)) {
          showToast(message);
          void router.navigate(['/auth/signin'], {
            queryParams: { locked: '1' },
            replaceUrl: true,
          });
        }
        return throwError(() => error);
      }

      if (Boolean(token) && isMeApi && error.status === 401) {
        auth.signOut();
        return throwError(() => error);
      }

      const canRetryAsGuest =
        error.status === 401 &&
        Boolean(token) &&
        !isAuthApi &&
        !isMeApi &&
        (req.method === 'GET' ||
          req.url.includes('/api/v1/chat') ||
          req.url.includes('/api/user/visual-search') ||
          req.url.includes('/api/user/ai-search'));
      if (!canRetryAsGuest) {
        return throwError(() => error);
      }
      try {
        localStorage.removeItem('velura_token');
        sessionStorage.removeItem('velura_token');
      } catch {}
      return next(
        req.clone({
          headers: req.headers.delete('Authorization').set('X-Guest-Session-ID', currentGuestSessionId()),
        }),
      );
    }),
  );
};
