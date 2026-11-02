import { Observable, forkJoin, of, switchMap } from 'rxjs';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { AdminErpApiService, AdminOrderRow, AdminReturnDisposition, AdminReturnItemAction, AdminReturnItemActionInput, AdminReturnLine, AdminReturnReplacementChoice, AdminReturnRow } from '../../core/admin-erp-api.service';
import { CONTACT_RESULTS, MIN_NOTE_LENGTH, MIN_TRANSFER_REFERENCE_LENGTH, gatewayNote, itemRefundAllowed, refundReceiverBlocked, returnItemActions } from '../../core/admin-erp-service-desk';
import { adminErrorMessage } from '../../core/admin-erp-http';
import { adminMoney } from '../../core/admin-erp-format';
import { buildReturnQrPayload, demoShipmentFacts, parseScan } from '../../core/admin-erp-qr';
import { AdminErpModal } from '../../shared/ui/admin-modal';
import { AdminErpQrScan } from '../../shared/ui/admin-qr-scan';

/** Request-level contact is independent; all business and money actions target one item part. */
export type ReturnFlowKind = AdminReturnItemAction | 'contact' | 'refund-info' | 'manual' | 'stripe' | null;

/** Operator labels shared by the drawer and its versioned item form. */
export const RETURN_ITEM_ACTION_LABELS: Readonly<Record<Exclude<ReturnFlowKind, null>, string>> = {
  approve: 'Duyệt phần hàng', reject: 'Từ chối phần hàng', wait_return: 'Chờ khách gửi hàng',
  pickup: 'Xác nhận lấy hàng', receive: 'Kho nhận & kiểm hàng', needs_support: 'Cần hỗ trợ',
  resolve: 'Tiếp tục sau hỗ trợ', stop: 'Dừng phần hàng', convert_refund: 'Chuyển phần này sang hoàn tiền',
  change_variant: 'Đổi biến thể thay thế', prepare_exchange: 'Chuẩn bị đơn đổi',
  ship_exchange: 'Giao phần hàng đổi', complete_exchange: 'Xác nhận giao hàng đổi thành công',
  contact: 'Ghi nhận liên hệ khách', 'refund-info': 'Yêu cầu bổ sung tài khoản',
  manual: 'Đối soát chuyển khoản COD', stripe: 'Hoàn phần này qua Stripe',
};

