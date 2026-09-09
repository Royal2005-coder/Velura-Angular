import { Component, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { AdminSessionService } from '../core/admin-session.service';
import { useBodyClass } from '../core/body-class';
import { AdminIcon } from '../shared/admin-icon';

@Component({
  selector: 'app-admin-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, AdminIcon],
  host: { class: 'admin-page' },
  templateUrl: './admin-shell.html',
})
export class AdminShell {
  private readonly router = inject(Router);
  readonly session = inject(AdminSessionService);
  readonly sidebarCollapsed = signal(false);

  constructor() {
    useBodyClass('admin-page');
  }

  readonly pricingOpen = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      startWith(null),
      map(() => /\/(pricing|promotions)/.test(this.router.url)),
    ),
    { initialValue: /\/(pricing|promotions)/.test(this.router.url) },
  );

  readonly pageTitle = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      startWith(null),
      map(() => {
        let current = this.router.routerState.snapshot.root;
        while (current.firstChild) {
          current = current.firstChild;
        }
        return String(current.data['title'] || current.title || 'Dashboard');
      }),
    ),
    { initialValue: 'Dashboard' },
  );

  /**
   * Whether the current role may see a vanilla page key in the sidebar.
   */
  canSee(page: string): boolean {
    return this.session.canOpen(page);
  }

  /**
   * Collapses the original admin sidebar.
   */
  toggleSidebar(): void {
    this.sidebarCollapsed.update((open) => !open);
  }

  /**
   * Reloads the current Angular admin view the same way vanilla "Làm mới" does.
   */
  refresh(): void {
    window.location.reload();
  }

  /**
   * Clears the original admin session keys and returns to login.
   */
  logout(): void {
    this.session.clear();
    void this.router.navigateByUrl('/login');
  }
}
