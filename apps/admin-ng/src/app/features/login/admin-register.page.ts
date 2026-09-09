import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { useBodyClass } from '../../core/body-class';

@Component({
  selector: 'app-admin-register-page',
  imports: [RouterLink],
  host: { class: 'page-auth' },
  template: `
    <main class="auth-card register-card" role="main" aria-label="Đăng ký quản trị Velura">
      <img src="/assets/images/logo.png" alt="Velura" />
      <h1>Đăng ký admin đã tắt trong production</h1>
      <p>
        Tài khoản quản trị không được tạo trực tiếp trên giao diện. Hãy đăng nhập bằng Supabase SSO, sau đó super admin
        cấp quyền trong phân hệ Quản lý tài khoản.
      </p>
      <div class="register-actions">
        <a class="admin-btn admin-btn--secondary" routerLink="/login">Đăng nhập</a>
        <a class="admin-btn admin-btn--ghost" routerLink="/welcome">Về trang giới thiệu</a>
      </div>
    </main>
  `,
})
export class AdminRegisterPage {
  constructor() {
    useBodyClass('page-auth');
  }
}
