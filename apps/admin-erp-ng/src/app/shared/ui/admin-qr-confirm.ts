import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal, untracked } from '@angular/core';
import { carrierLabel, parseScan } from '../../core/admin-erp-qr';
import { AdminErpQrScan } from './admin-qr-scan';

/**
 * Facts a confirm step takes from the QR instead of from typed fields.
 *
 * Every value here is fixed by the label the customer/warehouse received, so the operator can
 * only read them: order code, order URL, carrier, tracking code, shipper and scan time.
 */
export interface QrConfirmFacts {
  readonly raw: string;
  readonly orderCode: string;
  readonly returnCode: string;
  readonly carrier: string;
  readonly trackingCode: string;
  readonly shipperName: string;
  readonly shipperPhone: string;
  /** ISO timestamp of the accepted scan, not of the order. */
  readonly scannedAt: string;
}

/**
 * QR-first confirmation panel shared by order confirmation and every return/exchange step.
 *
 * The panel renders one clear scan entry point with instructions, and after a successful scan
 * replaces it with the read-only fact grid. Callers own the evidence upload and the API call:
 * this component only proves which parcel is in the operator's hands.
 */
@Component({
  selector: 'app-erp-qr-confirm',
  imports: [AdminErpQrScan],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-qr-confirm.html',
  styleUrl: './admin-qr-confirm.scss',
})
export class AdminErpQrConfirm {
  /** `order` accepts the order's own QR/label; `return` accepts the return paperwork or its AWB. */
  readonly kind = input<'order' | 'return'>('order');
  readonly recordId = input('');
  /** Code the operator expects to see on the label; a different code is refused. */
  readonly recordCode = input('');
  readonly orderCode = input('');
  /** Deep link of the record, shown as the fixed "URL đơn" row. */
  readonly recordHref = input('');
  readonly knownCarrier = input('');
  readonly knownTracking = input('');
  readonly sample = input('');
  readonly sampleCaption = input('');
  /** Re-opens the panel with a clean state when the caller closes its modal. */
  readonly open = input(true);
  /** Caller-specific first line; the default copy names the fields the label carries. */
  readonly intro = input('');
  readonly facts = output<QrConfirmFacts>();

  readonly current = signal<QrConfirmFacts | null>(null);
  readonly error = signal<string | null>(null);
  readonly scanOpen = signal(false);

  readonly scanTitle = computed(() =>
    this.kind() === 'return' ? 'Quét QR phiếu đổi trả / vận đơn hoàn' : 'Quét QR trên phiếu đơn hàng',
  );
  readonly scanHint = computed(() =>
    this.kind() === 'return'
      ? 'Quét mã in trên phiếu đổi trả, hoặc nhãn vận đơn của kiện hoàn để lấy ĐVVC và mã vận đơn.'
      : 'Quét mã in trên phiếu đơn hoặc nhãn giao hàng để lấy mã đơn, ĐVVC, người giao và thời điểm.',
  );
  readonly heroTitle = computed(() =>
    this.kind() === 'return' ? 'Quét QR phiếu đổi trả để xác nhận' : 'Quét QR trên đơn để xác nhận',
  );
  readonly heroIntro = computed(() =>
    this.kind() === 'return'
      ? 'Thông tin phiếu, ĐVVC, người giao và thời điểm được đọc thẳng từ mã in trên phiếu. Không nhập tay.'
      : 'Mã đơn, URL đơn, đơn vị vận chuyển, người giao và thời điểm được đọc thẳng từ mã in trên đơn. Không nhập tay.',
  );
  readonly steps = computed<readonly string[]>(() =>
    this.kind() === 'return'
      ? [
        'Đưa camera vào mã QR in trên phiếu đổi trả, hoặc nhãn vận đơn của kiện hoàn.',
        'Không mở được camera thì tải ảnh mã hoặc dán nội dung mã trong hộp quét.',
        'Hệ thống đối chiếu mã với phiếu đang mở; mã của phiếu/đơn khác bị từ chối.',
      ]
      : [
        'Đưa camera vào mã QR in trên phiếu đơn (hoặc nhãn giao hàng của ĐVVC).',
        'Không mở được camera thì tải ảnh mã hoặc dán nội dung mã trong hộp quét.',
        'Thông tin đọc được bị khóa lại; bạn chỉ còn thêm ảnh minh chứng và ghi chú.',
      ],
  );

