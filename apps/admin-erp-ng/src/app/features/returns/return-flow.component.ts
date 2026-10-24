import { Observable } from 'rxjs';
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import {
  AdminErpApiService,
  AdminReturnLine,
  AdminReturnReceiptLine,
  AdminReturnRow,
  AdminReturnStatus,
} from '../../core/admin-erp-api.service';
import {
  CONTACT_RESULTS,
  MIN_NOTE_LENGTH,
  MIN_TRANSFER_REFERENCE_LENGTH,
  approvalNeedsReason,
  manualReturnTransitions,
  paymentKindLabel,
  proofIsUsable,
  refundReceiverBlocked,
  returnStatusLabel,
} from '../../core/admin-erp-service-desk';
import { adminErrorMessage } from '../../core/admin-erp-http';
import { adminDateTime, adminMoney } from '../../core/admin-erp-format';
import { AdminErpModal } from '../../shared/ui/admin-modal';
import { AdminErpStatusBadge } from '../../shared/ui/admin-status-badge';

/** Write flows a CSKH operator can run on one return. */
export type ReturnFlowKind =
  | 'contact'
  | 'refund'
  | 'exchange'
  | 'reject'
  | 'status'
  | 'receipt'
  | 'manual'
  | 'refund-info'
  | null;

const PROOF_MAX_DIMENSION = 1280;
const PROOF_QUALITY = 0.82;

/**
 * One modal for every return write. Each flow keeps the fields its endpoint actually reads,
 * shows the amount or tracking the API will enforce, and refuses to send a note shorter than
 * the audited minimum so the operator sees the reason before the request leaves the browser.
 */
