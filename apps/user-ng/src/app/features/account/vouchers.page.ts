import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { VoucherService } from '../../core/services/voucher.service';
import { useBodyClass } from '../../core/utils/body-class';
import type { WalletVoucher } from '../../core/models/voucher.interface';

/**
 * Ví Voucher của thành viên.
 *
 * Khách vãng lai đã có ví ngay trên trang thanh toán; thành viên cần thêm một nơi để
 * xem toàn bộ mã đang có mà không phải mở giỏ hàng. Đánh giá ở giá trị đơn bằng 0 nên
 * cột điều kiện hiển thị đúng ngưỡng tối thiểu của từng mã thay vì trạng thái theo
 * một giỏ hàng cụ thể.
 */
@Component({
  selector: 'app-account-vouchers-page',
  imports: [RouterLink],
  host: { style: 'display:block' },
  templateUrl: './vouchers.page.html'
})
export class AccountVouchersPage {
  private readonly vouchers = inject(VoucherService);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly items = signal<WalletVoucher[]>([]);

  /** Mã dùng được ngay: chỉ vướng điều kiện giá trị đơn thì vẫn coi là còn dùng được. */
  readonly usable = computed(() =>
    this.items().filter((item) => item.eligible || item.reason === 'MIN_ORDER_NOT_MET')
  );
  readonly blocked = computed(() =>
    this.items().filter((item) => !item.eligible && item.reason !== 'MIN_ORDER_NOT_MET')
  );

  constructor() {
    useBodyClass('page-account-vouchers');
    this.load();
  }

  /** Tải toàn bộ mã của thành viên. */
  load(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.vouchers.loadWallet(0, 0).subscribe({
      next: (response) => {
        this.loading.set(false);
        this.items.set(response.vouchers ?? []);
      },
      error: (error: Error) => {
        this.loading.set(false);
        this.loadError.set(error.message || 'Không tải được ví voucher.');
      }
    });
  }

  /** Điều kiện giá trị đơn tối thiểu, viết cho khách đọc. */
  conditionLabel(item: WalletVoucher): string {
    return item.min_order_value > 0
      ? `Đơn tối thiểu ${this.money(item.min_order_value)}`
      : 'Không yêu cầu giá trị tối thiểu';
  }

  /** Mô tả mức giảm. */
  discountLabel(item: WalletVoucher): string {
    if (item.discount_type === 'free_shipping') return 'Miễn phí vận chuyển';
    if (item.discount_type === 'percentage') {
      const cap = item.max_discount_amount ? `, tối đa ${this.money(item.max_discount_amount)}` : '';
      return `Giảm ${item.discount_value}%${cap}`;
    }
    return `Giảm ${this.money(item.discount_value)}`;
  }

  /** Định dạng tiền Việt. */
  money(value: number | null | undefined): string {
    return `${Number(value ?? 0).toLocaleString('vi-VN')}đ`;
  }

  /** Nhãn ngày hết hạn. */
  expiryLabel(value: string | null): string {
    if (!value) return 'Không giới hạn';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('vi-VN');
  }
}
