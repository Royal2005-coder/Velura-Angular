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
  RETURN_WORKFLOW_LABELS,
  canCancel,
  maskPhone,
  normalizePhone,
  withinReturnWindow,
} from '../../core/services/purchase-demo.store';
import { ORDER_ACCOUNT_MODEL, type ComboComponentItem, type OrderAccountModel, type RefundBankDetails, type ReplacementChoice, type ReturnReasonCode } from '../../core/services/order-account.model';
import { orderAccountErrorMessage } from '../../core/services/order-account-api.store';
import { formatVnd, toPublicAsset } from '../../core/utils/money';
import { formatSizeDisplay } from '../../core/utils/size';
import { isGuestPreview, isPreviewMode } from '../../core/utils/preview-mode';
import { DeliverySimulation } from '../../shared/delivery-simulation/delivery-simulation';
import { CheckoutStore } from '../../core/services/checkout.store';

/**
 * Guest access, order actions and after-sales share one `OrderAccountModel` injection point:
 * `PurchaseDemoStore` (via `OrderAccountPreviewAdapter`) under `?preview=1`, the real
 * `OrderAccountApiStore` otherwise. The view/template below is unaware of which one is live.
 */
@Component({
  selector: 'app-order-flow',
  imports: [FormsModule, RouterLink, DeliverySimulation],
  templateUrl: './order-flow.page.html',
  styleUrls: [
    '../shared/purchase-flow.css',
    '../shared/purchase-flow-forms.css',
    '../shared/purchase-flow-layout.css',
    '../shared/purchase-flow-responsive.css',
  ],
})
export class OrderFlowPage {
  readonly displaySize = formatSizeDisplay;
  readonly preview = isPreviewMode();
  readonly model: OrderAccountModel = inject(ORDER_ACCOUNT_MODEL);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly checkout = inject(CheckoutStore);
  private readonly destroyRef = inject(DestroyRef);
  readonly view = signal<
    | 'lookup'
    | 'otp'
    | 'list'
    | 'cancelled'
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
  readonly maskedEmail = computed(() => this.model.maskedEmail ? this.model.maskedEmail() : '');
  readonly developmentOtp = computed(() => this.model.developmentOtp ? this.model.developmentOtp() : '');
  readonly countdown = computed(() => {
    const minutes = Math.floor(this.seconds() / 60).toString().padStart(2, '0');
    const seconds = (this.seconds() % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  });
  readonly verified = signal(false);
  readonly seconds = signal(60);
  readonly failedOtpAttempts = signal(0);
  readonly cooldown = signal(0);
  readonly busy = signal(false);
  readonly pointRefundWarning = signal(false);
  readonly evidence = signal<Array<{ name: string; url: string; file: File }>>([]);
  readonly labels = ORDER_LABELS;
  readonly money = formatVnd;
  readonly image = (url: string) => toPublicAsset(url, '/assets/images/placeholder.jpg');
  readonly canCancel = (order: DemoOrder) => order.can_cancel ?? canCancel(order);
  readonly withinWindow = (order: DemoOrder) => order.can_request_return ?? withinReturnWindow(order);
  /** CSKH/system refusals read "Bị từ chối"; a customer's own cancellation keeps "Đã hủy yêu cầu". */
  readonly requestLabel = (request: DemoReturn) => request.rejectedAt
    ? 'Bị từ chối'
    : request.status ? RETURN_WORKFLOW_LABELS[request.status] : this.model.timeline(request.kind)[request.stage];
  /** A request that was cancelled by the customer or refused by CSKH has released its return quota. */
  readonly requestEnded = (request: DemoReturn) => !!(request.cancelledAt || request.rejectedAt || request.status === 'CANCELLED');
  readonly requestCanCancel = (request: DemoReturn) => request.status
    ? ['REQUESTED', 'CONTACTING', 'WAITING_RETURN'].includes(request.status)
    : !request.cancelledAt && !request.completedAt && !request.rejectedAt && request.stage < this.model.cancellableBeforeStage;
  readonly orderSteps = computed<DemoOrderStatus[]>(() =>
    this.order()?.payment !== 'COD'
      ? ['pending_payment', 'confirmed', 'preparing', 'shipping', 'delivered']
      : ['pending', 'confirmed', 'preparing', 'shipping', 'delivered'],
  );
  readonly orderStepIndex = computed(() =>
    this.orderSteps().indexOf(this.order()?.status || 'pending'),
  );
  /** Whether the current form must collect a bank destination for a COD refund. */
  requiresRefundBank(): boolean {
    return this.returnKind === 'refund' && this.order()?.payment === 'COD';
  }
  readonly visibleOrders = computed(() =>
    this.model
      .orders()
      .filter(
        (order) =>
          this.authorized(order) &&
          (!this.cancelledEntry || order.status === 'cancelled') &&
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
  readonly cancelledEntry = this.route.snapshot.routeConfig?.path === 'account/cancelled-orders';
  /** A phone challenge retrieves all owned orders; a code challenge verifies the same owner. */
  mode: 'phone' | 'code' = 'phone';
  query = '';
  contact = '';
  otp = '';
  reason = 'Tôi muốn thay đổi sản phẩm';
  otherReason = '';
  returnKind: DemoReturn['kind'] = 'refund';
  returnReason = '';
  returnReasonCode: ReturnReasonCode | '' = '';
  bankName = '';
  bankAccount = '';
  bankHolder = '';
  /** Lets the customer replace an already valid receiving account via "Cập nhật". */
  readonly receiverFormOpen = signal(false);
  private challengePhone = '';
  private challengeOrderId = '';
  private challengeMode: 'phone' | 'code' = 'phone';
  private timeout: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    effect(() => {
      if (this.model.guestOtpRequired && !this.model.member() && !this.model.verifiedPhone()) {
        this.verified.set(false);
        this.selectedId.set('');
        this.requestId.set('');
        if (this.view() !== 'otp') this.view.set('lookup');
      }
    });
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
      if (this.cancelledEntry) this.view.set('cancelled');
      if (id) this.open(id);
    } else if (isGuestPreview()) {
      this.model.verifiedPhone.set('0901234567');
      this.verified.set(true);
      this.view.set(this.returnsEntry ? 'requests' : 'list');
      if (id) this.open(id);
    } else if (this.model.verifiedPhone() && id) {
      this.verified.set(true);
      this.view.set(this.returnsEntry ? 'requests' : 'list');
      this.open(id);
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
  /**
   * Verify the delivery phone once before loading any production order information.
   */
  lookup(): void {
    if (this.busy()) return;
    this.error.set('');
    this.verified.set(false);
    this.selectedId.set('');
    if (this.model.guestOtpRequired) {
      const value = this.query.trim();
      if (!value) { this.error.set(this.mode === 'phone' ? 'Nhập số điện thoại đặt hàng.' : 'Nhập mã đơn hàng.'); return; }
      this.busy.set(true);
      this.model.sendOtp(value, this.mode).then(() => {
        this.challengePhone = value;
        this.challengeMode = this.mode;
        this.challengeOrderId = this.mode === 'code' ? value : '';
        this.maskedPhone.set(this.model.maskedPhone?.() || (this.mode === 'phone' ? maskPhone(value) : 'số điện thoại đặt hàng'));
        this.seconds.set(this.model.otpExpiresIn?.() || 60);
        this.failedOtpAttempts.set(0);
        this.cooldown.set(60);
        this.otp = '';
        this.view.set('otp');
      }).catch((error) => this.error.set(orderAccountErrorMessage(error))).finally(() => this.busy.set(false));
      return;
    }
    if (this.model.lookupGuest) {
      const code = this.query.trim();
      const contact = this.contact.trim();
      if (!code || !contact) {
        this.error.set('Nhập mã đơn hàng và số điện thoại/email đặt hàng.');
        return;
      }
      this.busy.set(true);
      this.model
        .lookupGuest(code, contact)
        .then(() => {
          this.busy.set(false);
          this.verified.set(true);
          this.error.set('');
          this.view.set(this.returnsEntry ? 'requests' : 'list');
          this.open(code, false);
        })
        .catch((error) => {
          this.busy.set(false);
          this.error.set(orderAccountErrorMessage(error));
        });
      return;
    }
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
    this.model
      .sendOtp(phone)
      .then(() => {
        this.challengePhone = normalizePhone(phone);
        this.challengeOrderId = order?.id || '';
        this.maskedPhone.set(maskPhone(phone));
        this.seconds.set(this.model.otpExpiresIn?.() || 60);
        this.failedOtpAttempts.set(0);
        this.cooldown.set(30);
        this.otp = '';
        this.view.set('otp');
      })
      .catch((error) => this.error.set(orderAccountErrorMessage(error)));
  }
  /** Resend only after the challenge cooldown; display only the masked destination. */
  resend(): void {
    if (this.busy() || this.cooldown() > 0) return;
    this.busy.set(true);
    this.model
      .sendOtp(this.challengePhone, this.challengeMode)
      .then(() => {
        this.seconds.set(this.model.otpExpiresIn?.() || 60);
        this.failedOtpAttempts.set(0);
        this.cooldown.set(60);
        this.otp = '';
        this.error.set('');
      })
      .catch((error) => this.error.set(orderAccountErrorMessage(error)))
      .finally(() => this.busy.set(false));
  }
  /** A valid guest challenge exposes only orders belonging to that phone. */
  verify(): void {
    if (this.busy() || this.seconds() === 0 || this.failedOtpAttempts() >= 5 || !/^\d{6}$/.test(this.otp)) return;
    this.busy.set(true);
    this.model
      .verifyOtp(this.otp)
      .then(() => {
        this.verified.set(true);
        this.error.set('');
        this.view.set(this.returnsEntry ? 'requests' : 'list');
        if (this.challengeOrderId) this.open(this.challengeOrderId);
      })
      .catch((error: unknown) => {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (code === 'SESSION_LOCKED') this.failedOtpAttempts.set(5);
        else if (code === 'INVALID_OTP') this.failedOtpAttempts.update((attempts) => Math.min(5, attempts + 1));
        else if (code === 'EXPIRED_OTP') this.seconds.set(0);
        this.error.set(code === 'SESSION_LOCKED'
          ? 'Bạn đã nhập sai OTP 5 lần. Vui lòng gửi mã mới.'
          : orderAccountErrorMessage(error));
      })
      .finally(() => this.busy.set(false));
  }
  /** Open an authorized order on its canonical detail URL, unless an internal after-sales view owns the URL. */
  open(id: string, updateUrl = true): void {
    const existing = this.model.orders().find((row) => row.id === id || row.orderId === id);
    if (existing) {
      this.openLoaded(existing, id, updateUrl);
      return;
    }
    // Not loaded yet (real mode, direct/cold link) — fetch this one order, then retry.
    if (this.model.ensureOrderLoaded) {
      this.model
        .ensureOrderLoaded(id)
        .then(() => {
          const order = this.model.orders().find((row) => row.id === id || row.orderId === id);
          if (order) this.openLoaded(order, id, updateUrl);
          else this.openUnauthorized();
        })
        .catch(() => this.openUnauthorized());
      return;
    }
    this.openUnauthorized();
  }
  private openLoaded(order: DemoOrder, id: string, updateUrl: boolean): void {
    if (!this.authorized(order)) {
      this.openUnauthorized();
      return;
    }
    this.selectedId.set(order.id);
    this.error.set('');
    this.view.set('detail');
    if (updateUrl) {
      void this.router.navigate([this.model.member() ? '/account/orders' : '/guest/orders', order.id], {
        replaceUrl: true,
        ...(this.preview ? { queryParams: { preview: '1' } } : {}),
      });
    }
  }
  /** Begin cancellation only before preparation, preserving a readable confirmation. */
  startCancel(): void {
    const order = this.order();
    if (order && this.authorized(order) && this.canCancel(order)) {
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
      this.model
        .cancel(order.id, this.reason === 'Khác' ? this.otherReason.trim() : this.reason)
        .then(() => this.error.set(''))
        .catch((error) => this.error.set(orderAccountErrorMessage(error)))
        .finally(() => {
          this.view.set('detail');
          this.busy.set(false);
          if (!this.error()) void this.router.navigateByUrl('/account/cancelled-orders');
        });
    }, 350);
  }
  /** Rebuild checkout from a cancelled order while retaining its delivery and payment choices. */
  buyAgain(order: DemoOrder): void {
    if (order.status !== 'cancelled' || !order.items.length) return;
    this.checkout.prepareReorder({
      orderId: order.orderId || order.id,
      items: order.items.map(({ returnCount: _returnCount, availableQuantity: _availableQuantity, itemId: _itemId, isInProgress: _isInProgress, inProgressCode: _inProgressCode, inProgressStatus: _inProgressStatus, ...line }) => line),
      address: { ...order.address, address: order.address.detail },
      paymentMethod: order.payment,
    });
    void this.router.navigateByUrl(this.model.member() ? '/checkout/user' : '/checkout/guest');
  }
  /** Reviewer-only control, preview Model only — no real order can be fast-forwarded by its own customer. */
  scenario(status: DemoOrderStatus, days = 0): void {
    if (!this.preview) return;
    const order = this.order();
    if (order) this.model.scenario?.(order.id, status, days);
  }
  /** Returns whether an order has at least one item eligible for a new return request. */
  canStartReturn(order: DemoOrder | null | undefined): boolean {
    if (!order || !this.withinWindow(order)) return false;
    const items = order.items || [];
    if (!items.length) return false;
    const activeReq = this.orderActiveReturn(order);
    if (items.length === 1 && activeReq) return false;
    return items.some((line) => !line.isInProgress && (line.returnCount ?? 0) < 2 && (line.availableQuantity ?? 1) > 0);
  }

  /** Finds an active (in-progress) return request for the given order. */
  orderActiveReturn(order: DemoOrder | null | undefined): DemoReturn | null {
    if (!order) return null;
    const activeStatuses = ['REQUESTED', 'CONTACTING', 'WAITING_RETURN', 'RETURN_IN_TRANSIT', 'RECEIVED', 'REFUND_PROCESSING', 'EXCHANGE_PREPARING', 'EXCHANGE_SHIPPING', 'NEEDS_SUPPORT'];
    const req = this.model.requests().find(
      (r) =>
        (r.orderId === order.id || r.orderId === order.orderId) &&
        r.status !== 'CANCELLED' &&
        r.status !== 'REFUNDED' &&
        r.status !== 'COMPLETED' &&
        !r.cancelledAt &&
        !r.rejectedAt &&
        !r.completedAt &&
        (!r.status || activeStatuses.includes(r.status)),
    );
    return req || null;
  }

  /** Computes a summary return status badge for order cards and detail header. */
  orderReturnStatusBadge(order: DemoOrder | null | undefined): { kind: 'in_progress' | 'completed' | 'partial' | 'rejected'; label: string; code?: string } | null {
    if (!order || order.status !== 'delivered') return null;
    const items = order.items || [];
    const inProgLine = items.find((l) => l.isInProgress);
    const activeReq = this.orderActiveReturn(order);
    if (inProgLine || activeReq) {
      const statusKey = activeReq?.status || (inProgLine?.inProgressStatus as keyof typeof RETURN_WORKFLOW_LABELS | undefined);
      const statusText = activeReq
        ? this.requestLabel(activeReq)
        : statusKey && statusKey in RETURN_WORKFLOW_LABELS
          ? RETURN_WORKFLOW_LABELS[statusKey]
          : 'Đang chờ xử lý';
      const code = activeReq?.id || inProgLine?.inProgressCode || '';
      return {
        kind: 'in_progress',
        label: `Đang đổi/trả: ${statusText}`,
        code,
      };
    }
    if (items.length > 0 && items.every((l) => (l.availableQuantity ?? 1) === 0 && (l.returnCount ?? 0) > 0)) {
      return { kind: 'completed', label: 'Đã hoàn tất đổi/trả' };
    }
    const latest = this.model.requests().find((r) => r.orderId === order.id || r.orderId === order.orderId);
    if (latest?.rejectedAt) return { kind: 'rejected', label: 'Yêu cầu đổi/trả bị từ chối', code: latest.id };
    if (items.some((l) => (l.returnCount ?? 0) > 0)) {
      const count = items.filter((l) => (l.returnCount ?? 0) > 0).length;
      return { kind: 'partial', label: `Đã đổi/trả ${count}/${items.length} SP` };
    }
    return null;
  }

  /** Explains why starting a new return request is blocked on a delivered order. */
  returnBlockedReason(order: DemoOrder | null | undefined): string | null {
    if (!order || !this.withinWindow(order)) return null;
    const items = order.items || [];
    if (!items.length || this.canStartReturn(order)) return null;
    const inProg = items.find((l) => l.isInProgress);
    const activeReq = this.orderActiveReturn(order);
    if (inProg || activeReq) {
      const code = activeReq?.id || inProg?.inProgressCode || '';
      const statusKey = activeReq?.status || (inProg?.inProgressStatus as keyof typeof RETURN_WORKFLOW_LABELS | undefined);
      const statusText = activeReq
        ? this.requestLabel(activeReq)
        : statusKey && statusKey in RETURN_WORKFLOW_LABELS
          ? RETURN_WORKFLOW_LABELS[statusKey]
          : 'Đang chờ CSKH xử lý';
      if (items.length === 1) {
        return `Đơn hàng đang trong tiến trình đổi/trả (${code ? '#' + code + ' · ' : ''}${statusText}). Đã khóa tạo yêu cầu trùng lặp.`;
      }
      return `Tất cả sản phẩm trong đơn đang trong tiến trình đổi/trả (${statusText}).`;
    }
    if (items.every((l) => (l.returnCount ?? 0) >= 2)) {
      return 'Đã sử dụng tối đa 2/2 lượt đổi/trả trong 7 ngày cho đơn hàng này.';
    }
    return 'Tất cả sản phẩm trong đơn đã được hoàn trả hoặc đổi mới.';
  }

  /** Returns human-readable status for an item's in-progress return. */
  lineInProgressLabel(line: DemoOrderLine): string {
    const statusKey = line.inProgressStatus as keyof typeof RETURN_WORKFLOW_LABELS | undefined;
    if (statusKey && statusKey in RETURN_WORKFLOW_LABELS) {
      return RETURN_WORKFLOW_LABELS[statusKey];
    }
    return 'Đang chờ CSKH xử lý';
  }

  /** Start a new request; auto-selects the sole item when order has only 1 eligible item. */
  startReturn(): void {
    const order = this.order();
    if (!order || !this.authorized(order) || !this.canStartReturn(order)) return;
    const eligibleLines = order.items.filter((l) => !l.isInProgress && (l.returnCount ?? 0) < 2 && (l.availableQuantity ?? 1) > 0);
    const initialSelections: Record<string, DemoReturnLine> = {};
    if (order.items.length === 1 && eligibleLines.length === 1) {
      const sole = eligibleLines[0];
      initialSelections[sole.variant_id] = {
        variantId: sole.variant_id,
        quantity: sole.is_combo ? sole.availableQuantity : 1,
      };
    }
    this.selections.set(initialSelections);
    this.clearEvidence();
    this.returnReason = '';
    this.returnReasonCode = '';
    this.error.set('');
    this.view.set('return');
    void this.model.loadReplacementChoices?.(order.id);
  }

  /** Per-item selection respects remaining quantities, combo bundle, and the two-request cap. */
  select(line: DemoOrderLine, checked: boolean): void {
    if (checked && (line.isInProgress || line.returnCount >= 2 || line.availableQuantity < 1)) return;
    const order = this.order();
    if (!checked && order && order.items.length === 1) return;
    this.selections.update((rows) => {
      const next = { ...rows };
      if (checked) next[line.variant_id] = { variantId: line.variant_id, quantity: line.is_combo ? line.availableQuantity : 1 };
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

  /** Increments or decrements return quantity within [1, line.availableQuantity]. */
  stepQuantity(line: DemoOrderLine, delta: number): void {
    const current = this.selections()[line.variant_id]?.quantity || 1;
    this.quantity(line, current + delta);
  }
  /** Store a replacement only for the selected original product. */
  replacement(line: DemoOrderLine, value: string): void {
    const choice = this.replacementChoices(line).find((row) => row.id === value);
    this.selections.update((rows) => ({
      ...rows,
      [line.variant_id]: { ...rows[line.variant_id], replacement: choice?.label || '', replacementVariantId: this.model.replacementChoices ? choice?.id : undefined },
    }));
  }
  /** Real inventory supplies identities and counts; preview fixtures supply isolated labels only. */
  replacementChoices(line: DemoOrderLine): ReplacementChoice[] {
    return this.model.replacementChoices?.(line) || this.model.replacements(line).map((label) => ({ id: label, label }));
  }
  /** Combo component list for items in a combo set. */
  comboComponents(line: DemoOrderLine): ComboComponentItem[] {
    return this.model.comboComponents?.(line) || [];
  }
  /** Read current variant selected for a specific item in a combo set. */
  selectedComboVariant(selected: DemoReturnLine, productId: string): string {
    return selected.comboReplacements?.[productId]?.variantId || '';
  }
  /** Update replacement variant for one item within a combo set. */
  comboComponentReplacement(line: DemoOrderLine, comp: ComboComponentItem, variantId: string): void {
    const choice = comp.choices.find((row) => row.id === variantId);
    this.selections.update((rows) => {
      const current = rows[line.variant_id] || { variantId: line.variant_id, quantity: line.availableQuantity };
      const currentCombo = current.comboReplacements ? { ...current.comboReplacements } : {};
      if (choice) {
        currentCombo[comp.productId] = {
          productId: comp.productId,
          productName: comp.name,
          variantId: choice.id,
          variantLabel: choice.label,
        };
      } else {
        delete currentCombo[comp.productId];
      }
      const summaryText = Object.values(currentCombo)
        .map((c) => `${c.productName}: ${c.variantLabel}`)
        .join('; ');

      return {
        ...rows,
        [line.variant_id]: {
          ...current,
          comboReplacements: currentCombo,
          replacement: summaryText,
          replacementVariantId: undefined,
        },
      };
    });
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
      ...files.map((file) => ({ name: file.name, url: URL.createObjectURL(file), file })),
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
      this.error.set('Vui lòng chọn ít nhất một sản phẩm cần đổi/trả.');
      return;
    }
    const order = this.order();
    for (const selected of this.selectedLines()) {
      const line = order?.items.find((item) => item.variant_id === selected.variantId);
      if (line?.isInProgress) {
        this.error.set(`Sản phẩm "${line.product_name}" đang có yêu cầu đổi/trả đang xử lý. Vui lòng chờ hoàn tất.`);
        return;
      }
      if (this.returnKind === 'refund' && line?.is_combo && selected.quantity < line.quantity) {
        this.error.set(`Sản phẩm Combo "${line.product_name}" phải hoàn trả nguyên bộ, không tách lẻ số lượng.`);
        return;
      }
    }
    if (this.returnKind === 'exchange') {
      for (const selected of this.selectedLines()) {
        const line = this.lineFor(selected.variantId);
        if (line?.is_combo) {
          const comps = this.comboComponents(line);
          const comboReplacements = selected.comboReplacements || {};
          const selectedCount = Object.keys(comboReplacements).length;
          if (comps.length > 0 && selectedCount === 0) {
            this.error.set(`Vui lòng chọn size / màu mới cho ít nhất một món trong combo "${line.product_name}".`);
            return;
          }
        } else {
          if (!selected.replacement && !selected.replacementVariantId) {
            this.error.set(`Vui lòng chọn size / màu mới cho sản phẩm "${line?.product_name || 'cần đổi'}".`);
            return;
          }
        }
      }
    }
    if (this.requiresRefundBank() && (!this.bankName.trim() || !this.bankHolder.trim() || !/^\d{6,20}$/.test(this.bankAccount.trim()))) {
      this.error.set('Vui lòng nhập ngân hàng, số tài khoản từ 6–20 chữ số và tên chủ tài khoản cho đơn COD.');
      return;
    }
    if (this.returnKind === 'refund' && this.model.member() && !this.pointRefundWarning()) {
      this.pointRefundWarning.set(true);
      return;
    }
    this.error.set('');
    this.view.set('return-summary');
  }
  /** Estimate the points tied to the merchandise selected for refund. */
  refundPointEstimate(): number {
    return Math.floor(this.refundEstimate(this.selectedLines()) / 1000);
  }
  /** Continue after the member acknowledges the possible point clawback. */
  continueAfterPointWarning(): void {
    this.pointRefundWarning.set(false);
    this.error.set('');
    this.view.set('return-summary');
  }
  /** Dismiss the point warning and keep editing the return request. */
  dismissPointWarning(): void {
    this.pointRefundWarning.set(false);
  }
  /** Submit one request and show success only after the Model accepts it. */
  submitReturn(): void {
    const order = this.order();
    if (!order || !this.authorized(order) || this.busy()) return;
    this.busy.set(true);
    const bank: RefundBankDetails | undefined = this.requiresRefundBank()
      ? { bankName: this.bankName.trim(), accountNumber: this.bankAccount.trim(), accountHolder: this.bankHolder.trim() }
      : undefined;
    this.timeout = setTimeout(() => {
      this.model
        .createReturn(order.id, this.returnKind, this.selectedLines(), this.returnReason, this.evidence(), this.returnReasonCode || undefined, bank)
        .then((request) => {
          this.requestId.set(request.id);
          this.error.set('');
          this.view.set('tracking');
        })
        .catch((error) => {
          this.error.set(orderAccountErrorMessage(error));
          this.view.set('return');
        })
        .finally(() => this.busy.set(false));
    }, 350);
  }
  /** Open a request only from its authorized parent order. */
  track(request: DemoReturn): void {
    const order = this.order();
    if (order && this.authorized(order) && request.orderId === order.id) {
      this.requestId.set(request.id);
      this.receiverFormOpen.set(false);
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
  /** Self-service cancel of the active request; blocked once the Model reports it shipped. */
  cancelRequest(): void {
    this.model
      .cancelRequest(this.requestId())
      .then(() => this.error.set(''))
      .catch((error) => this.error.set(orderAccountErrorMessage(error)));
  }
  /** Whether this refund goes back through a COD manual transfer that needs the customer's receiving account. */
  private isCodRefund(request: DemoReturn): boolean {
    if (request.kind !== 'refund') return false;
    return request.paymentMethod ? request.paymentMethod === 'COD' : this.order()?.payment === 'COD';
  }
  private receiverEditable(request: DemoReturn): boolean {
    return this.model.supportsBankInfo && this.isCodRefund(request) && !this.requestEnded(request)
      && !request.completedAt && request.status !== 'REFUNDED' && request.status !== 'COMPLETED';
  }
  /** The receiving account is still missing, invalid or requested again by CSKH, so the refund stage is blocked. */
  needsReceiverInfo(request: DemoReturn): boolean {
    if (!this.receiverEditable(request)) return false;
    const receiver = request.refundReceiver;
    if (!receiver) return !request.bank && request.stage >= 1;
    if (receiver.status === 'valid' || receiver.status === 'not_required') return false;
    return request.stage >= 1 || !!receiver.supplementRequest;
  }
  /** The valid receiving account to echo back to the customer (server shape first, legacy demo `bank` second). */
  receiverSummary(request: DemoReturn): { name: string; last4: string; holder: string } | null {
    if (!this.isCodRefund(request)) return null;
    const receiver = request.refundReceiver;
    if (receiver) {
      return receiver.status === 'valid' && receiver.bankName && receiver.accountLast4
        ? { name: receiver.bankName, last4: receiver.accountLast4, holder: receiver.holder || '' }
        : null;
    }
    return request.bank ? { ...request.bank } : null;
  }
  /** "Cập nhật" is offered only while the money has not been transferred yet. */
  canEditReceiver(request: DemoReturn): boolean {
    return this.receiverEditable(request) && this.receiverSummary(request) !== null;
  }
  /** The form is shown when info is required, or when the customer chose to update a valid account. */
  showReceiverForm(request: DemoReturn): boolean {
    return this.needsReceiverInfo(request) || (this.receiverFormOpen() && this.canEditReceiver(request));
  }
  /** Pre-fills the non-sensitive fields; the full account number is never returned, so it is retyped. */
  editReceiver(request: DemoReturn): void {
    const summary = this.receiverSummary(request);
    this.bankName = summary?.name || '';
    this.bankHolder = summary?.holder || '';
    this.bankAccount = '';
    this.receiverFormOpen.set(true);
  }
  /** Ask for recipient details only after COD refund contact; retain only a masked account. */
  saveBank(): void {
    this.model
      .saveBank(this.requestId(), this.bankName, this.bankAccount, this.bankHolder)
      .then(() => {
        this.bankAccount = '';
        this.receiverFormOpen.set(false);
        this.error.set('');
      })
      .catch((error) => this.error.set(orderAccountErrorMessage(error)));
  }
  /** Reviewer-only control, preview Model only — switches a stuck exchange to a refund. */
  acceptRefundFallback(id: string): void {
    this.model.replacementConflict?.(id, true);
  }
  /** Recover from an unavailable replacement without creating a second request. */
  changeUnavailable(variantId: string, replacement: string): void {
    this.model
      .replaceUnavailable(this.requestId(), variantId, replacement)
      .then(() => this.error.set(''))
      .catch((error) => this.error.set(orderAccountErrorMessage(error)));
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
  private openUnauthorized(): void {
    this.error.set('Vui lòng xác thực chủ đơn trước khi xem chi tiết.');
    this.view.set(this.model.member() ? 'list' : 'lookup');
  }
  private clearEvidence(): void {
    this.evidence().forEach((file) => URL.revokeObjectURL(file.url));
    this.evidence.set([]);
  }
}
