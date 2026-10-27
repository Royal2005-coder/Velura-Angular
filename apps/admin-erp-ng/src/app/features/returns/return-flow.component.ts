import { Observable, forkJoin, of } from 'rxjs';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import {
  AdminErpApiService,
  AdminReturnDisposition,
  AdminReturnEvidence,
  AdminReturnLine,
  AdminReturnReceiptLine,
  AdminReturnRow,
  AdminReturnStatus,
} from '../../core/admin-erp-api.service';
import { CARRIER_PROFILES, carrierLabel, deriveTrackingUrl, parseScan } from '../../core/admin-erp-qr';
import {
  CONTACT_RESULTS,
  MIN_NOTE_LENGTH,
  MIN_TRANSFER_REFERENCE_LENGTH,
  manualReturnTransitions,
  paymentKindLabel,
  proofIsUsable,
  refundReceiverBlocked,
  returnStatusLabel,
} from '../../core/admin-erp-service-desk';
import { adminErrorMessage } from '../../core/admin-erp-http';
import { adminDateTime, adminMoney } from '../../core/admin-erp-format';
import { AdminErpModal } from '../../shared/ui/admin-modal';
import { AdminErpQrScan } from '../../shared/ui/admin-qr-scan';
import { AdminErpStatusBadge } from '../../shared/ui/admin-status-badge';

/**
 * Write flows a CSKH operator can run on one return. Money moves only through `manual` or
 * the Stripe button on the page; there is no separate pre-receipt approval step because the
 * database state machine only accepts refunds after warehouse QA.
 */
export type ReturnFlowKind =
  | 'contact'
  | 'exchange'
  | 'reject'
  | 'status'
  | 'receipt'
  | 'manual'
  | 'refund-info'
  | 'shipment'
  | 'pickup'
  | 'exchange-shipment'
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
  imports: [AdminErpModal, AdminErpQrScan, AdminErpStatusBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './return-flow.component.html',
  styleUrl: './return-flow.component.scss',
})
export class ReturnFlowComponent {
  private readonly api = inject(AdminErpApiService);

  readonly flow = input<ReturnFlowKind>(null);
  readonly record = input<AdminReturnRow | null>(null);
  /** Trạng thái đích đã chọn sẵn khi mở từ nút "bước tiếp theo" của drawer. */
  readonly presetStatus = input('');
  /** Message the parent shows after the flow closes; empty means nothing extra happened. */
  readonly done = output<string>();
  readonly dismissed = output<void>();

  readonly contactResult = signal('reached');
  readonly note = signal('');
  readonly amount = signal(0);
  readonly targetStatus = signal('');
  readonly tracking = signal('');
  readonly carrier = signal('');
  readonly trackingUrl = signal('');
  readonly trackingUrlEdited = signal(false);
  readonly pickupPhotos = signal<File[]>([]);
  readonly pickupVideo = signal<File | null>(null);
  readonly pickupVerified = signal(false);
  readonly pickupScanOpen = signal(false);
  readonly packageMatch = signal(true);
  readonly sealIntact = signal(true);
  readonly transferReference = signal('');
  readonly transferredAt = signal('');
  readonly proof = signal('');
  readonly proofBusy = signal(false);
  readonly receipts = signal<Record<string, { received: number; matches: boolean; disposition: AdminReturnDisposition }>>({});
  readonly scanOpen = signal(false);
  readonly carriers = CARRIER_PROFILES;

  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly contactResults = CONTACT_RESULTS;
  readonly minNote = MIN_NOTE_LENGTH;
  readonly title = computed(() => flowTitle(this.flow()));
  readonly refundable = computed(() => Number(this.record()?.refundable_amount ?? 0));
  readonly statusChoices = computed(() =>
    manualReturnTransitions(this.record()?.status, this.record()?.return_type)
      // Shipment legs have dedicated forms (carrier + pickup evidence), never a bare status write.
      .filter((value) => value !== 'RETURN_IN_TRANSIT' && value !== 'EXCHANGE_SHIPPING')
      .map((value) => ({ value, label: returnStatusLabel(value) })),
  );
  readonly lines = computed<AdminReturnLine[]>(() => this.record()?.lines || []);
  readonly needsTracking = computed(() => this.targetStatus() === 'RETURN_IN_TRANSIT' || this.targetStatus() === 'EXCHANGE_SHIPPING');
  readonly needsReason = computed(() => this.targetStatus() === 'CANCELLED' || this.targetStatus() === 'NEEDS_SUPPORT');
  readonly needsProofForSupport = computed(() => this.targetStatus() === 'NEEDS_SUPPORT');
  readonly blockedByReceiver = computed(() => refundReceiverBlocked(this.record()));
  readonly isShipmentFlow = computed(() => this.flow() === 'shipment' || this.flow() === 'exchange-shipment');
  readonly shipmentTitle = computed(() => this.flow() === 'exchange-shipment' ? 'Vận đơn hàng đổi' : 'Vận đơn hoàn');
  /** The database records the refundable amount verbatim, so a different amount is rejected. */
  readonly amountMismatch = computed(() => this.refundable() > 0 && this.amount() !== this.refundable());

