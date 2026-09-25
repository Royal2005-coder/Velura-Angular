import { Component, DestroyRef, effect, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  DemoOrder,
  DemoOrderLine,
  DemoOrderStatus,
  DemoReturn,
  DemoReturnLine,
  ORDER_LABELS,
  PurchaseDemoStore,
  canCancel,
  maskPhone,
  normalizePhone,
  withinReturnWindow,
} from '../../core/services/purchase-demo.store';
import { formatVnd, toPublicAsset } from '../../core/utils/money';
import { isGuestPreview } from '../../core/utils/preview-mode';

/** Guest access, order actions and after-sales are driven by the same isolated demo Model. */
@Component({
  selector: 'app-order-flow',
  imports: [FormsModule, RouterLink],
  templateUrl: './order-flow.page.html',
  styleUrls: [
    '../shared/purchase-flow.css',
    '../shared/purchase-flow-forms.css',
    '../shared/purchase-flow-layout.css',
    '../shared/purchase-flow-responsive.css',
  ],
})
export class OrderFlowPage {
  readonly model = inject(PurchaseDemoStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  readonly view = signal<
    | 'lookup'
    | 'otp'
    | 'list'
    | 'requests'
    | 'detail'
    | 'cancel'
    | 'cancel-confirm'
    | 'return'
    | 'return-summary'
    | 'tracking'
  >('lookup');
  readonly selectedId = signal('');
  readonly order = computed(
    () =>
      this.model
        .orders()
        .find((order) => order.id === this.selectedId() && this.authorized(order)) || null,
  );
  readonly requestId = signal('');
  readonly request = computed(() =>
    this.order()
      ? this.model
          .requests()
          .find(
            (request) => request.id === this.requestId() && request.orderId === this.order()?.id,
          ) || null
      : null,
  );
  readonly selections = signal<Record<string, DemoReturnLine>>({});
  readonly selectedLines = computed(() =>
    Object.values(this.selections()).filter((item) => item.quantity > 0),
  );
  readonly error = signal('');
  readonly maskedPhone = signal('');
  readonly verified = signal(false);
  readonly seconds = signal(300);
  readonly cooldown = signal(0);
  readonly busy = signal(false);
  readonly evidence = signal<Array<{ name: string; url: string }>>([]);
  readonly labels = ORDER_LABELS;
  readonly money = formatVnd;
  readonly image = (url: string) => toPublicAsset(url, '/assets/images/placeholder.jpg');
  readonly canCancel = canCancel;
  readonly withinWindow = withinReturnWindow;
  readonly orderSteps = computed<DemoOrderStatus[]>(() =>
    this.order()?.payment === 'VNPAY'
      ? ['pending_payment', 'paid', 'confirmed', 'preparing', 'shipping', 'delivered']
      : ['pending', 'confirmed', 'preparing', 'shipping', 'delivered'],
  );
  readonly orderStepIndex = computed(() =>
    this.orderSteps().indexOf(this.order()?.status || 'pending'),
  );
  readonly visibleOrders = computed(() =>
    this.model
      .orders()
      .filter(
        (order) =>
          this.authorized(order) &&
          (!this.filter() || order.id.toLowerCase().includes(this.filter().toLowerCase())),
      ),
  );
  readonly filter = signal('');
  readonly visibleRequests = computed(() =>
    this.model
      .requests()
      .filter((request) =>
        this.model.orders().some((order) => order.id === request.orderId && this.authorized(order)),
      ),
  );
  readonly returnsEntry = this.route.snapshot.routeConfig?.path?.endsWith('returns') || false;
  mode: 'phone' | 'code' = 'phone';
  query = '';
  otp = '';
  reason = 'Tôi muốn thay đổi sản phẩm';
  otherReason = '';
  returnKind: DemoReturn['kind'] = 'refund';
  returnReason = '';
  bankName = '';
  bankAccount = '';
  bankHolder = '';
  private challengePhone = '';
  private challengeOrderId = '';
  private timeout: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    let initialUser = this.model.userId();
    effect(() => {
      const current = this.model.userId();
      if (current !== initialUser) {
        initialUser = current;
        clearTimeout(this.timeout);
        this.clearEvidence();
        this.verified.set(false);
        this.selectedId.set('');
        this.requestId.set('');
        this.busy.set(false);
        this.view.set(this.model.member() ? 'list' : 'lookup');
        void this.router.navigateByUrl(this.model.member() ? '/account/orders' : '/guest/orders');
      }
    });
    const id =
      this.route.snapshot.paramMap.get('id') || this.route.snapshot.queryParamMap.get('order');
    if (this.model.member()) {
      this.view.set(this.returnsEntry ? 'requests' : 'list');
      if (id) this.open(id);
    } else if (isGuestPreview()) {
      this.model.verifiedPhone.set('0901234567');
      this.verified.set(true);
      this.view.set(this.returnsEntry ? 'requests' : 'list');
      if (id) this.open(id);
    } else if (this.model.verifiedPhone()) {
      this.verified.set(true);
      this.view.set(this.returnsEntry ? 'requests' : 'list');
      if (id) this.open(id);
    } else if (id) {
      this.mode = 'code';
      this.query = id;
    }
    const timer = setInterval(() => {
      this.seconds.update((value) => Math.max(0, value - 1));
      this.cooldown.update((value) => Math.max(0, value - 1));
    }, 1000);
    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
      clearTimeout(this.timeout);
      this.clearEvidence();
    });
  }
  /** Both guest lookup methods challenge ownership before exposing order details. */
  lookup(): void {
    this.error.set('');
    this.verified.set(false);
    this.selectedId.set('');
    const order =
      this.mode === 'code'
        ? this.model
            .orders()
            .find((row) => !row.member && row.id.toLowerCase() === this.query.trim().toLowerCase())
        : undefined;
    if (this.mode === 'code' && !order) {
      this.error.set('Không tìm thấy mã đơn mẫu. Kiểm tra mã ở màn cảm ơn.');
      return;
    }
    const phone = order?.address.phone || this.query;
    try {
      this.model.sendOtp(phone);
      this.challengePhone = normalizePhone(phone);
      this.challengeOrderId = order?.id || '';
      this.maskedPhone.set(maskPhone(phone));
      this.seconds.set(300);
      this.cooldown.set(30);
      this.otp = '';
      this.view.set('otp');
    } catch (error) {
      this.error.set((error as Error).message);
    }
  }
  /** Resend only after the challenge cooldown; display only the masked destination. */
  resend(): void {
    try {
      this.model.sendOtp(this.challengePhone);
      this.seconds.set(300);
      this.cooldown.set(30);
      this.otp = '';
      this.error.set('');
    } catch (error) {
      this.error.set((error as Error).message);
    }
  }
  /** A valid guest challenge exposes only orders belonging to that phone. */
  verify(): void {
    try {
      this.model.verifyOtp(this.otp);
      this.verified.set(true);
      this.error.set('');
      this.view.set(this.returnsEntry ? 'requests' : 'list');
      if (this.challengeOrderId) this.open(this.challengeOrderId);
    } catch (error) {
      this.error.set((error as Error).message);
    }
  }
  /** Open an authorized order on its canonical detail URL, unless an internal after-sales view owns the URL. */
  open(id: string, updateUrl = true): void {
    const order = this.model.orders().find((row) => row.id === id);
    if (!order || !this.authorized(order)) {
      this.error.set('Vui lòng xác thực chủ đơn trước khi xem chi tiết.');
      this.view.set(this.model.member() ? 'list' : 'lookup');
      return;
    }
    this.selectedId.set(id);
    this.error.set('');
    this.view.set('detail');
    if (updateUrl) {
      void this.router.navigate([this.model.member() ? '/account/orders' : '/guest/orders', id], {
        replaceUrl: true,
      });
    }
  }
  /** Begin cancellation only before preparation, preserving a readable confirmation. */
  startCancel(): void {
    const order = this.order();
    if (order && this.authorized(order) && canCancel(order)) {
      this.error.set('');
      this.view.set('cancel');
    }
  }
  /** Collect analytical reason separately from the final cancellation decision. */
  reviewCancel(): void {
    if (this.reason === 'Khác' && !this.otherReason.trim()) {
      this.error.set('Nhập lý do khác để tiếp tục.');
      return;
    }
    this.error.set('');
    this.view.set('cancel-confirm');
  }
  /** Recheck the Model on submit, including an order that changed while the form was open. */
  confirmCancel(): void {
    const order = this.order();
    if (!order || this.busy() || !this.authorized(order)) return;
    this.busy.set(true);
    this.timeout = setTimeout(() => {
      try {
        this.model.cancel(order.id, this.reason === 'Khác' ? this.otherReason.trim() : this.reason);
        this.error.set('');
        this.view.set('detail');
      } catch (error) {
        this.error.set((error as Error).message);
        this.view.set('detail');
      } finally {
        this.busy.set(false);
      }
    }, 350);
  }
  /** Reviewer controls exercise boundaries without an admin backend. */
  scenario(status: DemoOrderStatus, days = 0): void {
    const order = this.order();
    if (order) this.model.scenario(order.id, status, days);
  }
  /** Start a new request with no previous selections or evidence. */
  startReturn(): void {
    const order = this.order();
    if (!order || !this.authorized(order) || !withinReturnWindow(order)) return;
    this.selections.set({});
    this.clearEvidence();
    this.returnReason = '';
    this.error.set('');
    this.view.set('return');
  }
  /** Per-item selection respects remaining quantities and the two-request cap. */
  select(line: DemoOrderLine, checked: boolean): void {
    if (checked && (line.returnCount >= 2 || line.availableQuantity < 1)) return;
    this.selections.update((rows) => {
      const next = { ...rows };
      if (checked) next[line.variant_id] = { variantId: line.variant_id, quantity: 1 };
      else delete next[line.variant_id];
      return next;
    });
  }
  /** Quantities stay integers within that line's remaining entitlement. */
  quantity(line: DemoOrderLine, value: number): void {
    const quantity = Math.min(line.availableQuantity, Math.max(1, Math.floor(value || 1)));
    this.selections.update((rows) => ({
      ...rows,
      [line.variant_id]: { ...rows[line.variant_id], variantId: line.variant_id, quantity },
    }));
  }
  /** Store a replacement only for the selected original product. */
  replacement(line: DemoOrderLine, value: string): void {
    this.selections.update((rows) => ({
      ...rows,
      [line.variant_id]: { ...rows[line.variant_id], replacement: value },
    }));
  }
  /** Validate optional image evidence before local preview, without uploading. */
  files(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    if (
      files.length + this.evidence().length > 5 ||
      files.some(
        (file) =>
          !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
          file.size > 5 * 1024 * 1024,
      )
    ) {
      this.error.set('Chọn tối đa 5 ảnh JPG, PNG hoặc WebP, mỗi ảnh không quá 5 MB.');
      input.value = '';
      return;
    }
    this.evidence.update((rows) => [
      ...rows,
      ...files.map((file) => ({ name: file.name, url: URL.createObjectURL(file) })),
    ]);
    this.error.set('');
    input.value = '';
  }
  /** Remove local evidence and revoke its preview URL. */
  removeImage(index: number): void {
    const file = this.evidence()[index];
    if (file) URL.revokeObjectURL(file.url);
    this.evidence.update((rows) => rows.filter((_, i) => i !== index));
  }
  /** Review the old-to-new variants before submitting either branch. */
  reviewReturn(): void {
    if (!this.selectedLines().length) {
      this.error.set('Chọn ít nhất một sản phẩm.');
      return;
    }
    if (this.returnKind === 'exchange' && this.selectedLines().some((line) => !line.replacement)) {
      this.error.set('Chọn size / màu mới cho từng sản phẩm.');
      return;
    }
    this.error.set('');
    this.view.set('return-summary');
  }
  /** Submit one request and show success only after the Model accepts it. */
  submitReturn(): void {
    const order = this.order();
    if (!order || !this.authorized(order) || this.busy()) return;
    this.busy.set(true);
    this.timeout = setTimeout(() => {
      try {
        const request = this.model.createReturn(
          order.id,
          this.returnKind,
          this.selectedLines(),
          this.returnReason,
          this.evidence().map((file) => file.name),
        );
        this.requestId.set(request.id);
        this.error.set('');
        this.view.set('tracking');
      } catch (error) {
        this.error.set((error as Error).message);
        this.view.set('return');
      } finally {
        this.busy.set(false);
      }
    }, 350);
  }
  /** Open a request only from its authorized parent order. */
  track(request: DemoReturn): void {
    const order = this.order();
    if (order && this.authorized(order) && request.orderId === order.id) {
      this.requestId.set(request.id);
      this.view.set('tracking');
    }
  }
  /** Open after-sales from the current customer's request list, checking its parent order. */
  openRequest(request: DemoReturn): void {
    const order = this.model.orders().find((order) => order.id === request.orderId);
    if (!order || !this.authorized(order)) return;
    this.open(order.id, false);
    this.track(request);
  }
  /** Review progression follows the refund or replacement timeline. */
  advance(): void {
    try {
      this.model.advanceRequest(this.requestId());
      this.error.set('');
    } catch (error) {
      this.error.set((error as Error).message);
    }
  }
  /** Ask for recipient details only after COD refund contact; retain only a masked account. */
  saveBank(): void {
    try {
      this.model.saveBank(this.requestId(), this.bankName, this.bankAccount, this.bankHolder);
      this.bankAccount = '';
      this.error.set('');
    } catch (error) {
      this.error.set((error as Error).message);
    }
  }
  /** Recover from an unavailable replacement without creating a second request. */
  changeUnavailable(variantId: string, replacement: string): void {
    try {
      this.model.replaceUnavailable(this.requestId(), variantId, replacement);
      this.error.set('');
    } catch (error) {
      this.error.set((error as Error).message);
    }
  }
  /** Return labels keep order-level and request-level identifiers distinct. */
  lineFor(id: string): DemoOrderLine | undefined {
    return this.order()?.items.find((line) => line.variant_id === id);
  }
  /** Show a proportional estimate; the final refund is confirmed by customer service. */
  refundEstimate(items: DemoReturnLine[]): number {
    const order = this.order();
    if (!order || !order.subtotal) return 0;
    return Math.round(
      items.reduce(
        (sum, item) => sum + (this.lineFor(item.variantId)?.unit_price || 0) * item.quantity,
        0,
      ) *
        (1 - order.discount / order.subtotal),
    );
  }
  /** Human-readable local dates retain their source timestamp in the Model. */
  date(value?: string): string {
    return value ? new Date(value).toLocaleString('vi-VN') : 'Chưa có';
  }
  private authorized(order: DemoOrder): boolean {
    return this.model.canAccess(order) && (this.model.member() || this.verified());
  }
  private clearEvidence(): void {
    this.evidence().forEach((file) => URL.revokeObjectURL(file.url));
    this.evidence.set([]);
  }
}