  private lastKey = '';

  constructor() {
    effect(() => {
      const key = `${this.kind()}|${this.recordId()}|${this.recordCode()}|${this.open()}`;
      untracked(() => {
        if (key === this.lastKey) {
          return;
        }
        this.lastKey = key;
        this.reset();
      });
    });
  }

  /**
   * Clears the scanned facts so the next confirmation starts from the camera again.
   */
  reset(): void {
    this.current.set(null);
    this.error.set(null);
    this.scanOpen.set(false);
  }

  openScan(): void {
    this.error.set(null);
    this.scanOpen.set(true);
  }

  /**
   * Validates one payload against the open record, then publishes its fixed facts.
   * A label from another record is refused instead of being partially applied.
   */
  applyScan(text: string): void {
    this.scanOpen.set(false);
    this.error.set(null);
    const isReturn = this.kind() === 'return';
    const result = parseScan(text, {
      origin: typeof window !== 'undefined' ? window.location.origin : '',
      orderId: isReturn ? null : this.recordId() || null,
      orderCode: isReturn ? this.orderCode() : this.recordCode(),
    });
    if (result.kind === 'unknown') {
      this.error.set('Không đọc được thông tin trong mã này. Quét lại mã in trên phiếu, hoặc dán đúng nội dung mã.');
      return;
    }
    if (isReturn) {
      if (result.kind === 'order') {
        this.error.set('Đây là QR của đơn hàng, không phải phiếu đổi trả. Quét phiếu đổi trả hoặc nhãn vận đơn hoàn.');
        return;
      }
      if (result.returnId && this.recordId() && result.returnId !== this.recordId()) {
        this.error.set('Mã QR thuộc phiếu đổi trả khác. Không xác nhận chéo phiếu.');
        return;
      }
      if (result.returnCode && this.recordCode() && result.returnCode !== this.recordCode()) {
        this.error.set('Mã phiếu trên nhãn không khớp phiếu đang mở. Kiểm lại kiện hàng trước khi xác nhận.');
        return;
      }
    } else {
      if (result.kind === 'return') {
        this.error.set('Đây là QR phiếu đổi trả, không phải đơn hàng. Mở đúng đơn trước khi xác nhận.');
        return;
      }
      if (result.kind === 'tracking') {
        this.error.set('Mã này chỉ có số vận đơn. Quét QR in trên phiếu đơn để lấy đủ thông tin đơn hàng.');
        return;
      }
      if (result.mismatch) {
        this.error.set('Mã QR này thuộc một đơn khác. Kiểm lại phiếu trước khi xác nhận.');
        return;
      }
    }
    const facts: QrConfirmFacts = {
      raw: String(text || '').trim(),
      orderCode: result.orderCode || (isReturn ? '' : this.recordCode()),
      returnCode: isReturn ? result.returnCode || this.recordCode() : '',
      carrier: result.carrier ? carrierLabel(result.carrier) : this.knownCarrier(),
      trackingCode: result.trackingCode || this.knownTracking(),
      shipperName: result.shipperName || '',
      shipperPhone: result.shipperPhone || '',
      scannedAt: new Date().toISOString(),
    };
    this.current.set(facts);
    this.facts.emit(facts);
  }

  /**
   * Time the label was accepted, in the operator's locale.
   */
  scannedAtLabel(value: string | null | undefined): string {
    if (!value) {
      return '—';
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('vi-VN');
  }
}