  constructor() {
    effect(() => {
      const flow = this.flow();
      const record = this.record();
      const preset = this.presetStatus();
      if (flow && record) {
        this.resetForFlow(flow, record, preset);
      }
    });
  }

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
      case 'exchange':
        return true;
      case 'shipment':
      case 'exchange-shipment':
        return this.carrier().trim().length >= 2 && this.tracking().trim().length >= 6;
      case 'pickup':
        return this.pickupPhotos().length > 0 && this.pickupVerified();
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
        return (
          proofIsUsable(this.proof()) &&
          this.receiptsComplete() &&
          this.receiptsMatch() &&
          this.packageMatch() &&
          this.sealIntact()
        );
      case 'manual':
        return (
          this.transferReference().trim().length >= MIN_TRANSFER_REFERENCE_LENGTH &&
          proofIsUsable(this.proof()) &&
          this.amount() > 0 &&
          !this.amountMismatch() &&
          !this.blockedByReceiver() &&
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
      return {
        id,
        expected,
        received,
        matches: state?.matches ?? true,
        disposition: state?.disposition ?? 'restock',
        short: received !== expected,
      };
    });
  });

  /**
   * Seeds every flow the moment its modal opens. Without this reset the receipt form has no
   * row state (so `receiptsComplete()` stays false) and the refund form opens with amount 0.
   */
  private resetForFlow(flow: Exclude<ReturnFlowKind, null>, record: AdminReturnRow, preset: string): void {
    const existingShipment = flow === 'exchange-shipment' ? record.exchange_shipment : record.shipment;
    this.error.set(null);
    this.note.set('');
    this.tracking.set(existingShipment?.tracking_code || '');
    this.carrier.set(existingShipment?.carrier || 'GHN');
    this.trackingUrl.set(existingShipment?.tracking_url || '');
    this.trackingUrlEdited.set(Boolean(existingShipment?.tracking_url));
    this.pickupPhotos.set([]);
    this.pickupVideo.set(null);
    this.pickupVerified.set(false);
    this.pickupScanOpen.set(false);
    this.packageMatch.set(true);
    this.sealIntact.set(true);
    this.transferReference.set('');
    this.transferredAt.set(localDateTimeValue());
    this.proof.set('');
    this.contactResult.set('reached');
    this.targetStatus.set(flow === 'status' ? preset : '');
    this.amount.set(flow === 'manual' ? this.refundable() : 0);
    const seed: Record<string, { received: number; matches: boolean; disposition: AdminReturnDisposition }> = {};
    for (const line of this.lines()) {
      const id = String(line.order_item_id || '');
      seed[id] = { received: Number(line.quantity || 0), matches: true, disposition: 'restock' };
    }
    this.receipts.set(seed);
  }

  /**
   * Edits carrier/AWB/URL; a known carrier derives its public tracking URL until an operator
   * types one by hand.
   */
  setShipmentField(field: 'carrier' | 'trackingCode' | 'trackingUrl', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (field === 'carrier') this.carrier.set(value);
    else if (field === 'trackingCode') this.tracking.set(value);
    else {
      this.trackingUrl.set(value);
      this.trackingUrlEdited.set(true);
      return;
    }
    if (this.trackingUrlEdited()) return;
    const derived = deriveTrackingUrl(this.carrier(), this.tracking());
    if (derived) this.trackingUrl.set(derived);
  }

  /** Picks the carrier pickup photos (multiple, images only). */
  onPickupPhotos(event: Event): void {
    const picker = event.target as HTMLInputElement;
    const files = Array.from(picker.files || []).filter((file) => file.type.startsWith('image/')).slice(0, 8);
    picker.value = '';
    this.pickupPhotos.set(files);
    if (!files.length) this.error.set('Chọn ít nhất một ảnh ĐVVC chụp kiện hàng niêm phong.');
  }

  /**
   * Confirms the parcel code matches the return slip or the carrier AWB before the pickup can
   * be recorded. This is the chain-of-custody link between the shop label and the parcel.
   */
  applyPickupScan(text: string): void {
    this.pickupScanOpen.set(false);
    const record = this.record();
    if (!record) return;
    const raw = text.trim();
    const result = parseScan(text);
    const shipmentCode = record.shipment?.tracking_code || record.tracking_return_code || '';
    const matchesReturn = result.kind === 'return'
      && result.returnId === record.return_id
      && (!result.returnCode || !record.return_code || result.returnCode === record.return_code);
    const matchesReturnCode = Boolean(record.return_code) && raw === record.return_code;
    const matchesParcel = Boolean(shipmentCode) && (raw === shipmentCode || result.trackingCode === shipmentCode);
    if (matchesReturn || matchesReturnCode || matchesParcel) {
      this.pickupVerified.set(true);
      this.error.set(null);
      return;
    }
    this.pickupVerified.set(false);
    this.error.set('Mã quét không khớp mã phiếu hoặc mã vận đơn trên kiện hàng. Kiểm lại nhãn trước khi xác nhận.');
  }

  /** Picks one pickup video (optional, max 50 MB). */
  onPickupVideo(event: Event): void {
    const picker = event.target as HTMLInputElement;
    const file = picker.files?.[0] || null;
    picker.value = '';
    if (file && !['video/mp4', 'video/webm'].includes(file.type)) {
      this.error.set('Video phải là MP4 hoặc WebM.');
      this.pickupVideo.set(null);
      return;
    }
    if (file && file.size > 50 * 1024 * 1024) {
      this.error.set('Video vượt quá 50 MB.');
      this.pickupVideo.set(null);
      return;
    }
    this.pickupVideo.set(file);
  }

  /** Confirms the two package-level QA facts the DB guard requires. */
  setPackageCheck(field: 'packageMatch' | 'sealIntact', event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    if (field === 'packageMatch') this.packageMatch.set(checked);
    else this.sealIntact.set(checked);
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
  setReceipt(orderItemId: string, field: 'received' | 'matches' | 'disposition', event: Event): void {
    this.receipts.update((rows) => {
      const current = rows[orderItemId] || { received: 0, matches: true, disposition: 'restock' as AdminReturnDisposition };
      const value =
        field === 'received'
          ? Math.max(0, Math.trunc(Number((event.target as HTMLInputElement).value) || 0))
          : field === 'matches'
            ? (event.target as HTMLInputElement).checked
            : ((event.target as HTMLSelectElement).value as AdminReturnDisposition);
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
    if (this.flow() === 'pickup') {
      this.submitPickup(record, Number(record.version), note);
      return;
    }
    const request = this.buildRequest(record, note);
    if (!request) {
      this.saving.set(false);
      return;
    }
    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.done.emit('');
      },
      error: (error: unknown) => this.fail(error),
    });
  }

  /**
   * Uploads pickup photos/video first, then confirms the handover with their private storage
   * refs. A failed upload leaves the return in WAITING_RETURN, so the operator can retry.
   */
  private submitPickup(record: AdminReturnRow, version: number, note: string): void {
    const photos = this.pickupPhotos();
    const video = this.pickupVideo();
    const photo$ = photos.length
      ? forkJoin(photos.map((file) => this.api.uploadReturnEvidence(record.return_id, file, 'pickup_photo', note)))
      : of([] as AdminReturnEvidence[]);
    const video$ = video
      ? this.api.uploadReturnEvidence(record.return_id, video, 'pickup_video', note)
      : of(null);
    forkJoin({ photos: photo$, video: video$ }).subscribe({
      next: ({ photos: uploadedPhotos, video: uploadedVideo }) => {
        const photoUrls = uploadedPhotos
          .map((row) => row.storage_ref)
          .filter((value): value is string => Boolean(value));
        if (!photoUrls.length) {
          this.fail('Không lưu được ảnh pickup. Thử lại.');
          return;
        }
        this.api.confirmReturnPickup(record.return_id, {
          expectedVersion: version,
          photoUrls,
          ...(uploadedVideo?.storage_ref ? { videoUrl: uploadedVideo.storage_ref } : {}),
          ...(note ? { note } : {}),
        }).subscribe({
          next: () => {
            this.saving.set(false);
            this.done.emit('');
          },
          error: (error: unknown) => this.fail(error),
        });
      },
      error: (error: unknown) => this.fail(error),
    });
  }

  /**
   * Fills the return tracking code from a carrier label. Any code that is not a shipment
   * payload is rejected instead of being written into a money-adjacent field.
   */
  applyTrackingScan(text: string): void {
    this.scanOpen.set(false);
    const result = parseScan(text);
    if ((result.kind === 'tracking' || result.kind === 'shipment') && result.trackingCode) {
      this.tracking.set(result.trackingCode);
      if (result.carrier) this.carrier.set(carrierLabel(result.carrier));
      if (result.trackingUrl) {
        this.trackingUrl.set(result.trackingUrl);
        this.trackingUrlEdited.set(true);
      } else if (!this.trackingUrlEdited()) {
        const derived = deriveTrackingUrl(this.carrier(), result.trackingCode);
        if (derived) this.trackingUrl.set(derived);
      }
      this.error.set(null);
      return;
    }
    this.error.set('Mã QR không có mã vận đơn. Quét label của ĐVVC hoặc nhập tay.');
  }

  private fail(error: unknown): void {
    this.saving.set(false);
    this.error.set(adminErrorMessage(error, 'Không ghi nhận được thao tác.'));
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
      case 'exchange':
        // QA already passed; the RPC creates the replacement order and reserves stock atomically.
        return this.api.updateReturnStatus(id, { status: 'EXCHANGE_PREPARING', expectedVersion: version });
      case 'reject':
        return this.api.rejectReturn(id, { reason: note, expectedVersion: version });
      case 'refund-info':
        return this.api.requestRefundInfo(id, { message: note, expectedVersion: version });
      case 'shipment':
        return this.api.createReturnShipment(id, {
          expectedVersion: version,
          carrier: this.carrier().trim(),
          trackingCode: this.tracking().trim(),
          ...(this.trackingUrl().trim() ? { trackingUrl: this.trackingUrl().trim() } : {}),
        });
      case 'exchange-shipment':
        return this.api.shipExchange(id, {
          expectedVersion: version,
          carrier: this.carrier().trim(),
          trackingCode: this.tracking().trim(),
          ...(this.trackingUrl().trim() ? { trackingUrl: this.trackingUrl().trim() } : {}),
        });
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
          packageMatch: this.packageMatch(),
          sealIntact: this.sealIntact(),
          ...(note ? { qaNote: note } : {}),
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
      return {
        orderItemId: id,
        receivedQuantity: Number(state?.received ?? 0),
        matchesProduct: state?.matches ?? false,
        disposition: state?.disposition ?? 'scrap',
      };
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
    exchange: 'Duyệt đổi hàng',
    reject: 'Từ chối yêu cầu',
    status: 'Cập nhật trạng thái phiếu',
    receipt: 'Kho nhận hàng hoàn trả',
    manual: 'Ghi nhận chuyển khoản hoàn tiền',
    'refund-info': 'Yêu cầu khách bổ sung thông tin nhận tiền',
    shipment: 'Tạo vận đơn hoàn',
    pickup: 'Xác nhận ĐVVC lấy hàng',
    'exchange-shipment': 'Giao hàng đổi',
  };
  return flow === null ? '' : titles[flow];
}

/** `datetime-local` needs local wall-clock time; `toISOString()` would shift it to UTC. */
function localDateTimeValue(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
