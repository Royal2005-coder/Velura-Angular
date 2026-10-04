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
import { ORDER_ACCOUNT_MODEL, type ComboComponentItem, type OrderAccountModel, type ReplacementChoice, type ReturnReasonCode } from '../../core/services/order-account.model';
import { orderAccountErrorMessage } from '../../core/services/order-account-api.store';
import { formatVnd, toPublicAsset } from '../../core/utils/money';
import { isGuestPreview, isPreviewMode } from '../../core/utils/preview-mode';
import { DeliverySimulation } from '../../shared/delivery-simulation/delivery-simulation';

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
  readonly preview = isPreviewMode();
  readonly model: OrderAccountModel = inject(ORDER_ACCOUNT_MODEL);
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
  readonly evidence = signal<Array<{ name: string; url: string; file: File }>>([]);
  readonly labels = ORDER_LABELS;
  readonly money = formatVnd;
  readonly image = (url: string) => toPublicAsset(url, '/assets/images/placeholder.jpg');
  readonly canCancel = (order: DemoOrder) => order.can_cancel ?? canCancel(order);
  readonly withinWindow = (order: DemoOrder) => order.can_request_return ?? withinReturnWindow(order);
  readonly requestLabel = (request: DemoReturn) => request.status ? RETURN_WORKFLOW_LABELS[request.status] : this.model.timeline(request.kind)[request.stage];
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
        this.maskedPhone.set(this.mode === 'phone' ? maskPhone(value) : 'số điện thoại đặt hàng');
        this.seconds.set(300);
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
        this.seconds.set(300);
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
        this.seconds.set(300);
        this.cooldown.set(60);
        this.otp = '';
        this.error.set('');
      })
      .catch((error) => this.error.set(orderAccountErrorMessage(error)))
      .finally(() => this.busy.set(false));
  }
  /** A valid guest challenge exposes only orders belonging to that phone. */
  verify(): void {
    if (this.busy() || this.seconds() === 0 || !/^\d{6}$/.test(this.otp)) return;
    this.busy.set(true);
    this.model
      .verifyOtp(this.otp)
      .then(() => {
        this.verified.set(true);
        this.error.set('');
        this.view.set(this.returnsEntry ? 'requests' : 'list');
        if (this.challengeOrderId) this.open(this.challengeOrderId);
      })
      .catch((error) => this.error.set(orderAccountErrorMessage(error)))
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
        });
    }, 350);
  }
  /** Reviewer-only control, preview Model only — no real order can be fast-forwarded by its own customer. */
  scenario(status: DemoOrderStatus, days = 0): void {
    if (!this.preview) return;
    const order = this.order();
    if (order) this.model.scenario?.(order.id, status, days);
  }
  /** Start a new request with no previous selections or evidence. */
  startReturn(): void {
    const order = this.order();
    if (!order || !this.authorized(order) || !this.withinWindow(order)) return;
    this.selections.set({});
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
    this.error.set('');
    this.view.set('return-summary');
  }
  /** Submit one request and show success only after the Model accepts it. */
  submitReturn(): void {
    const order = this.order();
    if (!order || !this.authorized(order) || this.busy()) return;
    this.busy.set(true);
    this.timeout = setTimeout(() => {
      this.model
        .createReturn(order.id, this.returnKind, this.selectedLines(), this.returnReason, this.evidence(), this.returnReasonCode || undefined)
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
  /** Ask for recipient details only after COD refund contact; retain only a masked account. */
  saveBank(): void {
    this.model
      .saveBank(this.requestId(), this.bankName, this.bankAccount, this.bankHolder)
      .then(() => {
        this.bankAccount = '';
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
