import { ChangeDetectionStrategy, Component } from '@angular/core';
import { environment } from '../../../environments/environment';

/**
 * admin-ng no longer owns the return workflow. The canonical state machine, carrier pickup
 * evidence, warehouse disposition and refund/exchange actions live in admin-erp.
 */
@Component({
  selector: 'app-admin-returns-moved-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="moved">
      <span class="moved__eyebrow">Đổi trả & CSKH</span>
      <h1>Luồng đổi trả đã chuyển sang Admin ERP</h1>
      <p>
        Admin ERP là nơi duy nhất xử lý vận đơn hoàn, bằng chứng ĐVVC, QA kho, nhập lại tồn,
        hoàn tiền và đơn đổi. Màn hình cũ không còn ghi dữ liệu để tránh hai state machine.
      </p>
      <a class="moved__link" [href]="adminErpUrl">Mở Admin ERP — Đổi trả & CSKH</a>
      <p class="moved__note">
        Nếu tài khoản chưa có quyền ở Admin ERP, liên hệ quản trị viên để cấp module
        <strong>returns</strong>.
      </p>
    </section>
  `,
  styles: [
    `
      .moved { display: grid; gap: 14px; max-width: 720px; margin: 32px auto; padding: 28px; border: 1px solid #e5e0db; border-radius: 18px; background: #fff; }
      .moved__eyebrow { font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #8a7f75; }
      h1 { margin: 0; font-size: 1.7rem; line-height: 1.25; }
      p { margin: 0; line-height: 1.6; color: #4c4540; }
      .moved__link { justify-self: start; padding: 11px 16px; border-radius: 999px; background: #1f1b18; color: #fff; text-decoration: none; font-weight: 700; }
      .moved__note { font-size: 13px; color: #7a716a; }
    `,
  ],
})
export class AdminReturnsMovedPage {
  readonly adminErpUrl = `${environment.adminErpUrl.replace(/\/+$/, '')}/returns`;
}
