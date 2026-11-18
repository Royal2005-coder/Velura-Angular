import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NavigationCancel, NavigationEnd, NavigationError, NavigationStart, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, startWith, catchError, finalize, of } from 'rxjs';
import { AdminErpApiService } from '../core/admin-erp-api.service';
import { AdminErpRefreshService } from '../core/admin-erp-refresh.service';
import { AdminErpSessionService } from '../core/admin-erp-session.service';
import {
  ADMIN_ERP_NAV_GROUPS,
  ADMIN_ERP_NAV_ITEMS,
  ADMIN_ERP_QUICK_ACTIONS,
  AdminErpNavGroup,
  AdminErpNavItem,
  adminErpNavItemForNavKey,
  adminErpNavLink,
  adminErpNavMatchesSearch,
  adminErpQuickActionMatchesSearch,
} from '../core/admin-erp-navigation';
import { useBodyClass } from '../core/body-class';
import { AdminErpConfirmHost } from '../shared/ui/admin-confirm';
import { AdminErpIcon } from '../shared/ui/admin-erp-icon';
import { AdminErpModal } from '../shared/ui/admin-modal';
import { AdminErpToastHost } from '../shared/ui/admin-toast';

type ShellNavGroup = Omit<AdminErpNavGroup, 'items'> & {
  items: AdminErpNavItem[];
};

export interface ShellPaletteEntry {
  readonly id: string;
  readonly kind: 'module' | 'quick';
  readonly label: string;
  readonly subtitle: string;
  readonly icon: string;
  readonly path: string;
  readonly queryParams?: Record<string, string>;
}

/** localStorage key holding the desktop sidebar rail state (`'true'` = collapsed). */
export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'velura-erp-sidebar-collapsed';

function readSidebarCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Storage blocked (private mode, quota): the rail still toggles for this session.
  }
}

/**
 * SaaS workspace shell: grouped sidebar with unique topic icons, responsive zero-overflow topbar,
 * keyboard-driven `⌘K` Command Palette with deep sub-queues, and routable workspaces.
 */
@Component({
  selector: 'app-admin-erp-shell',
  imports: [RouterLink, RouterOutlet, AdminErpIcon, AdminErpModal, AdminErpToastHost, AdminErpConfirmHost],
  templateUrl: './admin-erp-shell.html',
  styleUrl: './admin-erp-shell.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'erp-shell-host' },
})
export class AdminErpShell {
  private readonly router = inject(Router);
  private readonly api = inject(AdminErpApiService);
  private readonly refreshBus = inject(AdminErpRefreshService);
  private readonly destroyRef = inject(DestroyRef);
  readonly session = inject(AdminErpSessionService);

  /** Desktop rail state, restored from {@link SIDEBAR_COLLAPSED_STORAGE_KEY}. */
  readonly sidebarCollapsed = signal(readSidebarCollapsed());
  readonly mobileNavOpen = signal(false);
  readonly isMobile = signal(false);
  readonly navigating = signal(false);
  private readonly sidebar = viewChild<ElementRef<HTMLElement>>('sidebar');
  readonly logoutConfirmOpen = signal(false);
  readonly signingOut = signal(false);
  readonly searchOpen = signal(false);
  readonly searchQuery = signal('');
  readonly searchActiveIndex = signal(0);
  readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  /** A guard waiting on a slow API must not leave the blocking navigation layer up forever. */
  private navigationWatchdog: ReturnType<typeof setTimeout> | null = null;
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

  readonly searchResults = computed<readonly ShellPaletteEntry[]>(() => {
    const query = this.searchQuery();
    const entries: ShellPaletteEntry[] = [];
    const allowedNavKeys = new Set<string>();

    for (const group of this.groups()) {
      for (const item of group.items) {
        allowedNavKeys.add(item.key);
        if (!query.trim() || adminErpNavMatchesSearch(item, group.label, query)) {
          entries.push({
            id: `mod:${item.key}`,
            kind: 'module',
            label: item.label,
            subtitle: `${group.label} · ${item.title}`,
            icon: item.icon,
            path: item.path,
            queryParams: item.queryParams,
          });
        }
      }
    }

    for (const action of ADMIN_ERP_QUICK_ACTIONS) {
      if (!allowedNavKeys.has(action.navKey)) continue;
      if (!query.trim() || adminErpQuickActionMatchesSearch(action, query)) {
        entries.push({
          id: `quick:${action.id}`,
          kind: 'quick',
          label: action.label,
          subtitle: action.subtitle,
          icon: action.icon,
          path: action.path,
          queryParams: action.queryParams,
        });
      }
    }

    return entries;
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
    if (this.isMobile()) {
      return this.mobileNavOpen() ? 'Đóng menu' : 'Mở menu';
    }
    return this.sidebarCollapsed() ? 'Mở sidebar' : 'Thu gọn sidebar';
  });

