import { Component, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { catchError, filter, finalize, map, of, startWith } from 'rxjs';
import { AdminApiService } from '../core/admin-api.service';
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
  private readonly api = inject(AdminApiService);
  readonly session = inject(AdminSessionService);
  readonly sidebarCollapsed = signal(false);
  readonly logoutConfirmOpen = signal(false);
  readonly signingOut = signal(false);

  constructor() {
    useBodyClass('admin-page');
  }

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
   * Opens the AUTH-08 confirmation before signing out.
   */
  askLogout(): void {
    this.logoutConfirmOpen.set(true);
  }

  /**
   * Cancels the sign-out confirmation.
   */
  cancelLogout(): void {
    this.logoutConfirmOpen.set(false);
  }

  /**
   * Records sign-out on the API, then clears the admin session.
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