/** One quantity part is saved at a time; refresh exposes any transactionally split remainder. */
@Component({
  selector: 'app-erp-return-flow', imports: [AdminErpModal, AdminErpQrScan],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './return-flow.component.html', styleUrl: './return-flow.component.scss',
})
export class ReturnFlowComponent {
  private readonly api = inject(AdminErpApiService);
  readonly flow = input<ReturnFlowKind>(null);
  readonly record = input<AdminReturnRow | null>(null);
  readonly line = input<AdminReturnLine | null>(null);
  readonly order = input<AdminOrderRow | null>(null);
  readonly canApprove = input(false);
  readonly canOperate = input(false);
  readonly canFinance = input(false);
  /** Tracking supplied by the carrier-demo scan; the operator can still correct it. */
  readonly presetTracking = input('');
  readonly done = output<string>();
  readonly dismissed = output<void>();
  readonly quantity = signal(1);
  readonly note = signal('');
  readonly contactResult = signal('reached');
  readonly customerConsent = signal(false);
  readonly replacementVariantId = signal('');
  readonly variantChoices = signal<AdminReturnReplacementChoice[]>([]);
  readonly loadingVariants = signal(false);
  readonly selectedVariantChoice = computed(() =>
    this.variantChoices().find((c) => c.variant_id === this.replacementVariantId()) || null,
  );
  readonly tracking = signal('');
  readonly carrier = signal('GHN');
  readonly receivedQuantity = signal(1);
  readonly matchesProduct = signal(true);
  readonly tagsIntact = signal(true);
  readonly conditionAcceptable = signal(true);
  readonly packageMatch = signal(true);
  readonly sealIntact = signal(true);
  /** Optional: only an explicit choice is sent; `restock` is never assumed because it moves sellable stock. */
  readonly disposition = signal<AdminReturnDisposition | ''>('');
  readonly proofFile = signal<File | null>(null);
  readonly pickupPhotos = signal<File[]>([]);
  readonly pickupVideo = signal<File | null>(null);
  readonly pickedUpBy = signal('');
  readonly pickedUpAt = signal('');
  readonly transferReference = signal('');
  readonly transferredAt = signal('');
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly scanOpen = signal(false);
  readonly scanError = signal<string | null>(null);
  readonly contactResults = CONTACT_RESULTS;
  readonly minNote = MIN_NOTE_LENGTH;
  readonly title = computed(() => this.flow() ? RETURN_ITEM_ACTION_LABELS[this.flow()!] : '');
  /** Approval covers the whole part the customer asked for, so quantity is never edited here. */
  readonly showQuantityEditor = computed(() => false);
  readonly customerPhone = computed(() => (this.record()?.customer_phone || '').replace(/[^\d+]/g, ''));
  /** Packing media is encouraged, never a precondition: this only nudges the operator to ask on the call. */
  readonly noCustomerEvidence = computed(() => this.flow() === 'approve'
    && !this.record()?.evidence_images?.length && !this.record()?.evidence_videos?.length);
  readonly needsConsent = computed(() => this.flow() === 'convert_refund' || this.flow() === 'change_variant');
  readonly needsReason = computed(() => ['approve', 'reject', 'needs_support', 'resolve', 'stop', 'convert_refund', 'change_variant', 'contact', 'refund-info'].includes(String(this.flow())));
  readonly isMoney = computed(() => this.flow() === 'manual' || this.flow() === 'stripe');
  readonly refundable = computed(() => Number(this.line()?.refundable_amount || 0));
  /** Receive never splits by `quantity`: a smaller `receivedQuantity` releases the missing remainder on the server. */
  readonly canSplit = computed(() => !this.isMoney() && !['contact', 'refund-info', 'ship_exchange', 'complete_exchange', 'receive'].includes(String(this.flow())) && !this.line()?.exchange_order_id);
  /** Units the customer registered for this part; the warehouse may confirm any number from 1 up to this. */
  readonly registeredQuantity = computed(() => Number(this.line()?.quantity || 0));
  readonly isPartialReceipt = computed(() => this.flow() === 'receive' && this.receivedQuantity() < this.registeredQuantity());
  readonly canSubmit = computed(() => {
    const flow = this.flow();
    const record = this.record();
    const line = this.line();
    if (!flow || !record || this.saving() || !this.canOperate()) return false;
    if (this.needsReason() && this.note().trim().length < MIN_NOTE_LENGTH) return false;
    if (flow === 'contact' || flow === 'refund-info') return record.version != null;
    if (!line?.return_item_id || line.version == null) return false;
    if (!Number.isInteger(this.quantity()) || this.quantity() < 1 || this.quantity() > Number(line.quantity)) return false;
    if (this.isMoney()) {
      if (!this.canFinance() || !itemRefundAllowed(line) || this.refundable() <= 0) return false;
      if (flow === 'stripe') return record.payment_kind === 'stripe';
      return record.payment_kind === 'cod' && !refundReceiverBlocked(record)
        && this.transferReference().trim().length >= MIN_TRANSFER_REFERENCE_LENGTH
        && Boolean(this.proofFile()) && Number.isFinite(Date.parse(this.transferredAt()))
        && Date.parse(this.transferredAt()) <= Date.now();
    }
    if (!returnItemActions(line, this.canApprove()).includes(flow as AdminReturnItemAction)) return false;
    if (this.needsConsent() && !this.customerConsent()) return false;
    if (flow === 'change_variant') {
      if (!this.replacementVariantId().trim()) return false;
      const chosen = this.selectedVariantChoice();
      if (chosen && (chosen.available_stock ?? 0) < this.quantity()) return false;
    }
    // BA AD_RECEIVE_01: item + actual quantity only; photo, checklist and disposition are optional.
    if (flow === 'receive') return Number.isInteger(this.receivedQuantity())
      && this.receivedQuantity() >= 1 && this.receivedQuantity() <= this.registeredQuantity();
    if (flow === 'pickup') return this.pickupPhotos().length > 0 && Boolean(this.tracking().trim()) && Boolean(this.carrier().trim())
      && this.pickedUpBy().trim().length >= 2 && Number.isFinite(Date.parse(this.pickedUpAt())) && Date.parse(this.pickedUpAt()) <= Date.now();
    if (flow === 'ship_exchange') return Boolean(this.tracking().trim()) && Boolean(this.carrier().trim());
    return true;
  });