  constructor() {
    useBodyClass('erp-admin');
    const media = window.matchMedia('(max-width: 920px)');
    this.isMobile.set(media.matches);
    const onMediaChange = (event: MediaQueryListEvent) => this.isMobile.set(event.matches);
    media.addEventListener('change', onMediaChange);
    this.destroyRef.onDestroy(() => {
      media.removeEventListener('change', onMediaChange);
      if (this.navigationWatchdog) clearTimeout(this.navigationWatchdog);
    });
    this.router.events
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        if (event instanceof NavigationStart) {
          this.navigating.set(true);
          if (this.navigationWatchdog) clearTimeout(this.navigationWatchdog);
          this.navigationWatchdog = setTimeout(() => {
            this.navigationWatchdog = null;
            this.navigating.set(false);
          }, 15_000);
          return;
        }
        if (event instanceof NavigationEnd || event instanceof NavigationCancel || event instanceof NavigationError) {
          if (this.navigationWatchdog) {
            clearTimeout(this.navigationWatchdog);
            this.navigationWatchdog = null;
          }
          this.navigating.set(false);
        }
      });
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.mobileNavOpen.set(false));
  }

  /** ⌘K / Ctrl+K opens module search; "/" jumps to the current page's first filter field (list convention). */
  @HostListener('document:keydown', ['$event'])
  onGlobalKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (this.searchOpen()) {
        this.closeSearch();
      } else {
        this.openSearch();
      }
      return;
    }
    const target = event.target as HTMLElement | null;
    const typing = !!target?.closest('input, textarea, select, [contenteditable="true"]');
    if (event.key === '/' && !typing && !event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const field = document.querySelector<HTMLInputElement>('app-erp-filter-bar input:not([type="checkbox"]):not([type="radio"])');
      if (field) {
        event.preventDefault();
        field.focus();
        field.select();
      }
    }
  }

  openSearch(): void {
    this.searchQuery.set('');
    this.searchActiveIndex.set(0);
    this.searchOpen.set(true);
    queueMicrotask(() => this.searchInput()?.nativeElement.focus());
  }

  closeSearch(): void {
    this.searchOpen.set(false);
    this.searchQuery.set('');
    this.searchActiveIndex.set(0);
  }

  onSearchInput(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.searchQuery.set(target?.value ?? '');
    this.searchActiveIndex.set(0);
  }

  /** Handles ArrowDown/ArrowUp/Home/End/Enter inside the `⌘K` Command Palette. */
  onSearchKeydown(event: KeyboardEvent): void {
    const list = this.searchResults();
    if (!list.length) return;
    const current = Math.min(this.searchActiveIndex(), list.length - 1);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.searchActiveIndex.set((current + 1) % list.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.searchActiveIndex.set((current - 1 + list.length) % list.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      this.searchActiveIndex.set(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      this.searchActiveIndex.set(list.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = list[Math.max(0, current)];
      if (chosen) {
        this.selectPaletteEntry(chosen);
      }
    }
  }

  setSearchActive(index: number): void {
    this.searchActiveIndex.set(index);
  }

  selectPaletteEntry(entry: ShellPaletteEntry): void {
    this.closeSearch();
    void this.router.navigateByUrl(this.navLink(entry));
  }

  /** Builds the router link for a nav item or palette entry, including deep-link query params. */
  navLink(item: { path: string; queryParams?: Record<string, string> }): string {
    return adminErpNavLink(item);
  }

  /** Returns a tooltip label only when the desktop rail is collapsed. */
  railTooltip(label: string): string | null {
    return this.sidebarCollapsed() && !this.isMobile() ? label : null;
  }

  /** Whether an item is the current workspace. */
  isActive(item: AdminErpNavItem): boolean {
    return this.currentNav()?.key === item.key;
  }

  /** Toggles the off-canvas nav on mobile and the rail on desktop; the rail state persists. */
  toggleSidebar(): void {
    if (this.isMobile()) {
      const open = !this.mobileNavOpen();
      this.mobileNavOpen.set(open);
      if (open) {
        queueMicrotask(() => this.sidebar()?.nativeElement.querySelector<HTMLElement>('a.nav-link')?.focus());
      }
      return;
    }
    const collapsed = !this.sidebarCollapsed();
    this.sidebarCollapsed.set(collapsed);
    writeSidebarCollapsed(collapsed);
  }

  /** Closes the mobile off-canvas nav. */
  closeMobileNav(): void {
    this.mobileNavOpen.set(false);
  }

  /** Reloads the active workspace data without a full-page reload. */
  refresh(): void {
    this.refreshBus.request();
  }

  /** Opens the sign-out confirmation. */
  askLogout(): void {
    this.logoutConfirmOpen.set(true);
  }

  /** Cancels sign-out. */
  cancelLogout(): void {
    this.logoutConfirmOpen.set(false);
  }

  /** Records sign-out, clears the ERP session and returns to login. */
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