@Component({
  selector: 'app-erp-return-flow',
  imports: [AdminErpModal, AdminErpStatusBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './return-flow.component.html',
  styleUrl: './return-flow.component.scss',
})
export class ReturnFlowComponent {
  private readonly api = inject(AdminErpApiService);

  readonly flow = input<ReturnFlowKind>(null);
  readonly record = input<AdminReturnRow | null>(null);
  readonly done = output<void>();
  readonly dismissed = output<void>();

  readonly contactResult = signal('reached');
  readonly note = signal('');
  readonly amount = signal(0);
  readonly targetStatus = signal('');
  readonly tracking = signal('');
  readonly transferReference = signal('');
  readonly transferredAt = signal('');
  readonly proof = signal('');
  readonly proofBusy = signal(false);
  readonly receipts = signal<Record<string, { received: number; matches: boolean }>>({});

  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly contactResults = CONTACT_RESULTS;
  readonly minNote = MIN_NOTE_LENGTH;
  readonly title = computed(() => flowTitle(this.flow()));
  readonly refundable = computed(() => Number(this.record()?.refundable_amount ?? 0));
  readonly statusChoices = computed(() =>
    manualReturnTransitions(this.record()?.status).map((value) => ({ value, label: returnStatusLabel(value) })),
  );
  readonly lines = computed<AdminReturnLine[]>(() => this.record()?.lines || []);
  readonly needsTracking = computed(() => this.targetStatus() === 'RETURN_IN_TRANSIT' || this.targetStatus() === 'EXCHANGE_SHIPPING');
  readonly needsReason = computed(() => this.targetStatus() === 'CANCELLED' || this.targetStatus() === 'NEEDS_SUPPORT');
  readonly needsProofForSupport = computed(() => this.targetStatus() === 'NEEDS_SUPPORT');
  readonly blockedByReceiver = computed(() => refundReceiverBlocked(this.record()));
  /** The API waives the approval reason once a contact log exists; the form mirrors that. */
  readonly requiresReason = computed(() => approvalNeedsReason(this.record()));
  readonly amountMismatch = computed(() => this.refundable() > 0 && this.amount() > this.refundable());

  readonly canSubmit = computed(() => {
    if (this.saving() || !this.record() || this.flow() === null) {
      return false;
    }
    const note = this.note().trim();
    switch (this.flow()) {
      case 'contact':
      case 'reject':
      case 'refund-info':
        return note.length >= MIN_NOTE_LENGTH;
      case 'refund':
        return this.amount() > 0 && !this.amountMismatch() && (!this.requiresReason() || note.length >= MIN_NOTE_LENGTH);
      case 'exchange':
        return !this.requiresReason() || note.length >= MIN_NOTE_LENGTH;
      case 'status':
        if (!this.targetStatus()) {
          return false;
        }
        if (this.needsTracking() && !this.tracking().trim()) {
          return false;
        }
        if (this.needsReason() && note.length < MIN_NOTE_LENGTH) {
          return false;
        }
        return !(this.needsProofForSupport() && !proofIsUsable(this.proof()));
      case 'receipt':
        return proofIsUsable(this.proof()) && this.receiptsComplete() && this.receiptsMatch();
      case 'manual':
        return (
          this.transferReference().trim().length >= MIN_TRANSFER_REFERENCE_LENGTH &&
          proofIsUsable(this.proof()) &&
          this.amount() > 0 &&
          !this.amountMismatch() &&
          this.transferredAt().length > 0
        );
      default:
        return false;
    }
  });

  /**
   * One row per registered line. The API returns only `order_item_id` and the quantity, so the
   * operator confirms against the order line they can see, never against an invented name.
   */
  readonly receiptSummary = computed(() => {
    const chosen = this.receipts();
    return this.lines().map((line) => {
      const id = String(line.order_item_id || '');
      const state = chosen[id];
      const expected = Number(line.quantity || 0);
      const received = Number(state?.received ?? expected);
      return { id, expected, received, matches: state?.matches ?? true, short: received !== expected };
    });
  });

  /**
   * Opens the flow with the values that flow starts from.
   */
  prepare(): void {
    const record = this.record();
    this.error.set(null);
    this.note.set('');
    this.tracking.set('');
    this.transferReference.set('');
    this.transferredAt.set(new Date().toISOString().slice(0, 16));
    this.proof.set('');
    this.contactResult.set('reached');
    this.targetStatus.set(manualReturnTransitions(record?.status)[0] || '');
    this.amount.set(this.flow() === 'refund' || this.flow() === 'manual' ? this.refundable() : 0);
    const seed: Record<string, { received: number; matches: boolean }> = {};
    for (const line of this.lines()) {
      const id = String(line.order_item_id || '');
      seed[id] = { received: Number(line.quantity || 0), matches: true };
    }
    this.receipts.set(seed);
  }

  /**
   * Chooses the outreach result recorded on the contact log.
   */
  setContactResult(event: Event): void {
    this.contactResult.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Types a note, reason or supplement message.
   */
  setNote(event: Event): void {
    this.note.set((event.target as HTMLTextAreaElement).value);
  }

  /**
   * Edits the refund amount; the API still caps it at the value of the returned goods.
   */
  setAmount(event: Event): void {
    this.amount.set(Number((event.target as HTMLInputElement).value) || 0);
  }

  /**
   * Picks the next workflow state.
   */
  setTargetStatus(event: Event): void {
    this.targetStatus.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Types a tracking code or transfer reference.
   */
  setText(field: 'tracking' | 'transferReference' | 'transferredAt', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (field === 'tracking') {
      this.tracking.set(value);
    } else if (field === 'transferReference') {
      this.transferReference.set(value);
    } else {
      this.transferredAt.set(value);
    }
  }

  /**
   * Edits one receipt line of the warehouse check.
   */
  setReceipt(orderItemId: string, field: 'received' | 'matches', event: Event): void {
    this.receipts.update((rows) => {
      const current = rows[orderItemId] || { received: 0, matches: true };
      const value =
        field === 'received'
          ? Math.max(0, Math.trunc(Number((event.target as HTMLInputElement).value) || 0))
          : (event.target as HTMLInputElement).checked;
      return { ...rows, [orderItemId]: { ...current, [field]: value } };
    });
  }

  /**
   * Reads and compresses a warehouse or transfer photo into a storable data URL.
   */
  onProofPicked(event: Event): void {
    const picker = event.target as HTMLInputElement;
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) {
      return;
    }
    this.proofBusy.set(true);
    this.error.set(null);
    void compressProof(file)
      .then((dataUrl) => {
        this.proofBusy.set(false);
        if (!dataUrl) {
          this.error.set('Không đọc được ảnh minh chứng. Hãy chọn ảnh khác.');
          return;
        }
        this.proof.set(dataUrl);
      })
      .catch(() => {
        this.proofBusy.set(false);
        this.error.set('Không xử lý được ảnh minh chứng.');
      });
  }

  /**
   * Runs the selected flow against the return's current version.
   */
  submit(): void {
    const record = this.record();
    if (!record || record.version == null || !this.canSubmit()) {
      return;
    }
    this.error.set(null);
    this.saving.set(true);
    const note = this.note().trim();
    const request = this.buildRequest(record, note);
    if (!request) {
      this.saving.set(false);
      return;
    }
    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.done.emit();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.error.set(adminErrorMessage(error, 'Không ghi nhận được thao tác.'));
      },
    });
  }

  /**
   * Closes the modal without writing.
   */
  dismiss(): void {
    if (!this.saving()) {
      this.dismissed.emit();
    }
  }

  /**
   * Payment channel label.
   */
  paymentLabel(kind: string | null | undefined): string {
    return paymentKindLabel(kind);
  }

  /**
   * Money label.
   */
  money(value: number | null | undefined): string {
    return adminMoney(value);
  }

  /**
   * Timestamp label.
   */
  date(value: string | null | undefined): string {
    return adminDateTime(value);
  }

  private buildRequest(record: AdminReturnRow, note: string): Observable<unknown> | null {
    const id = record.return_id;
    const version = Number(record.version);
    switch (this.flow()) {
      case 'contact':
        return this.api.recordReturnContact(id, { result: this.contactResult(), note, expectedVersion: version });
      case 'refund':
        return this.api.approveRefund(id, { refundAmount: this.amount(), adminNote: note, expectedVersion: version });
      case 'exchange':
        return this.api.approveExchange(id, { adminNote: note, expectedVersion: version });
      case 'reject':
        return this.api.rejectReturn(id, { reason: note, expectedVersion: version });
      case 'refund-info':
        return this.api.requestRefundInfo(id, { message: note, expectedVersion: version });
      case 'status':
        return this.api.updateReturnStatus(id, {
          status: this.targetStatus() as AdminReturnStatus,
          expectedVersion: version,
          ...(this.needsTracking() ? { trackingReturnCode: this.tracking().trim() } : {}),
          ...(this.needsReason() ? { reason: note } : {}),
          ...(this.needsProofForSupport() ? { imageProof: this.proof() } : {}),
        });
      case 'receipt':
        return this.api.updateReturnStatus(id, {
          status: 'RECEIVED',
          expectedVersion: version,
          conditionCheckResult: 'qa_pass',
          imageProof: this.proof(),
          items: this.receiptItems(),
        });
      case 'manual':
        return this.api.recordManualRefund(id, {
          expectedVersion: version,
          transferReference: this.transferReference().trim(),
          amount: this.amount(),
          transferredAt: new Date(this.transferredAt()).toISOString(),
          imageProof: this.proof(),
          ...(note ? { adminNote: note } : {}),
        });
      default:
        return null;
    }
  }

  private receiptItems(): AdminReturnReceiptLine[] {
    return this.lines().map((line) => {
      const id = String(line.order_item_id || '');
      const state = this.receipts()[id];
      return { orderItemId: id, receivedQuantity: Number(state?.received ?? 0), matchesProduct: state?.matches ?? false };
    });
  }

  private receiptsComplete(): boolean {
    const chosen = this.receipts();
    return this.lines().length > 0 && this.lines().every((line) => chosen[String(line.order_item_id || '')]);
  }

  private receiptsMatch(): boolean {
    return this.receiptSummary().every((row) => row.matches && !row.short);
  }
}

