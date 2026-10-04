import { Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import { VoucherService } from '../../core/services/voucher.service';
import type { AppliedVoucher, CartItemRef, WalletVoucher } from '../../core/models/voucher.interface';

/**
 * Ví Voucher — bảng mã giảm giá chủ động dùng ở giỏ hàng và trang thanh toán.
 *
 * Khác bản cũ ở ba điểm, đều theo góp ý của giảng viên và chuẩn tham chiếu Coolmate:
 *  1. Hệ thống TỰ áp mã lợi nhất ngay khi mở, khách không phải tự gõ mã.
 *  2. Mã chưa đủ điều kiện vẫn hiển thị, kèm lý do và khoảng tiền còn thiếu — biến
 *     điều kiện thành động lực mua thêm thay vì một thông báo lỗi cụt.
 *  3. Dùng được cho cả khách vãng lai: ví mở ngay trên trang thanh toán, không bắt
 *     đăng nhập mới cho xem mã.
 */
@Component({
  selector: 'app-voucher-wallet',
  templateUrl: './voucher-wallet.html'
})
export class VoucherWallet {
  private readonly vouchers = inject(VoucherService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('walletDialog');
  private walletRequest?: Subscription;
  private manualRequest?: Subscription;
  private requestVersion = 0;
  private manualVersion = 0;
  private modalTrigger: HTMLElement | null = null;

  readonly orderValue = input.required<number>();
  readonly shippingFee = input(0);
  /**
   * Dòng giỏ hàng. Có thì máy chủ tự tính giá trị đơn từ bảng giá và xét được mã theo
   * danh mục; thiếu thì mã theo danh mục bị báo là chưa có sản phẩm phù hợp.
   */
  readonly cartItems = input<readonly CartItemRef[]>([]);
  /** Cho phép trang cha tắt tính năng tự áp mã (ví dụ khi khách đã chủ động bỏ mã). */
  readonly autoApply = input(true);
  /**
   * Mã khách đã chọn từ trước (mã hoặc `voucher_id`): từ nút "Dùng mã" ở trang Ưu đãi
   * qua `/cart?voucher=CODE`, hoặc mã đã chọn ở giỏ khi sang trang thanh toán. Được ưu
   * tiên hơn mã tốt nhất ở lần tải đầu, vì đó là lựa chọn của khách.
   */
  readonly preferred = input<string | null>(null);

  readonly applied = output<AppliedVoucher | null>();
  /**
   * Khách chủ động bỏ mã (true) hay chọn lại mã (false). Trang cha cần biết để gửi
   * `decline_voucher` khi báo giá và đặt đơn — phân biệt với trường hợp mã tự mất hiệu lực.
   */
  readonly declined = output<boolean>();

  readonly items = signal<WalletVoucher[]>([]);
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly modalOpen = signal(false);
  readonly manualCode = signal('');
  readonly manualError = signal<string | null>(null);
  readonly applying = signal(false);
  readonly selectedId = signal<string | null>(null);
  /** Khách đã tự bỏ mã thì không tự áp lại, nếu không nút "Bỏ mã" sẽ vô nghĩa. */
  private readonly dismissed = signal(false);
  /** Câu báo khi mã khách mang theo không áp được, kèm lý do. */
  readonly preferredNotice = signal<string | null>(null);
  /** Mã mang theo chỉ xét ở lần tải đầu; sau đó khách tự đổi trong ví. */
  private preferredHandled = false;

  readonly eligible = computed(() => this.items().filter((item) => item.eligible));
  readonly ineligible = computed(() => this.items().filter((item) => !item.eligible));
  readonly selected = computed(
    () => this.items().find((item) => item.voucher_id === this.selectedId()) ?? null
  );
  readonly hasAnyVoucher = computed(() => this.items().length > 0);
  private readonly cartKey = computed(() =>
    this.cartItems().map((item) => `${item.variant_id}:${item.quantity}`).join(',')
  );

  /** Mã dùng được tốt nhất mà khách CHƯA chọn — dùng cho gợi ý "còn mã lợi hơn". */
  readonly betterOption = computed(() => {
    const current = this.selected();
    const best = this.eligible().reduce<WalletVoucher | null>((best, item) => !best || item.discount_amount > best.discount_amount ? item : best, null);
    if (!best || !current) return null;
    return best.discount_amount > current.discount_amount ? best : null;
  });

  /** Mã gần đủ điều kiện nhất — hiển thị gợi ý mua thêm bao nhiêu. */
  readonly nearestGoal = computed(() => {
    const candidates = this.ineligible().filter(
      (item) => item.reason === 'MIN_ORDER_NOT_MET' && item.shortfall !== null
    );
    return candidates.reduce<WalletVoucher | null>((nearest, item) => !nearest || Number(item.shortfall) < Number(nearest.shortfall) ? item : nearest, null);
  });

  constructor() {
    let previousSession = this.vouchers.customerSession?.();
    effect(() => {
      const value = this.orderValue();
      const shipping = this.shippingFee();
      // Chỉ theo dõi nội dung giỏ, không theo dõi tham chiếu mảng, để trang cha dựng lại
      // mảng mới mỗi lần render không làm ví tải lại liên tục.
      const cartKey = this.cartKey();
      const session = this.vouchers.customerSession?.();
      untracked(() => {
        if (session !== previousSession) {
          previousSession = session;
          this.items.set([]);
          this.selectedId.set(null);
          this.preferredHandled = false;
          this.preferredNotice.set(null);
          this.manualCode.set('');
          this.manualError.set(null);
          this.applied.emit(null);
        }
        this.refresh(value, shipping);
      });
      void cartKey;
    });
    effect(() => {
      const dialog = this.dialog()?.nativeElement;
      if (this.modalOpen() && dialog && !dialog.open) dialog.showModal();
    });
  }

  /**
   * Tải lại ví theo giá trị đơn hiện tại và tự áp mã lợi nhất nếu được phép.
   */
  refresh(orderValue: number, shippingFee: number): void {
    this.walletRequest?.unsubscribe();
    this.manualRequest?.unsubscribe();
    this.manualVersion++;
    this.applying.set(false);
    const version = ++this.requestVersion;
    const cartKey = this.cartKey();
    const session = this.vouchers.customerSession?.();
    const current = () => version === this.requestVersion && cartKey === this.cartKey() && session === this.vouchers.customerSession?.() && orderValue === this.orderValue() && shippingFee === this.shippingFee();
    this.loading.set(true);
    this.loadError.set(null);
    this.walletRequest = this.vouchers.loadWallet(orderValue, shippingFee, this.cartItems()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => {
        if (!current()) return;
        this.loading.set(false);
        this.items.set(response.vouchers ?? []);
        this.reconcileSelection(response.best_voucher_id);
      },
      error: (error: Error) => {
        if (!current()) return;
        this.loading.set(false);
        this.items.set([]);
        this.selectedId.set(null);
        this.applied.emit(null);
        this.loadError.set(error.message || 'Không tải được danh sách ưu đãi.');
      }
    });
  }

  /**
   * Giữ lựa chọn của khách khi còn hợp lệ; ngược lại mới tự áp mã tốt nhất.
   *
   * Giỏ hàng thay đổi có thể khiến mã đang áp mất hiệu lực — lúc đó phải báo cho
   * trang cha biết để bỏ số tiền giảm khỏi tổng tiền, chứ không im lặng giữ nguyên.
   */
  private reconcileSelection(bestId: string | null): void {
    if (!this.selectedId() && this.applyPreferred()) return;
    const currentId = this.selectedId();
    if (currentId) {
      const still = this.items().find((item) => item.voucher_id === currentId);
      if (still?.eligible) {
        this.emit(still);
        return;
      }
      this.selectedId.set(null);
      this.applied.emit(null);
    }

    if (!this.autoApply() || this.dismissed() || !bestId) return;
    const best = this.items().find((item) => item.voucher_id === bestId);
    if (best?.eligible) {
      this.selectedId.set(best.voucher_id);
      this.emit(best);
    }
  }

  /**
   * Áp mã khách mang theo nếu dùng được. Trả true khi đã áp.
   *
   * Không dùng được thì nói rõ vì sao rồi để luồng tự chọn mã tốt nhất chạy tiếp, chứ
   * không im lặng thay bằng mã khác khiến khách tưởng mã mình chọn đã được áp.
   */
  private applyPreferred(): boolean {
    const wanted = (this.preferred() || '').trim();
    if (this.preferredHandled || !wanted) return false;
    this.preferredHandled = true;
    const upper = wanted.toUpperCase();
    const match = this.items().find((item) => item.voucher_id === wanted || item.code.toUpperCase() === upper);
    if (match?.eligible) {
      this.dismissed.set(false);
      this.declined.emit(false);
      this.selectedId.set(match.voucher_id);
      this.emit(match);
      return true;
    }
    this.preferredNotice.set(
      match
        ? `Mã ${match.code} chưa dùng được cho đơn này: ${match.reason_text || 'chưa đủ điều kiện'}`
        : `Không tìm thấy mã ${upper} trong ví của bạn. Mã có thể đã hết hạn hoặc không dành cho tài khoản này.`
    );
    return false;
  }

  /** Mở bảng chọn mã. */
  openModal(): void {
    this.modalTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.manualError.set(null);
    this.modalOpen.set(true);
  }

  /** Đóng bảng chọn mã. */
  closeModal(): void {
    const dialog = this.dialog()?.nativeElement;
    if (dialog?.open) dialog.close();
    this.modalOpen.set(false);
    if (this.modalTrigger?.isConnected) this.modalTrigger.focus();
    this.modalTrigger = null;
  }

  /**
   * Khách chọn một mã cụ thể trong ví.
   */
  choose(item: WalletVoucher): void {
    if (this.loading() || this.applying() || !this.items().some((current) => current.voucher_id === item.voucher_id && current.eligible)) return;
    this.preferredNotice.set(null);
    this.dismissed.set(false);
    this.declined.emit(false);
    this.selectedId.set(item.voucher_id);
    this.emit(item);
    this.closeModal();
  }

  /**
   * Bỏ mã đang áp. Khách chủ động bỏ thì hệ thống không tự áp lại.
   */
  clear(): void {
    this.manualRequest?.unsubscribe();
    this.manualVersion++;
    this.applying.set(false);
    this.dismissed.set(true);
    this.declined.emit(true);
    this.selectedId.set(null);
    this.applied.emit(null);
  }

  /** Cập nhật ô nhập mã thủ công. */
  setManualCode(event: Event): void {
    this.manualCode.set((event.target as HTMLInputElement).value);
    this.manualError.set(null);
  }

  /**
   * Áp một mã do khách tự gõ — vẫn giữ đường này vì khách nhận mã qua email hoặc
   * người quen giới thiệu sẽ không thấy mã đó trong ví của mình.
   */
  submitManualCode(): void {
    if (this.applying() || this.loading()) return;
    const code = this.manualCode().trim();
    if (!code) {
      this.manualError.set('Nhập mã giảm giá.');
      return;
    }
    this.applying.set(true);
    const version = ++this.manualVersion;
    const cartKey = this.cartKey();
    const orderValue = this.orderValue();
    const shippingFee = this.shippingFee();
    const session = this.vouchers.customerSession?.();
    const current = () => version === this.manualVersion && cartKey === this.cartKey() && orderValue === this.orderValue() && shippingFee === this.shippingFee() && session === this.vouchers.customerSession?.();
    this.manualRequest = this.vouchers.applyCode(code, orderValue, shippingFee, this.cartItems()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => {
        if (!current()) return;
        this.applying.set(false);
        if (!response.applied || !response.voucher_id) {
          this.manualError.set(response.message || 'Không áp dụng được mã này.');
          return;
        }
        this.dismissed.set(false);
        this.declined.emit(false);
        this.selectedId.set(response.voucher_id);
        this.manualCode.set('');
        this.applied.emit({
          voucher_id: response.voucher_id,
          code: response.code ?? code,
          name: response.name ?? code,
          discount_amount: Number(response.discount_amount ?? 0),
          discount_type: response.discount_type ?? 'fixed_amount'
        });
        this.refresh(this.orderValue(), this.shippingFee());
        this.closeModal();
      },
      error: (error: Error) => {
        if (!current()) return;
        this.applying.set(false);
        this.manualError.set(error.message || 'Mã giảm giá không hợp lệ.');
      }
    });
  }

  /** Định dạng tiền Việt cho template. */
  money(value: number | null | undefined): string {
    return `${Number(value ?? 0).toLocaleString('vi-VN')}đ`;
  }

  /** Nhãn ngày hết hạn. */
  expiryLabel(value: string | null): string {
    if (!value) return 'Không giới hạn';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('vi-VN');
  }

  private emit(item: WalletVoucher): void {
    this.applied.emit({
      voucher_id: item.voucher_id,
      code: item.code,
      name: item.name,
      discount_amount: item.discount_amount,
      discount_type: item.discount_type
    });
  }
}
