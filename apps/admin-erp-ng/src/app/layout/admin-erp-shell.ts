import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, startWith, catchError, finalize, of } from 'rxjs';
import { AdminErpApiService } from '../core/admin-erp-api.service';
import { AdminErpRefreshService } from '../core/admin-erp-refresh.service';
import { AdminErpSessionService } from '../core/admin-erp-session.service';
import {
  ADMIN_ERP_NAV_GROUPS,
  ADMIN_ERP_NAV_ITEMS,
  AdminErpNavGroup,
  AdminErpNavItem,
  adminErpNavItemForNavKey,
  adminErpNavLink,
} from '../core/admin-erp-navigation';
import { useBodyClass } from '../core/body-class';
import { AdminErpIcon } from '../shared/ui/admin-erp-icon';
import { AdminErpModal } from '../shared/ui/admin-modal';

type ShellNavGroup = Omit<AdminErpNavGroup, 'items'> & {
  items: AdminErpNavItem[];
};

/**
 * ERPNext-inspired workspace shell: grouped sidebar, compact topbar and routable workspaces.
 */
@Component({
  selector: 'app-admin-erp-shell',
  imports: [RouterLink, RouterOutlet, AdminErpIcon, AdminErpModal],
  templateUrl: './admin-erp-shell.html',
  styleUrl: './admin-erp-shell.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'erp-shell-host' },
})
export class AdminErpShell {
  private readonly router = inject(Router);
  private readonly api = inject(AdminErpApiService);
  private readonly refreshBus = inject(AdminErpRefreshService);
  readonly session = inject(AdminErpSessionService);

  readonly sidebarCollapsed = signal(false);
  readonly mobileNavOpen = signal(false);
  readonly logoutConfirmOpen = signal(false);
  readonly signingOut = signal(false);

  private readonly navigationTick = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      startWith(null),
    ),
    { initialValue: null },
  );

  readonly groups = computed<ShellNavGroup[]>(() => {
    return ADMIN_ERP_NAV_GROUPS.map((group) => ({
      ...group,
      items: group.items
        .map((key) => ADMIN_ERP_NAV_ITEMS[key])
        .filter((item) => this.session.canOpenAny(item.pageKeys)),
    })).filter((group) => group.items.length > 0);
  });

  readonly currentNav = computed(() => {
    this.navigationTick();
    let current = this.router.routerState.snapshot.root;
    let navKey = '';
    while (current.firstChild) {
      current = current.firstChild;
      const candidate = current.data['navKey'];
      if (typeof candidate === 'string') {
        navKey = candidate;
      }
    }
    const tab = this.router.parseUrl(this.router.url).queryParams['tab'];
    if (navKey === 'products' && tab === 'price') {
      return ADMIN_ERP_NAV_ITEMS.pricing;
    }
    return adminErpNavItemForNavKey(navKey);
  });

  readonly pageTitle = computed(() => this.currentNav()?.title || 'Velura ERP');
  readonly workspaceLabel = computed(() => {
    const item = this.currentNav();
    if (!item) {
      return '';
    }
    return ADMIN_ERP_NAV_GROUPS.find((group) => group.key === item.group)?.label || '';
  });
  readonly menuLabel = computed(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 920px)').matches) {
      return this.mobileNavOpen() ? 'Đóng menu' : 'Mở menu';
    }
    return this.sidebarCollapsed() ? 'Mở sidebar' : 'Thu gọn sidebar';
  });

  constructor() {
    useBodyClass('erp-admin');
    this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe(() => this.mobileNavOpen.set(false));
  }

  /**
   * Builds the router link for a nav item, including deep-link query params.
   */
  navLink(item: AdminErpNavItem): string {
    return adminErpNavLink(item);
  }

  /**
   * Whether an item is the current workspace.
   */
  isActive(item: AdminErpNavItem): boolean {
    return this.currentNav()?.key === item.key;
  }

  /**
   * Toggles the off-canvas nav on mobile and the rail on desktop.
   */
  toggleSidebar(): void {
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 920px)').matches) {
      this.mobileNavOpen.update((open) => !open);
      return;
    }
    this.sidebarCollapsed.update((collapsed) => !collapsed);
  }

  /**
   * Closes the mobile off-canvas nav.
   */
  closeMobileNav(): void {
    this.mobileNavOpen.set(false);
  }

  /**
   * Reloads the active workspace data without a full-page reload.
   */
  refresh(): void {
    this.refreshBus.request();
  }

  /**
   * Opens the sign-out confirmation.
   */
  askLogout(): void {
    this.logoutConfirmOpen.set(true);
  }

  /**
   * Cancels sign-out.
   */
  cancelLogout(): void {
    this.logoutConfirmOpen.set(false);
  }

  /**
   * Records sign-out, clears the ERP session and returns to login.
   */
  confirmLogout(): void {
    if (this.signingOut()) {
      return;
    }
    this.signingOut.set(true);
    this.api
      .signOut()
      .pipe(
        catchError(() => of({ success: true })),
        finalize(() => {
          this.signingOut.set(false);
          this.logoutConfirmOpen.set(false);
          this.session.clear();
          void this.router.navigateByUrl('/login', { replaceUrl: true });
        }),
      )
      .subscribe();
  }
}