/** Label of each flow, shown as the modal title. */
function flowTitle(flow: ReturnFlowKind): string {
  const titles: Record<Exclude<ReturnFlowKind, null>, string> = {
    contact: 'Ghi nhận liên hệ khách',
    refund: 'Duyệt hoàn tiền',
    exchange: 'Duyệt đổi hàng',
    reject: 'Từ chối yêu cầu',
    status: 'Cập nhật trạng thái phiếu',
    receipt: 'Kho nhận hàng hoàn trả',
    manual: 'Ghi nhận chuyển khoản hoàn tiền',
    'refund-info': 'Yêu cầu khách bổ sung thông tin nhận tiền',
  };
  return flow === null ? '' : titles[flow];
}

/**
 * Shrinks the picked photo to the API payload limit: longest edge 1280 px, JPEG quality 0.82.
 * A file the browser cannot decode is reported instead of silently sent as an empty proof.
 */
async function compressProof(file: File, maxDimension = PROOF_MAX_DIMENSION, quality = PROOF_QUALITY): Promise<string> {
  const dataUrl = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve('');
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
  if (!dataUrl || typeof Image === 'undefined' || typeof document === 'undefined') {
    return dataUrl;
  }
  const image = await new Promise<HTMLImageElement | null>((resolve) => {
    const element = new Image();
    element.onerror = () => resolve(null);
    element.onload = () => resolve(element);
    element.src = dataUrl;
  });
  if (!image || !image.naturalWidth || !image.naturalHeight) {
    return dataUrl;
  }
  let width = image.naturalWidth;
  let height = image.naturalHeight;
  if (width > maxDimension || height > maxDimension) {
    const scale = Math.min(maxDimension / width, maxDimension / height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    return dataUrl;
  }
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality) || dataUrl;
}
