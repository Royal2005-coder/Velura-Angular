import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { DestroyRef, Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter, firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';
import { showToast } from '../utils/toast';

interface AuthMeResponse {
  user?: { id?: string | null } | null;
  profile?: {
    user_id?: string | null;
    is_active?: boolean | null;
    lock_type?: string | null;
    lock_reason?: string | null;
  } | null;
  role?: string | null;
}

const PASSIVE_SYNC_TTL_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Keeps signed-in storefront state synchronized with server lock/session status across
 * navigation, browser history back/forward, tab focus, and background intervals.
 */
@Injectable({ providedIn: 'root' })
export class SessionSyncService {
  private readonly http = inject(HttpClient, { optional: true });
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private inflight: Promise<boolean> | null = null;
  private lastVerifiedAt = 0;
  private started = false;

  /**
   * Attaches router and window listeners so locked accounts are evicted on navigation,
   * browser back/forward, tab reactivation, or periodic polling.
   */
  start(destroyRef: DestroyRef): void {
    if (this.started) return;
    this.started = true;

    const routerSub = this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe(() => {
        if (this.auth.isLoggedIn()) {
          void this.syncNow(false);
        }
      });

    const onPopState = () => {
      if (this.auth.isLoggedIn()) {
        void this.syncNow(true);
      }
    };
    const onFocus = () => {
      if (this.auth.isLoggedIn()) {
        void this.syncNow(true);
      }
    };
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible' && this.auth.isLoggedIn()) {
        void this.syncNow(true);
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('popstate', onPopState);
      window.addEventListener('focus', onFocus);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        if (this.auth.isLoggedIn()) {
          void this.syncNow(false);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);

    destroyRef.onDestroy(() => {
      this.started = false;
      routerSub.unsubscribe();
      clearInterval(timer);
      if (typeof window !== 'undefined') {
        window.removeEventListener('popstate', onPopState);
        window.removeEventListener('focus', onFocus);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    });
  }

  /**
   * Revalidates the active session against `/api/auth/me`. Returns false and evicts
   * the user immediately if the account has been locked or the token is no longer valid.
   */
  async syncNow(force = false): Promise<boolean> {
    if (!this.auth.isLoggedIn()) return false;
    if (!this.http) return true;
    const now = Date.now();
    if (!force && this.lastVerifiedAt > 0 && now - this.lastVerifiedAt < PASSIVE_SYNC_TTL_MS) {
      return true;
    }
    if (this.inflight) return this.inflight;

    this.inflight = this.verifyWithServer().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async verifyWithServer(): Promise<boolean> {
    if (!this.http || !this.auth.isLoggedIn()) return false;
    try {
      const res = await firstValueFrom(this.http.get<AuthMeResponse>('/api/auth/me'));
      const profile = res?.profile;
      const lockType = typeof profile?.lock_type === 'string' ? profile.lock_type.trim() : '';
      if (lockType) {
        const baseMessage = lockType === 'permanent'
          ? 'Tài khoản đã bị quản trị viên khóa vĩnh viễn. Vui lòng liên hệ CSKH để được hỗ trợ.'
          : 'Tài khoản đã bị quản trị viên tạm khóa. Vui lòng liên hệ CSKH để được hỗ trợ.';
        const reason = typeof profile?.lock_reason === 'string' ? profile.lock_reason.trim() : '';
        this.evictLocked(reason ? `${baseMessage} Lý do: ${reason}` : baseMessage);
        return false;
      }
      if (!res?.user?.id || !profile?.user_id || profile.is_active === false) {
        this.auth.signOut();
        void this.router.navigate(['/auth/signin'], { replaceUrl: true });
        return false;
      }
      this.lastVerifiedAt = Date.now();
      this.auth.syncRole(res.role);
      return true;
    } catch (error: unknown) {
      if (error instanceof HttpErrorResponse) {
        if (error.status === 423) {
          return false;
        }
        if (error.status === 401) {
          this.auth.signOut();
          void this.router.navigate(['/auth/signin'], { replaceUrl: true });
          return false;
        }
      }
      return true;
    }
  }

  private evictLocked(message: string): void {
    if (this.auth.kickOutLocked(message)) {
      showToast(message);
      void this.router.navigate(['/auth/signin'], {
        queryParams: { locked: '1' },
        replaceUrl: true,
      });
    }
  }
}
