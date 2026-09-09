import { Injectable, computed, signal } from '@angular/core';
import { adminInitials, adminIsHttpUrl } from './admin-format';

const TOKEN_KEY = 'velura_supabase_access_token';
const SESSION_KEY = 'velura_current_session';

export const ADMIN_ROLE_PAGES: Record<string, string[]> = {
  super_admin: ['dashboard', 'accounts', 'products', 'orders', 'reviews', 'returns-cskh', 'pricing', 'promotions', 'logs'],
  admin_viewer: ['dashboard'],
  admin_operator_sanpham: ['products', 'dashboard'],
  admin_operator_donhang: ['orders', 'dashboard'],
  admin_operator_gia_km: ['pricing', 'dashboard', 'promotions'],
  admin_operator_danhgia_review: ['reviews', 'dashboard'],
  admin_operator_cskh_dt: ['returns-cskh', 'dashboard'],
  member: ['welcome'],
  guest: ['welcome'],
};

export interface AdminAuthMe {
  user?: { id?: string; email?: string; phone?: string | null };
  profile?: {
    user_id?: string;
    full_name?: string;
    email?: string;
    phone?: string;
    avatar?: string;
    role?: string;
    is_active?: boolean;
    is_verified?: boolean;
  };
  role?: string;
  roleName?: string;
  isAdmin?: boolean;
  allowedPages?: string[];
}

export interface AdminSession {
  id: string;
  email: string;
  name: string;
  phone: string;
  role: string;
  roleCode: string;
  type: 'admin' | 'member';
  avatar: string;
  isActive: boolean;
  isVerified: boolean;
  allowedPages: string[];
}

/**
 * Mirrors vanilla `supabase-auth.js` session keys for the Angular admin shell.
 */
@Injectable({ providedIn: 'root' })
export class AdminSessionService {
  private readonly sessionState = signal<AdminSession | null>(this.readStoredSession());
  readonly session = this.sessionState.asReadonly();
  readonly isLoggedIn = computed(() => Boolean(this.sessionState()));
  readonly isAdmin = computed(() => this.sessionState()?.type === 'admin');
  readonly initials = computed(() => {
    const session = this.sessionState();
    if (!session) {
      return 'QA';
    }
    if (adminIsHttpUrl(session.avatar) || session.avatar.length > 3) {
      return adminInitials(session.name, 'QA');
    }
    return session.avatar || adminInitials(session.name, 'QA');
  });
  readonly avatarUrl = computed(() => {
    const avatar = this.sessionState()?.avatar || '';
    return adminIsHttpUrl(avatar) ? avatar : '';
  });
  readonly displayName = computed(() => this.sessionState()?.name || 'Quản trị viên');
  readonly roleLabel = computed(() => this.sessionState()?.role || 'Velura Admin');

  /**
   * Reads the original admin bearer token from session/local storage.
   */
  token(): string {
    return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || localStorage.getItem('velura_token') || '';
  }

  /**
   * Stores the access token the same way vanilla `setAccessToken` does.
   */
  setToken(token: string): void {
    sessionStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem('velura_token', token);
    localStorage.removeItem(TOKEN_KEY);
  }

  /**
   * Builds and persists the original admin session from `/api/auth/me`.
   */
  applyAuthContext(context: AdminAuthMe, token?: string): AdminSession {
    if (token) {
      this.setToken(token);
    }
    const session = this.buildSession(context);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    localStorage.removeItem(SESSION_KEY);
    this.sessionState.set(session);
    return session;
  }

  /**
   * Clears the original admin session keys.
   */
  clear(): void {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem('velura_token');
    this.sessionState.set(null);
  }

  /**
   * First allowed vanilla page, mapped to an Angular route.
   */
  firstRoute(session = this.sessionState()): string {
    const page = session?.allowedPages?.[0] || 'welcome';
    return this.toRoute(page);
  }

  /**
   * Maps vanilla HTML page keys onto Angular admin routes.
   */
  toRoute(page: string): string {
    if (page === 'returns-cskh') {
      return '/returns';
    }
    return `/${page}`;
  }

  /**
   * Whether the current role may open a vanilla page key.
   */
  canOpen(page: string, session = this.sessionState()): boolean {
    return Boolean(session?.allowedPages?.includes(page));
  }

  private buildSession(context: AdminAuthMe): AdminSession {
    const profile = context.profile;
    const authUser = context.user || {};
    const roleCode = context.role || 'member';
    const fullName = profile?.full_name || authUser.email?.split('@')[0] || 'Velura user';
    const initials = fullName
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
    return {
      id: profile?.user_id || authUser.id || '',
      email: profile?.email || authUser.email || '',
      name: fullName,
      phone: profile?.phone || authUser.phone || '',
      role: context.roleName || 'Thành viên',
      roleCode,
      type: context.isAdmin ? 'admin' : 'member',
      avatar: profile?.avatar || initials || 'QA',
      isActive: profile?.is_active !== false,
      isVerified: profile?.is_verified !== false,
      allowedPages: Array.isArray(context.allowedPages)
        ? context.allowedPages
        : ADMIN_ROLE_PAGES[roleCode] || ADMIN_ROLE_PAGES['member'],
    };
  }

  private readStoredSession(): AdminSession | null {
    const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as AdminSession;
    } catch {
      return null;
    }
  }
}
