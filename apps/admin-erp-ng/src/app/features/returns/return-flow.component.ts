import { Observable, forkJoin, of, switchMap } from 'rxjs';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { AdminErpApiService, AdminOrderRow, AdminReturnDisposition, AdminReturnItemAction, AdminReturnItemActionInput, AdminReturnLine, AdminReturnReplacementChoice, AdminReturnRow } from '../../core/admin-erp-api.service';
import { CONTACT_RESULTS, MIN_NOTE_LENGTH, MIN_TRANSFER_REFERENCE_LENGTH, gatewayNote, itemRefundAllowed, refundReceiverBlocked, returnItemActions } from '../../core/admin-erp-service-desk';
import { adminErrorMessage } from '../../core/admin-erp-http';
import { adminMoney } from '../../core/admin-erp-format';
import { AdminErpModal } from '../../shared/ui/admin-modal';

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
  selector: 'app-erp-return-flow', imports: [AdminErpModal],
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
  readonly disposition = signal<AdminReturnDisposition>('restock');
  readonly proofFile = signal<File | null>(null);
  readonly pickupPhotos = signal<File[]>([]);
  readonly pickupVideo = signal<File | null>(null);
  readonly pickedUpBy = signal('');
  readonly pickedUpAt = signal('');
  readonly transferReference = signal('');
  readonly transferredAt = signal('');
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly contactResults = CONTACT_RESULTS;
  readonly minNote = MIN_NOTE_LENGTH;
  readonly title = computed(() => this.flow() ? RETURN_ITEM_ACTION_LABELS[this.flow()!] : '');
  readonly needsConsent = computed(() => this.flow() === 'convert_refund' || this.flow() === 'change_variant');
  readonly needsReason = computed(() => ['approve', 'reject', 'needs_support', 'resolve', 'stop', 'convert_refund', 'change_variant', 'contact', 'refund-info'].includes(String(this.flow())));
  readonly isMoney = computed(() => this.flow() === 'manual' || this.flow() === 'stripe');
  readonly refundable = computed(() => Number(this.line()?.refundable_amount || 0));
  readonly canSplit = computed(() => !this.isMoney() && !['contact', 'refund-info', 'ship_exchange', 'complete_exchange'].includes(String(this.flow())) && !this.line()?.exchange_order_id);
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
    if (flow === 'receive') return Boolean(this.proofFile()) && Number.isInteger(this.receivedQuantity())
      && this.receivedQuantity() > 0 && this.receivedQuantity() === this.quantity();
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
      this.packageMatch.set(true); this.sealIntact.set(true); this.disposition.set('restock');
      this.proofFile.set(null); this.pickupPhotos.set([]); this.pickupVideo.set(null);
      this.transferReference.set(''); this.tracking.set(flow === 'ship_exchange' ? this.newExchangeTracking() : ''); this.carrier.set('GHN'); this.contactResult.set('reached');
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

  /** Stores ordinary text without silently coercing malformed quantities into valid ones. */
  setText(field: 'note' | 'replacementVariantId' | 'tracking' | 'carrier' | 'transferReference' | 'transferredAt' | 'contactResult' | 'pickedUpBy' | 'pickedUpAt', event: Event): void {
    this[field].set((event.target as HTMLInputElement).value);
  }

  /** Processing fewer units creates an independent remainder on the server. */
  setQuantity(event: Event): void {
    const quantity = Number((event.target as HTMLInputElement).value);
    this.quantity.set(quantity); this.receivedQuantity.set(quantity);
    if (this.flow() === 'change_variant') this.initSelectedVariant();
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
    this.disposition.set((event.target as HTMLSelectElement).value as AdminReturnDisposition);
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
        disposition: this.disposition(), dispositionNote: note, receiptProofRef: proofRef,
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

  /** Keeps the modal open while an evidence or money operation is in flight. */
  dismiss(): void { if (!this.saving()) this.dismissed.emit(); }

  /** Displays the authoritative allocation, not the whole request total. */
  money(value: number): string { return adminMoney(value); }
}
