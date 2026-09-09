import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AdminSessionService } from '../../core/admin-session.service';
import { AdminIcon } from '../../shared/admin-icon';

@Component({
  selector: 'app-admin-welcome-page',
  imports: [RouterLink, AdminIcon],
  templateUrl: './admin-welcome.page.html',
})
export class AdminWelcomePage {
  private readonly router = inject(Router);
  readonly session = inject(AdminSessionService);

  readonly profileId = computed(() => this.compactId(this.session.session()?.id));

  /**
   * Clears the original admin session and returns to login.
   */
  logout(): void {
    this.session.clear();
    void this.router.navigateByUrl('/login');
  }

  /**
   * Signs out before opening the original login form for another account.
   */
  switchAccount(): void {
    this.logout();
  }

  /**
   * Shortens a profile id the same way vanilla welcome.html does.
   */
  compactId(value: string | undefined): string {
    if (!value) {
      return '—';
    }
    return value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
  }
}
