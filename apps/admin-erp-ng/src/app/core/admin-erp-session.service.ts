import { Injectable, computed, signal } from '@angular/core';
import { adminInitials, adminIsHttpUrl } from './admin-erp-format';
import { ADMIN_ERP_NAV_ITEMS, adminErpNavItemForPage, adminErpNavLink } from './admin-erp-navigation';

const TOKEN_KEY = 'velura_admin_erp_access_token';
const SESSION_KEY = 'velura_admin_erp_session';

/** Actions understood by the capability model. API is the enforcement point. */
export type AdminErpAction = 'read' | 'create' | 'update' | 'delete' | 'approve';

export type AdminErpCapabilities = Readonly<Record<string, readonly AdminErpAction[]>>;

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
  allowedModules?: string[];
  capabilities?: Record<string, string[]>;
}

export interface AdminErpSession {
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
  allowedModules: string[];
  capabilities: AdminErpCapabilities;
}

/**
 * Session + capability model for the ERP admin.
 *
 * Reads are allowed from `allowedModules` until the API starts returning
 * `capabilities`; writes fail closed when no capability is present.
 */
@Injectable({ providedIn: 'root' })
export class AdminErpSessionService {
  private readonly sessionState = signal<AdminErpSession | null>(this.readStoredSession());
  readonly hydrating = signal(false);
  readonly session = this.sessionState.asReadonly();
  readonly isLoggedIn = computed(() => Boolean(this.sessionState()));
  readonly isAdmin = computed(() => this.sessionState()?.type === 'admin');
  readonly initials = computed(() => {
    const session = this.sessionState();
    if (!session) {
      return 'ERP';
    }
    if (adminIsHttpUrl(session.avatar) || session.avatar.length > 3) {
      return adminInitials(session.name, 'ERP');
    }
    return session.avatar || adminInitials(session.name, 'ERP');
  });
  readonly avatarUrl = computed(() => {
    const avatar = this.sessionState()?.avatar || '';
    return adminIsHttpUrl(avatar) ? avatar : '';
  });
  readonly displayName = computed(() => this.sessionState()?.name || 'Quản trị viên');
  readonly displayEmail = computed(() => this.sessionState()?.email || '');
  readonly roleLabel = computed(() => this.sessionState()?.role || 'Velura ERP');

  /**
   * Reads the app-specific bearer token.
   */
  token(): string {
    return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || '';
  }

  /**
   * Stores the bearer token in ERP-admin-only keys.
   */
  setToken(token: string): void {
    sessionStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(TOKEN_KEY, token);
  }

  /**
   * Persists the `/api/auth/me` context for guards and the shell.
   */
  applyAuthContext(context: AdminAuthMe, token?: string): AdminErpSession {
    if (token) {
      this.setToken(token);
    }
    const session = this.buildSession(context);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    this.sessionState.set(session);
    this.hydrating.set(false);
    return session;
  }

  /**
   * Hides a stale profile while `/api/auth/me` confirms the current role.
   */
  beginHydration(): void {
    this.hydrating.set(true);
    this.sessionState.set(null);
  }

  /**
   * Clears ERP admin keys.
   */
  clear(): void {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SESSION_KEY);
    this.sessionState.set(null);
    this.hydrating.set(false);
  }

  /**
   * Returns the first workspace the current role may open.
   */
  firstRoute(session = this.sessionState()): string {
    const pages = session?.allowedPages || [];
    if (session?.roleCode === 'super_admin' || session?.roleCode === 'admin_viewer') {
      return pages.includes('dashboard') ? '/dashboard' : this.firstOpenRoute(pages);
    }
    return this.firstOpenRoute(pages.filter((page) => page !== 'dashboard'));
  }

  /**
   * Maps an `/api/auth/me` page key to the ERP route, preserving deep links.
   */
  toRoute(page: string): string {
    const item = adminErpNavItemForPage(page);
    return item ? adminErpNavLink(item) : `/${page}`;
  }

  /**
   * Whether the role may open an `/api/auth/me` page key.
   */
  canOpen(page: string, session = this.sessionState()): boolean {
    return Boolean(session?.allowedPages?.includes(page));
  }

  /**
   * Whether the role may open at least one page key owned by a nav item.
   */
  canOpenAny(pages: readonly string[], session = this.sessionState()): boolean {
    return pages.some((page) => this.canOpen(page, session));
  }

  /**
   * Whether the role may perform an action on a backend module.
   *
   * Reads fall back to `allowedModules` until the API ships capabilities; writes
   * require an explicit capability so a stale session can never show write UI.
   */
  can(action: AdminErpAction, module: string, session = this.sessionState()): boolean {
    if (!session) {
      return false;
    }
    const granted = session.capabilities['*'] || session.capabilities[module] || [];
    if (granted.includes(action)) {
      return true;
    }
    if (action === 'read') {
      return session.allowedModules.includes('*') || session.allowedModules.includes(module);
    }
    return false;
  }

  private firstOpenRoute(pages: readonly string[]): string {
    const items = Object.values(ADMIN_ERP_NAV_ITEMS);
    for (const item of items) {
      if (item.pageKeys.some((page) => pages.includes(page))) {
        return adminErpNavLink(item);
      }
    }
    return pages[0] ? this.toRoute(pages[0]) : '/welcome';
  }

  private buildSession(context: AdminAuthMe): AdminErpSession {
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
      avatar: profile?.avatar || initials || 'ERP',
      isActive: profile?.is_active !== false,
      isVerified: profile?.is_verified !== false,
      allowedPages:
        Array.isArray(context.allowedPages) && context.allowedPages.length > 0
          ? context.allowedPages
          : ['welcome'],
      allowedModules: Array.isArray(context.allowedModules) ? context.allowedModules : [],
      capabilities: normalizeCapabilities(context.capabilities),
    };
  }

  private readStoredSession(): AdminErpSession | null {
    const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as AdminErpSession;
    } catch {
      return null;
    }
  }
}

const CAPABILITY_ACTIONS: readonly AdminErpAction[] = ['read', 'create', 'update', 'delete', 'approve'];

function normalizeCapabilities(value: Record<string, string[]> | undefined): AdminErpCapabilities {
  if (!value) {
    return {};
  }
  const result: Record<string, AdminErpAction[]> = {};
  for (const [module, actions] of Object.entries(value)) {
    const valid = actions.filter((action): action is AdminErpAction =>
      (CAPABILITY_ACTIONS as readonly string[]).includes(action),
    );
    if (valid.length) {
      result[module] = valid;
    }
  }
  return result;
}
