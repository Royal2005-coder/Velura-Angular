import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { useBodyClass } from '../../core/body-class';
import { AuthFrame } from './auth-frame';

/**
 * Production registration is disabled; admins are provisioned through account management.
 */
@Component({
  selector: 'app-auth-register-page',
  imports: [RouterLink, AuthFrame],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-auth-frame>
      <header class="register-head">
        <span>Quyền truy cập</span>
        <h2>Đăng ký trực tiếp đang tắt</h2>
        <p>
          Tài khoản quản trị không được tạo trên giao diện. Hãy đăng nhập bằng tài khoản đã có, sau đó super admin cấp
          vai trò trong workspace Tài khoản.
        </p>
      </header>
      <div class="register-actions">
        <a class="erp-btn erp-btn--primary" routerLink="/login">Về đăng nhập</a>
        <a class="erp-btn" routerLink="/welcome">Trang chờ duyệt</a>
      </div>
    </app-auth-frame>
  `,
  styles: [
    `
      .register-head {
        display: grid;
        gap: 8px;
        margin-bottom: 22px;
      }
      .register-head span {
        color: var(--erp-accent-strong);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .register-head h2 {
        font-family: var(--erp-display);
        font-size: 26px;
        color: var(--erp-ink);
      }
      .register-head p {
        color: var(--erp-muted);
        font-size: 12.5px;
        line-height: 1.65;
      }
      .register-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
    `,
  ],
})
export class AuthRegisterPage {
  constructor() {
    useBodyClass('erp-auth');
  }
}
