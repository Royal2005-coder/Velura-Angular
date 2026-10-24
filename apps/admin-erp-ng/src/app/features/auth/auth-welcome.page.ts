import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { useBodyClass } from '../../core/body-class';
import { AuthFrame } from './auth-frame';

/**
 * Waiting room for signed-in members without an active admin role.
 */
@Component({
  selector: 'app-auth-welcome-page',
  imports: [RouterLink, AuthFrame],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-auth-frame>
      <header class="welcome-head">
        <span class="welcome-pill">Tài khoản đang chờ duyệt</span>
        <h2>Chờ cấp quyền quản trị</h2>
        <p>
          Bạn đã đăng nhập thành công. Super admin cần gán vai trò vận hành trước khi workspace được mở.
        </p>
      </header>

      <dl class="welcome-profile">
        <div><dt>Tài khoản</dt><dd>{{ session.displayName() }}</dd></div>
        <div><dt>Email</dt><dd>{{ session.session()?.email || '—' }}</dd></div>
        <div><dt>Vai trò hiện tại</dt><dd>{{ session.roleLabel() }}</dd></div>
        <div><dt>Mã hồ sơ</dt><dd>{{ profileId() }}</dd></div>
      </dl>

      <div class="welcome-actions">
        <a class="erp-btn erp-btn--primary" href="mailto:admin@velura.vn?subject=Yeu%20cau%20cap%20quyen%20Velura%20ERP">
          Gửi yêu cầu quyền
        </a>
        <a class="erp-btn" routerLink="/change-password">Đổi mật khẩu</a>
        <button class="erp-btn erp-btn--ghost" type="button" (click)="logout()">Đăng xuất</button>
      </div>
    </app-auth-frame>
  `,
  styles: [
    `
      .welcome-head {
        display: grid;
        gap: 8px;
        margin-bottom: 20px;
      }
      .welcome-pill {
        justify-self: start;
        padding: 3px 9px;
        border-radius: 999px;
        background: var(--erp-warning-soft);
        color: var(--erp-warning);
        font-size: 10px;
        font-weight: 700;
      }
      .welcome-head h2 {
        font-family: var(--erp-display);
        font-size: 26px;
        color: var(--erp-ink);
      }
      .welcome-head p {
        color: var(--erp-muted);
        font-size: 12.5px;
        line-height: 1.6;
      }
      .welcome-profile {
        display: grid;
        gap: 0;
        margin: 0 0 20px;
        border: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-sm);
      }
      .welcome-profile div {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 9px 12px;
        border-bottom: 1px solid var(--erp-line);
        font-size: 12px;
      }
      .welcome-profile div:last-child {
        border-bottom: 0;
      }
      dt {
        color: var(--erp-muted);
      }
      dd {
        margin: 0;
        font-weight: 600;
        text-align: right;
      }
      .welcome-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
    `,
  ],
})
export class AuthWelcomePage {
  private readonly router = inject(Router);
  readonly session = inject(AdminErpSessionService);
  readonly profileId = computed(() => this.compactId(this.session.session()?.id));

  constructor() {
    useBodyClass('erp-auth');
  }

  /**
   * Clears the session and returns to login.
   */
  logout(): void {
    this.session.clear();
    void this.router.navigateByUrl('/login');
  }

  /**
   * Shortens a profile id for display.
   */
  compactId(value: string | undefined): string {
    if (!value) {
      return '—';
    }
    return value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
  }
}
