import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import {
  ADMIN_ERP_NAV_ITEMS,
  AdminErpNavKey,
  adminErpNavItemForNavKey,
} from '../../core/admin-erp-navigation';
import { AdminErpIcon } from '../../shared/ui/admin-erp-icon';
import { AdminErpPageHeader } from '../../shared/ui/admin-page-header';

const PLANNED_SCOPES: Record<AdminErpNavKey, string[]> = {
  dashboard: [],
  orders: [
    'Hàng đợi đơn theo trạng thái và thanh toán',
    'Chi tiết đơn, lịch sử xử lý và hành động được phép',
    'Đối soát COD, Stripe và giao vận',
  ],
  returns: [
    'Phiếu đổi/trả và bằng chứng',
    'Ticket CSKH, phân công và phản hồi',
    'Hội thoại khách hàng và audit theo module',
  ],
  products: [
    'Catalog, biến thể và SKU bền vững',
    'Tồn kho, ngưỡng cảnh báo và nhập CSV có duyệt',
    'Hình ảnh, nội dung và trạng thái bán',
  ],
  pricing: [
    'Giá niêm yết và giá khuyến mãi',
    'Lịch sử thay đổi giá theo người thao tác',
    'Tách quyền giá khỏi quyền catalog',
  ],
  promotions: [
    'Chiến dịch, voucher và ngân sách',
    'Lịch chạy, tạm dừng và thống kê',
    'Audit thay đổi khuyến mãi',
  ],
  reviews: [
    'Duyệt, ẩn và phản hồi đánh giá',
    'Đánh dấu nội dung cần xử lý gấp',
    'Lịch sử kiểm duyệt',
  ],
  accounts: [
    'Tài khoản khách hàng và nhân sự',
    'Yêu cầu nâng quyền và phê duyệt',
    'Khóa/mở tài khoản có lý do và audit',
  ],
  logs: [
    'Tra cứu audit theo module và người thao tác',
    'Lọc theo thời gian, hành động và kết quả',
    'Điều hướng từ log về entity gốc',
  ],
};

/**
 * Honest placeholder for workspaces whose real UI has not shipped yet.
 */
@Component({
  selector: 'app-coming-soon-page',
  imports: [RouterLink, AdminErpIcon, AdminErpPageHeader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (item(); as workspace) {
      <app-erp-page-header eyebrow="Workspace" [title]="workspace.title" [subtitle]="workspace.description">
        <div actions>
          <a class="erp-btn erp-btn--sm" routerLink="/dashboard">
            <app-erp-icon name="dashboard" [size]="'15'" />
            Về tổng quan
          </a>
        </div>
      </app-erp-page-header>

      <section class="erp-card soon">
        <span class="soon__badge">Đang hoàn thiện</span>
        <h2>Workspace này sẽ dùng dữ liệu thật từ API hiện tại.</h2>
        <p>
          Bản preview đã có IA, phân quyền và design system. Nghiệp vụ của workspace sẽ được port từ admin hiện tại,
          không thay contract API và không dùng dữ liệu giả.
        </p>
        <ul>
          @for (scope of scopes(); track scope) {
            <li>{{ scope }}</li>
          }
        </ul>
        <div class="soon__note">
          <app-erp-icon name="alert" [size]="'16'" />
          Đây là app song song tại <strong>admin-erp.royalai.dev</strong>; <strong>admin.royalai.dev</strong> vẫn là
          bản vận hành chính thức.
        </div>
      </section>
    }
  `,
  styles: [
    `
      .soon {
        display: grid;
        gap: 14px;
        max-width: 820px;
        padding: 26px;
      }
      .soon__badge {
        justify-self: start;
        padding: 4px 9px;
        border-radius: 999px;
        background: var(--erp-warning-soft);
        color: var(--erp-warning);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h2 {
        font-family: var(--erp-display);
        font-size: 24px;
        font-weight: 600;
        color: var(--erp-ink);
      }
      p {
        max-width: 68ch;
        color: var(--erp-muted);
        font-size: 13px;
        line-height: 1.65;
      }
      ul {
        display: grid;
        gap: 8px;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      li {
        padding: 10px 12px;
        border: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-sm);
        background: var(--erp-surface-muted);
        color: var(--erp-text);
        font-size: 12.5px;
      }
      li::before {
        content: '—';
        margin-right: 8px;
        color: var(--erp-accent-strong);
      }
      .soon__note {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 12px;
        border-radius: var(--erp-radius-sm);
        background: var(--erp-info-soft);
        color: var(--erp-info);
        font-size: 11.5px;
        line-height: 1.55;
      }
    `,
  ],
})
export class ComingSoonPage {
  private readonly route = inject(ActivatedRoute);
  readonly navKey = toSignal(
    this.route.data.pipe(map((data) => String(data['navKey'] || ''))),
    { initialValue: String(this.route.snapshot.data['navKey'] || '') },
  );
  readonly tab = toSignal(
    this.route.queryParamMap.pipe(map((params) => params.get('tab') || '')),
    { initialValue: this.route.snapshot.queryParamMap.get('tab') || '' },
  );
  readonly item = computed(() => {
    if (this.navKey() === 'products' && this.tab() === 'price') {
      return ADMIN_ERP_NAV_ITEMS.pricing;
    }
    return adminErpNavItemForNavKey(this.navKey());
  });
  readonly scopes = computed(() => {
    const key = this.item()?.key;
    return key ? PLANNED_SCOPES[key] : [];
  });
}