  constructor() {
    effect(() => {
      const flow = this.flow();
      const line = this.line();
      if (!flow) return;
      this.note.set(''); this.error.set(null); this.quantity.set(Number(line?.quantity || 1));
      this.receivedQuantity.set(Number(line?.quantity || 1)); this.customerConsent.set(false);
      this.replacementVariantId.set(line?.replacement_variant_id || '');
      if (flow === 'change_variant' && line) {
        // Variant selection writes replacementVariantId; tracking it here would retrigger this effect forever.
        untracked(() => this.loadVariantChoices(line, this.order()));
      } else {
        this.variantChoices.set([]);
      }
      this.matchesProduct.set(true); this.tagsIntact.set(true); this.conditionAcceptable.set(true);
      this.packageMatch.set(true); this.sealIntact.set(true); this.disposition.set('');
      const isManual = flow === 'manual';
      const autoRef = isManual ? this.newTransferRef() : '';
      if (isManual) { this.createDigitalReceiptFile(autoRef).then((f) => this.proofFile.set(f)); } else { this.proofFile.set(null); }
      this.pickupPhotos.set([]); this.pickupVideo.set(null);
      this.transferReference.set(autoRef);
      this.note.set(isManual ? 'Đã đối soát & tự động chi hộ Napas B2C khớp mã giao dịch.' : '');
      this.tracking.set(flow === 'ship_exchange' ? this.newExchangeTracking() : flow === 'pickup' ? this.presetTracking() : '');
      this.carrier.set('GHN'); this.contactResult.set('reached');
      const date = new Date(); date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
      this.transferredAt.set(date.toISOString().slice(0, 16));
      this.pickedUpBy.set(''); this.pickedUpAt.set(date.toISOString().slice(0, 16));
    });
  }

  /** A fresh outbound AWB; the database still rewrites collisions and persists this on the sub-order. */
  private newExchangeTracking(): string {
    const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 18);
    return 'EXC' + random.toUpperCase();
  }
  /** Pre-defined automated scenarios after calling customer so operator never types boilerplate. */
  readonly contactScenarios: ReadonlyArray<{ code: string; label: string; result: string; note: string }> = [
    {
      code: 'agree_exchange',
      label: 'Khách đồng ý đổi mẫu/size',
      result: 'reached',
      note: 'Đã gọi xác nhận: Khách đồng ý đổi sang sản phẩm/size phù hợp theo phương án CSKH đã tư vấn.'
    },
    {
      code: 'agree_refund',
      label: 'Khách chuyển sang hoàn tiền',
      result: 'reached',
      note: 'Đã gọi xác nhận: Khách yêu cầu chuyển phương án sang hoàn tiền.'
    },
    {
      code: 'pickup_tomorrow',
      label: 'Hẹn ĐVVC lấy hàng ngày mai',
      result: 'reached',
      note: 'Đã gọi xác nhận: Khách hẹn ĐVVC đến lấy kiện hàng đóng gói vào ngày mai.'
    },
    {
      code: 'no_answer_retry',
      label: 'Khách không nghe máy (hẹn gọi lại)',
      result: 'no_answer',
      note: 'Đã gọi nhưng khách không bắt máy. CSKH đã gửi tin nhắn thông báo và sẽ gọi lại trong 24h.'
    },
    {
      code: 'wait_evidence',
      label: 'Chờ khách bổ sung thêm ảnh/video',
      result: 'waiting_customer',
      note: 'Đã trao đổi: Khách cần thời gian kiểm tra và đồng ý bổ sung thêm hình ảnh/video đóng gói.'
    }
  ];

  applyScenario(scenario: { result: string; note: string }): void {
    this.contactResult.set(scenario.result);
    this.note.set(scenario.note);
  }

  /** Pre-defined automated notes for all item actions so operator never types boilerplate manually. */
  readonly quickNotes = computed(() => {
    const f = this.flow();
    if (f === 'stripe') {
      return [
        'Đã hoàn tiền tự động cho khách qua cổng Stripe',
        'Kho kiểm hàng đạt chuẩn, hoàn trả đủ số tiền',
        'Đã đối soát thông tin và xác nhận hoàn tiền qua thẻ'
      ];
    }
    if (f === 'manual') {
      return [
        'Đã đối soát & tự động chi hộ Napas B2C khớp mã giao dịch',
        'Đã nhận hàng đủ điều kiện & hoàn tất chi trả COD',
        'Hàng nguyên tem mác - chi trả hoàn tất theo STK khách hàng',
        'Sai màu sắc/kích cỡ - khách đổi ý - đối soát tự động thành công'
      ];
    }
    if (f === 'approve') {
      return [
        'Đã gọi điện xác nhận và duyệt yêu cầu đổi trả của khách',
        'Khách đã cung cấp thông tin, đồng ý phương án xử lý',
        'Duyệt yêu cầu đổi trả theo đúng số lượng đăng ký'
      ];
    }
    if (f === 'receive') {
      return [
        'Kho đã nhận kiện hàng, kiểm tra sản phẩm nguyên vẹn',
        'Sản phẩm còn nguyên tem mác, đủ điều kiện nhập kho',
        'Kiện hàng niêm phong đầy đủ khi bốc dỡ tại kho'
      ];
    }
    if (f === 'change_variant') {
      return [
        'Khách đồng ý đổi sang mẫu/size mới',
        'Đã chốt biến thể thay thế theo yêu cầu của khách'
      ];
    }
    if (f === 'stop' && this.line()?.item_status === 'RETURN_SHIPPING') {
      return [
        'Khách báo không gửi tiếp kiện hàng, CSKH đã xác nhận qua điện thoại',
        'Khách không còn nhu cầu đổi/trả sau khi đã bàn giao cho ĐVVC'
      ];
    }
    if (f === 'stop' || f === 'reject') {
      return [
        'Sản phẩm không đủ điều kiện đổi trả theo chính sách',
        'Khách hàng chủ động hủy yêu cầu sau khi được tư vấn'
      ];
    }
    return [
      'Đã liên hệ xác nhận thông tin với khách hàng',
      'Đã hoàn tất xử lý theo quy trình vận hành'
    ];
  });

  setNoteQuick(text: string): void {
    this.note.set(text);
  }

  newTransferRef(): string {
    return 'PAY-COD-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
  }

  generateTransferRef(): void {
    this.transferReference.set(this.newTransferRef());
  }

  createDigitalReceiptFile(refCode?: string): File {
    const reference = refCode || this.transferReference() || this.newTransferRef();
    const amount = this.refundable();
    const dateStr = new Date().toLocaleString('vi-VN');
    const receiver = this.record()?.refund_receiver;
    const bankName = receiver?.bank_name || 'Ngân hàng thụ hưởng';
    const accountLast4 = receiver?.account_last4 || (receiver?.account_number ? receiver.account_number.slice(-4) : '****');
    const holder = receiver?.account_holder || this.record()?.customer_name || 'Khách hàng';

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="380" viewBox="0 0 600 380">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#7A283C" />
          <stop offset="100%" stop-color="#4A1523" />
        </linearGradient>
      </defs>
      <rect width="600" height="380" rx="16" fill="#FFFFFF" stroke="#EAD7DD" stroke-width="2" />
      <rect width="600" height="70" rx="16" fill="url(#g)" />
      <rect y="54" width="600" height="16" fill="url(#g)" />
      <text x="32" y="44" font-family="sans-serif" font-size="20" font-weight="bold" fill="#FFFFFF">VELURA — BIÊN LAI ĐỐI SOÁT CHI HỘ COD</text>
      <text x="32" y="110" font-family="sans-serif" font-size="14" fill="#6B635D">MÃ ĐỐI SOÁT:</text>
      <text x="200" y="110" font-family="monospace" font-size="16" font-weight="bold" fill="#18181B">${reference}</text>
      <text x="32" y="150" font-family="sans-serif" font-size="14" fill="#6B635D">SỐ TIỀN HOÀN:</text>
      <text x="200" y="150" font-family="sans-serif" font-size="18" font-weight="bold" fill="#7A283C">${amount.toLocaleString('vi-VN')} đ</text>
      <text x="32" y="190" font-family="sans-serif" font-size="14" fill="#6B635D">NGÂN HÀNG:</text>
      <text x="200" y="190" font-family="sans-serif" font-size="14" font-weight="bold" fill="#18181B">${bankName}</text>
      <text x="32" y="230" font-family="sans-serif" font-size="14" fill="#6B635D">SỐ TÀI KHOẢN:</text>
      <text x="200" y="230" font-family="monospace" font-size="14" font-weight="bold" fill="#18181B">••••${accountLast4}</text>
      <text x="32" y="270" font-family="sans-serif" font-size="14" fill="#6B635D">CHỦ TÀI KHOẢN:</text>
      <text x="200" y="270" font-family="sans-serif" font-size="14" font-weight="bold" fill="#18181B">${holder.toUpperCase()}</text>
      <text x="32" y="310" font-family="sans-serif" font-size="14" fill="#6B635D">THỜI ĐIỂM:</text>
      <text x="200" y="310" font-family="sans-serif" font-size="14" fill="#18181B">${dateStr}</text>
      <line x1="32" y1="335" x2="568" y2="335" stroke="#EAD7DD" stroke-width="1" />
      <text x="32" y="360" font-family="sans-serif" font-size="12" fill="#047857">✔ ĐÃ ĐỐI SOÁT &amp; XÁC NHẬN CHI HỘ QUA CỔNG NGÂN HÀNG (NAPAS B2C)</text>
    </svg>`;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    return new File([blob], `bien-lai-chi-ho-${reference}.svg`, { type: 'image/svg+xml' });
  }

  runAutoPayout(): void {
    const receiver = this.record()?.refund_receiver;
    const bankName = receiver?.bank_name || 'Ngân hàng thụ hưởng';
    const last4 = receiver?.account_last4 ? `••••${receiver.account_last4}` : '';
    const ref = this.newTransferRef();
    this.transferReference.set(ref);
    const date = new Date();
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    this.transferredAt.set(date.toISOString().slice(0, 16));
    this.proofFile.set(this.createDigitalReceiptFile(ref));
    this.note.set(`Hệ thống đã tự động chi hộ qua cổng ngân hàng (Napas B2C) tới ${bankName} ${last4}. Mã đối soát: ${ref}. Giao dịch thành công.`);
  }

  /** Facts the operator confirms on the call; each one is written into the stored contact note. */
  readonly contactFacts: ReadonlyArray<{ code: string; label: string }> = [
    { code: 'identity', label: 'Đã xác nhận đúng khách' },
    { code: 'request', label: 'Xác nhận yêu cầu đổi trả' },
    { code: 'variant', label: 'Sản phẩm/size/màu đổi' },
    { code: 'pickup', label: 'Thời gian lấy hàng' },
    { code: 'packing', label: 'Nhắc khách quay ảnh & video đóng gói' },
    { code: 'points', label: 'Khách hiểu quy tắc hoàn/ghi điểm' },
  ];

  appendFact(label: string): void {
    const note = this.note();
    if (note.includes(label)) return;
    this.note.set((note.trim() ? note.trim() + ' ' : '') + label + '.');
  }

  /** Stores ordinary text without silently coercing malformed quantities into valid ones. */
  setText(field: 'note' | 'replacementVariantId' | 'tracking' | 'carrier' | 'transferReference' | 'transferredAt' | 'contactResult' | 'pickedUpBy' | 'pickedUpAt', event: Event): void {
    this[field].set((event.target as HTMLInputElement).value);
  }

  /** Processing fewer units creates an independent remainder on the server. */
  setQuantity(event: Event): void {
    const quantity = Number((event.target as HTMLInputElement).value);
    this.quantity.set(quantity);
    if (this.flow() === 'change_variant') this.initSelectedVariant();
  }

  /** Units the warehouse actually counted; fewer than registered releases the missing remainder to CSKH. */
  setReceivedQuantity(event: Event): void {
    this.receivedQuantity.set(Number((event.target as HTMLInputElement).value));
  }

  private loadVariantChoices(line: AdminReturnLine, order: AdminOrderRow | null): void {
    if (line.replacement_choices?.length) {
      this.variantChoices.set(line.replacement_choices.map((c) => ({
        ...c,
        available_stock: c.available_stock ?? Math.max(0, (c.stock_quantity ?? 0) - (c.reserved_quantity ?? 0)),
      })));
      this.initSelectedVariant();
      return;
    }
    const productId = line.product_id
      || order?.items?.find((i) => i.item_id === line.order_item_id || i.order_item_id === line.order_item_id)?.product_id;
    if (productId) {
      this.loadingVariants.set(true);
      this.api.listVariants(productId).subscribe({
        next: (payload) => {
          this.loadingVariants.set(false);
          const choices: AdminReturnReplacementChoice[] = (payload.rows || []).map((v) => ({
            variant_id: v.variant_id,
            sku: v.sku,
            color: v.color,
            size: v.size,
            stock_quantity: v.stock_quantity,
            reserved_quantity: v.reserved_quantity,
            available_stock: Math.max(0, (v.stock_quantity ?? 0) - (v.reserved_quantity ?? 0)),
            is_current: v.variant_id === line.current_variant_id || v.variant_id === line.variant_id,
          }));
          this.variantChoices.set(choices);
          this.initSelectedVariant();
        },
        error: () => {
          this.loadingVariants.set(false);
        },
      });
      return;
    }
    this.variantChoices.set([]);
  }

  private initSelectedVariant(): void {
    const choices = this.variantChoices();
    const current = this.replacementVariantId();
    if (current && choices.some((c) => c.variant_id === current)) return;
    const target = this.line()?.replacement_variant_id;
    if (target && choices.some((c) => c.variant_id === target)) {
      this.replacementVariantId.set(target);
      return;
    }
    const available = choices.find((c) => (c.available_stock ?? 0) >= this.quantity()) || choices[0];
    if (available) {
      this.replacementVariantId.set(available.variant_id);
    }
  }

  /** QA facts are recorded even when tags, condition or seal are not intact. */
  setCheck(field: 'customerConsent' | 'matchesProduct' | 'tagsIntact' | 'conditionAcceptable' | 'packageMatch' | 'sealIntact', event: Event): void {
    this[field].set((event.target as HTMLInputElement).checked);
  }

  /** Only explicit disposition controls sellable restock; the server enforces QA consistency. */
  setDisposition(event: Event): void {
    this.disposition.set((event.target as HTMLSelectElement).value as AdminReturnDisposition | '');
  }

  /** Evidence uses the existing authenticated private-upload boundary, never a typed URL. */
  pickFile(kind: 'proof' | 'photos' | 'video', event: Event): void {
    const picker = event.target as HTMLInputElement;
    const files = Array.from(picker.files || []);
    picker.value = '';
    if (kind === 'photos') this.pickupPhotos.set(files.filter((file) => file.type.startsWith('image/')).slice(0, 8));
    else if (kind === 'video') this.pickupVideo.set(files.find((file) => ['video/mp4', 'video/webm'].includes(file.type) && file.size <= 50 * 1024 * 1024) || null);
    else this.proofFile.set(files.find((file) => file.type.startsWith('image/')) || null);
  }

  /** Uploads evidence then submits one item version; success forces the parent to reread all parts. */
  submit(): void {
    const record = this.record();
    const flow = this.flow();
    if (!record || !flow || !this.canSubmit()) return;
    this.saving.set(true); this.error.set(null);
    this.buildRequest(record, flow).subscribe({
      next: (message) => { this.saving.set(false); this.done.emit(message); },
      error: (error: unknown) => { this.saving.set(false); this.error.set(adminErrorMessage(error, 'Không ghi nhận được thao tác. Làm mới hồ sơ nếu phiên bản đã thay đổi.')); },
    });
  }

  private buildRequest(record: AdminReturnRow, flow: Exclude<ReturnFlowKind, null>): Observable<string> {
    const note = this.note().trim();
    if (flow === 'contact') return this.api.recordReturnContact(record.return_id, { result: this.contactResult(), note, expectedVersion: Number(record.version) }).pipe(switchMap(() => of('')));
    if (flow === 'refund-info') return this.api.requestRefundInfo(record.return_id, { message: note, expectedVersion: Number(record.version) }).pipe(switchMap(() => of('')));
    const line = this.line()!;
    const version = Number(line.version);
    const itemId = line.return_item_id!;
    if (flow === 'stripe') return this.api.triggerStripeRefund(record.return_id, { expectedVersion: version, returnItemId: itemId }).pipe(switchMap((result) => of(gatewayNote(result.refund))));
    const proof = this.proofFile();
    const proof$ = proof ? this.api.uploadReturnEvidence(record.return_id, proof, flow === 'manual' ? 'refund_proof' : 'qa_photo', note) : of(null);
    const photos$ = flow === 'pickup' ? forkJoin(this.pickupPhotos().map((file) => this.api.uploadReturnEvidence(record.return_id, file, 'pickup_photo', note))) : of([]);
    const video = this.pickupVideo();
    const video$ = flow === 'pickup' && video ? this.api.uploadReturnEvidence(record.return_id, video, 'pickup_video', note) : of(null);
    return forkJoin({ proof: proof$, photos: photos$, video: video$ }).pipe(switchMap((evidence) => {
      const proofRef = evidence.proof?.storage_ref;
      if (proof && !proofRef) throw new Error('Không lưu được chứng từ riêng tư. Vui lòng chọn lại ảnh.');
      if (flow === 'manual') return this.api.recordManualRefund(record.return_id, {
        returnItemId: itemId, expectedVersion: version, transferReference: this.transferReference().trim(),
        amount: this.refundable(), transferredAt: new Date(this.transferredAt()).toISOString(), imageProof: proofRef!, adminNote: note,
      }).pipe(switchMap(() => of('Đã ghi nhận đối soát phần hàng.')));
      const body: AdminReturnItemActionInput = { action: flow, expectedVersion: version,
        ...(this.canSplit() ? { quantity: this.quantity() } : {}), ...(note ? { reason: note } : {}) };
      if (this.needsConsent()) body.customerConsent = this.customerConsent();
      if (flow === 'change_variant') body.replacementVariantId = this.replacementVariantId().trim();
      if (flow === 'receive') Object.assign(body, {
        receivedQuantity: this.receivedQuantity(), matchesProduct: this.matchesProduct(), tagsIntact: this.tagsIntact(),
        conditionAcceptable: this.conditionAcceptable(), packageMatch: this.packageMatch(), sealIntact: this.sealIntact(),
        ...(this.disposition() ? { disposition: this.disposition() as AdminReturnDisposition } : {}),
        ...(note ? { dispositionNote: note } : {}),
        ...(proofRef ? { receiptProofRef: proofRef } : {}),
      });
      if (flow === 'pickup' || flow === 'ship_exchange') Object.assign(body, { trackingNumber: this.tracking().trim(), carrier: this.carrier().trim() });
      if (flow === 'pickup') {
        const refs = evidence.photos.map((row) => row.storage_ref).filter((ref): ref is string => Boolean(ref));
        if (refs.length !== this.pickupPhotos().length) throw new Error('Chưa lưu đủ ảnh bàn giao.');
        body.photoUrls = refs;
        body.pickedUpBy = this.pickedUpBy().trim();
        body.pickedUpAt = new Date(this.pickedUpAt()).toISOString();
        if (evidence.video?.storage_ref) body.videoUrl = evidence.video.storage_ref;
      }
      return this.api.actOnReturnItem(record.return_id, itemId, body).pipe(switchMap(() => of('')));
    }));
  }

  /** Sample label for the demo scanner: the return's own QR, so a phone camera reads the real payload. */
  readonly scanSample = computed(() => {
    const record = this.record();
    return record?.return_id ? buildReturnQrPayload(record.return_id, record.return_code) : '';
  });

  openScan(): void {
    this.scanError.set(null);
    this.scanOpen.set(true);
  }

  /**
   * Confirms the operator is holding the parcel for THIS return, then fills the carrier and AWB
   * so only the handover photos stay manual. A code from another return is refused, never applied.
   */
  applyScan(text: string): void {
    const record = this.record();
    this.scanOpen.set(false);
    if (!record?.return_id) return;
    const result = parseScan(text);
    if (result.kind !== 'return' && result.kind !== 'tracking') {
      this.scanError.set('Mã này không phải QR phiếu đổi trả. Quét nhãn on phiếu hoặc dán mã vận đơn.');
      return;
    }
    if (result.returnId && result.returnId !== record.return_id) {
      this.scanError.set('Mã QR thuộc phiếu đổi trả khác. Không ghi nhận chéo phiếu.');
      return;
    }
    if (result.returnCode && record.return_code && result.returnCode !== record.return_code) {
      this.scanError.set('Mã phiếu trên nhãn không khớp phiếu đang mở. Kiểm lại hàng trước khi lấy.');
      return;
    }
    const known = this.flow() === 'ship_exchange'
      ? (record.exchange_tracking_code || '')
      : (record.tracking_return_code || '');
    if (result.trackingCode) {
      this.tracking.set(result.trackingCode);
      if (result.carrier) this.carrier.set(result.carrier);
    } else if (known) {
      this.tracking.set(known);
    } else {
      const facts = demoShipmentFacts({ order_code: record.order_code || record.return_code });
      this.carrier.set(facts.carrier);
      this.tracking.set(this.flow() === 'ship_exchange' ? this.newExchangeTracking() : facts.trackingCode);
    }
    this.scanError.set(null);
  }

  /** Keeps the modal open while an evidence or money operation is in flight. */
  dismiss(): void { if (!this.saving()) this.dismissed.emit(); }

  /** Displays the authoritative allocation, not the whole request total. */
  money(value: number): string { return adminMoney(value); }
}
