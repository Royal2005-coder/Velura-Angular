import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { toDataURL } from 'qrcode';
import { ORDER_ACCOUNT_MODEL, type ReturnTrackingDetail, type ReturnTrackingEvidence } from '../../core/services/order-account.model';

const MAX_PHOTOS = 8;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/**
 * Customer-facing end-to-end return tracking. Shows the shop-created carrier label, the
 * immutable return code/QR, pickup evidence, the return timeline and the linked replacement
 * order. Packing photos/video can be uploaded until the carrier takes the parcel.
 */
@Component({
  selector: 'app-return-tracking',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="return-track">
      @if (loading()) {
        <p class="muted">Đang tải thông tin vận chuyển hoàn…</p>
      } @else if (error()) {
        <div class="error-box" role="alert">
          <p>{{ error() }}</p>
          <button type="button" class="secondary" (click)="reload()">Thử lại</button>
        </div>
      } @else if (detail(); as d) {
        <header class="return-track__head">
          <div>
            <span class="badge">{{ d.returnCode }}</span>
            <h3>{{ d.statusLabel }}</h3>
            <p class="muted">{{ d.typeLabel }} · Đơn {{ d.orderCode || '—' }}</p>
          </div>
          <span class="status-pill">{{ d.status }}</span>
        </header>

        @if (d.timeline.length) {
          <ol class="track-timeline">
            @for (event of d.timeline; track $index) {
              <li>
                <strong>{{ event.label }}</strong>
                <span class="muted">
                  {{ date(event.at) }}
                  @if (event.carrier) { · {{ event.carrier }} }
                  @if (event.trackingCode) { · {{ event.trackingCode }} }
                </span>
              </li>
            }
          </ol>
        }

        @if (d.shipment; as shipment) {
          <section class="track-card">
            <h4>Vận đơn hoàn</h4>
            <p>
              <strong>{{ shipment.carrier || 'ĐVVC' }}</strong> · <span class="mono">{{ shipment.trackingCode || '—' }}</span>
            </p>
            <p class="muted">Trạng thái: {{ shipmentStatusLabel(shipment.status) }}</p>
            @if (shipment.pickedUpAt) { <p class="muted">ĐVVC lấy hàng: {{ date(shipment.pickedUpAt) }}</p> }
            @if (shipment.trackingUrl) {
              <a [href]="shipment.trackingUrl" target="_blank" rel="noopener">Theo dõi trên trang ĐVVC</a>
            }
          </section>
        }

        <section class="track-card track-label">
          <h4>Phiếu gửi hàng hoàn</h4>
          <p class="muted">Dán phiếu này lên ngoài kiện hàng. Đưa mã QR cho ĐVVC quét khi lấy hàng.</p>
          @if (labelQr()) {
            <img class="label-qr" [src]="labelQr()" alt="Mã QR phiếu gửi hoàn" />
          }
          <p class="mono">{{ d.returnCode }}</p>
          <button type="button" class="secondary" (click)="printLabel()">In phiếu gửi hoàn</button>
        </section>

        @if (d.instructions.length) {
          <section class="track-card">
            <h4>Hướng dẫn đóng gói & gửi hàng</h4>
            <ol class="track-instructions">
              @for (step of d.instructions; track $index) { <li>{{ step }}</li> }
            </ol>
          </section>
        }

        @if (d.canUploadPacking && supportsUpload()) {
          <section class="track-card">
            <h4>Bằng chứng đóng gói của bạn</h4>
            <p class="muted">
              Nên quay video liên tục: sản phẩm → tem/niêm phong → mã phiếu → kiện hàng đã dán nhãn.
              Video/ảnh này được đối chiếu với ảnh ĐVVC chụp khi lấy hàng và ảnh kho khi nhận.
            </p>
            <label class="field">
              Ảnh đóng gói (tối đa {{ maxPhotos }} ảnh)
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple (change)="onPhotos($event)" />
            </label>
            <label class="field">
              Video đóng gói (MP4/WebM, tối đa 50 MB)
              <input type="file" accept="video/mp4,video/webm" (change)="onVideo($event)" />
            </label>
            @if (uploading()) { <p class="muted">Đang tải bằng chứng…</p> }
            @if (uploadNote()) { <p class="success-text">{{ uploadNote() }}</p> }
            @if (uploadError()) { <p class="error" role="alert">{{ uploadError() }}</p> }
          </section>
        } @else if (!d.canUploadPacking) {
          <p class="muted">Bằng chứng đóng gói đã khóa vì ĐVVC đã lấy hàng.</p>
        }

        @if (d.evidence.length) {
          <section class="track-card">
            <h4>Bằng chứng đã lưu</h4>
            <div class="evidence-grid">
              @for (item of d.evidence; track item.evidenceId || item.url) {
                <div class="evidence-item">
                  <span class="muted">{{ evidenceLabel(item.kind) }} · {{ date(item.createdAt) }}</span>
                  @if (item.url && isVideo(item)) {
                    <a [href]="item.url" target="_blank" rel="noopener">Mở video</a>
                  } @else if (item.url) {
                    <a [href]="item.url" target="_blank" rel="noopener"><img [src]="item.url" [alt]="evidenceLabel(item.kind)" /></a>
                  }
                </div>
              }
            </div>
          </section>
        }

        @if (d.exchangeOrder; as exchange) {
          <section class="track-card">
            <h4>Đơn đổi liên kết</h4>
            <p>
              @if (member()) {
                <a [routerLink]="['/account/orders', exchange.orderId]">{{ exchange.orderCode || exchange.orderId }}</a>
              } @else {
                <strong>{{ exchange.orderCode || exchange.orderId }}</strong>
              }
              · {{ exchange.status || '—' }}
            </p>
            <p class="muted">
              {{ exchange.carrier || 'ĐVVC' }} · <span class="mono">{{ exchange.trackingCode || '—' }}</span>
            </p>
            @if (exchange.trackingUrl) {
              <a [href]="exchange.trackingUrl" target="_blank" rel="noopener">Theo dõi hàng đổi</a>
            }
          </section>
        }

        @if (d.exchangeShipment; as shipment) {
          <section class="track-card">
            <h4>Vận đơn hàng đổi</h4>
            <p class="muted">{{ shipment.carrier || 'ĐVVC' }} · {{ shipment.trackingCode || '—' }} · {{ shipmentStatusLabel(shipment.status) }}</p>
          </section>
        }
      }
    </section>
  `,
  styles: [
    `
      .return-track { display: grid; gap: 12px; margin: 12px 0; }
      .return-track__head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 10px; }
      .return-track__head h3 { margin: 4px 0; }
      .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #111; color: #fff; font: 600 11px/1.6 monospace; }
      .status-pill { padding: 4px 10px; border: 1px solid currentColor; border-radius: 999px; font-size: 11px; }
      .track-timeline { display: grid; gap: 8px; margin: 0; padding: 0 0 0 18px; }
      .track-timeline li { display: grid; gap: 2px; padding-left: 4px; }
      .track-card { display: grid; gap: 6px; padding: 12px; border: 1px solid rgba(0,0,0,.12); border-radius: 12px; }
      .track-card h4 { margin: 0; }
      .track-label { justify-items: start; }
      .label-qr { width: 180px; height: 180px; image-rendering: pixelated; background: #fff; }
      .track-instructions { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .muted { opacity: .68; font-size: 12px; }
      .field { display: grid; gap: 4px; font-size: 12px; }
      .evidence-grid { display: flex; flex-wrap: wrap; gap: 10px; }
      .evidence-item { display: grid; gap: 4px; max-width: 180px; font-size: 11px; }
      .evidence-item img { max-width: 160px; max-height: 120px; border-radius: 8px; object-fit: cover; }
      .error { color: #b3261e; font-size: 12px; }
      .error-box { display: grid; gap: 6px; padding: 10px 12px; border: 1px solid #b3261e; border-radius: 10px; }
      .success-text { color: #1b5e20; font-size: 12px; }
    `,
  ],
})
export class ReturnTrackingComponent {
  private readonly model = inject(ORDER_ACCOUNT_MODEL);

  readonly returnId = input.required<string>();
  readonly detail = signal<ReturnTrackingDetail | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly labelQr = signal('');
  readonly uploading = signal(false);
  readonly uploadError = signal('');
  readonly uploadNote = signal('');
  readonly maxPhotos = MAX_PHOTOS;
  readonly member = this.model.member;
  readonly supportsUpload = computed(() => typeof this.model.uploadReturnEvidence === 'function');

  constructor() {
    effect(() => {
      const id = this.returnId();
      if (id) void this.load(id);
    });
  }

  reload(): void {
    void this.load(this.returnId());
  }

  async load(returnId: string): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      if (!this.model.getReturnTracking) {
        throw new Error('Theo dõi vận đơn hoàn chưa khả dụng ở chế độ xem trước.');
      }
      const detail = await this.model.getReturnTracking(returnId);
      this.detail.set(detail);
      this.labelQr.set(await this.makeLabelQr(detail));
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Không tải được thông tin hoàn trả.');
    } finally {
      this.loading.set(false);
    }
  }

  async onPhotos(event: Event): Promise<void> {
    const picker = event.target as HTMLInputElement;
    const files = Array.from(picker.files || []).slice(0, MAX_PHOTOS);
    picker.value = '';
    const valid = files.filter((file) => ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) && file.size <= MAX_PHOTO_BYTES);
    if (valid.length !== files.length) {
      this.uploadError.set('Chỉ nhận JPG/PNG/WebP tối đa 10 MB mỗi ảnh.');
    }
    await this.uploadAll(valid, 'packing_photo');
  }

  async onVideo(event: Event): Promise<void> {
    const picker = event.target as HTMLInputElement;
    const file = picker.files?.[0] || null;
    picker.value = '';
    if (!file) return;
    if (!['video/mp4', 'video/webm'].includes(file.type) || file.size > MAX_VIDEO_BYTES) {
      this.uploadError.set('Video phải là MP4/WebM và không quá 50 MB.');
      return;
    }
    await this.uploadAll([file], 'packing_video');
  }

  date(value: string | null | undefined): string {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('vi-VN');
  }

  shipmentStatusLabel(status: string | null | undefined): string {
    const labels: Record<string, string> = {
      label_ready: 'Đã tạo vận đơn, chờ ĐVVC lấy hàng',
      picked_up: 'ĐVVC đã lấy hàng',
      in_transit: 'Đang vận chuyển về kho',
      delivered: 'Đã tới kho Velura',
      failed: 'Vận chuyển gặp sự cố',
    };
    return labels[String(status || '')] || status || '—';
  }

  evidenceLabel(kind: string | undefined): string {
    const labels: Record<string, string> = {
      request_photo: 'Ảnh khách gửi ban đầu',
      packing_photo: 'Ảnh đóng gói',
      packing_video: 'Video đóng gói',
      pickup_photo: 'Ảnh ĐVVC lấy hàng',
      pickup_video: 'Video pickup',
      qa_photo: 'Ảnh kho kiểm hàng',
      qa_video: 'Video kho kiểm hàng',
    };
    return labels[String(kind || '')] || 'Bằng chứng';
  }

  isVideo(item: ReturnTrackingEvidence): boolean {
    return String(item.mimeType || '').startsWith('video/');
  }

  printLabel(): void {
    const detail = this.detail();
    const qr = this.labelQr();
    if (!detail || !qr) return;
    const windowRef = window.open('', '_blank', 'width=560,height=780');
    if (!windowRef) {
      this.uploadError.set('Trình duyệt đang chặn cửa sổ in. Cho phép popup rồi thử lại.');
      return;
    }
    const doc = windowRef.document;
    doc.title = `Phiếu gửi hoàn ${detail.returnCode}`;
    const style = doc.createElement('style');
    style.textContent = `body{font-family:Arial,Helvetica,sans-serif;margin:24px;color:#111}
      .slip{border:2px solid #111;border-radius:12px;padding:20px;max-width:440px}
      h1{font-size:18px;margin:0 0 4px}.muted{color:#555;font-size:12px}
      .code{font-family:monospace;font-size:15px;font-weight:700;margin:12px 0 4px}
      .qr{display:block;margin:14px auto;width:240px;height:240px}
      table{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}
      td{padding:5px 0;vertical-align:top}td:first-child{color:#555;width:38%}
      .note{margin-top:14px;font-size:12px;line-height:1.5}`;
    doc.head.appendChild(style);
    const slip = doc.createElement('section');
    slip.className = 'slip';
    const title = doc.createElement('h1');
    title.textContent = 'PHIẾU GỬI HÀNG HOÀN — VELURA';
    const intro = doc.createElement('div');
    intro.className = 'muted';
    intro.textContent = 'Dán phiếu này lên ngoài kiện hàng trước khi ĐVVC lấy hàng.';
    const code = doc.createElement('div');
    code.className = 'code';
    code.textContent = detail.returnCode;
    const image = doc.createElement('img');
    image.className = 'qr';
    image.src = qr;
    image.alt = 'QR phiếu hoàn';
    const table = doc.createElement('table');
    const addRow = (label: string, value: unknown): void => {
      const row = doc.createElement('tr');
      const key = doc.createElement('td');
      key.textContent = label;
      const cell = doc.createElement('td');
      cell.textContent = String(value ?? '');
      row.append(key, cell);
      table.appendChild(row);
    };
    addRow('Đơn gốc', detail.orderCode || '—');
    addRow('Khách hàng', [detail.customerName, detail.customerPhone].filter(Boolean).join(' · ') || '—');
    addRow('ĐVVC', detail.shipment?.carrier || '—');
    addRow('Mã vận đơn', detail.shipment?.trackingCode || '—');
    addRow('Người gửi', [detail.customerName, detail.customerPhone, detail.customerAddress].filter(Boolean).join(' · ') || '—');
    addRow('Người nhận', 'Kho Velura — địa chỉ theo hợp đồng ĐVVC');
    const note = doc.createElement('div');
    note.className = 'note';
    note.textContent = 'Kho Velura chỉ nhận hàng khi mã QR và mã phiếu khớp. Bạn nên quay video đóng gói; ĐVVC chụp ảnh kiện hàng niêm phong khi lấy hàng.';
    slip.append(title, intro, code, image, table, note);
    doc.body.appendChild(slip);
    windowRef.focus();
    windowRef.setTimeout(() => windowRef.print(), 100);
  }

  private async uploadAll(files: File[], kind: 'packing_photo' | 'packing_video'): Promise<void> {
    if (!files.length || !this.model.uploadReturnEvidence) return;
    this.uploading.set(true);
    this.uploadError.set('');
    this.uploadNote.set('');
    try {
      for (const file of files) {
        await this.model.uploadReturnEvidence(this.returnId(), file, kind);
      }
      this.uploadNote.set(`Đã lưu ${files.length} tệp bằng chứng.`);
      await this.load(this.returnId());
    } catch (error) {
      this.uploadError.set(error instanceof Error ? error.message : 'Chưa lưu được bằng chứng đóng gói.');
    } finally {
      this.uploading.set(false);
    }
  }

  private async makeLabelQr(detail: ReturnTrackingDetail): Promise<string> {
    const payload = `velura:return:1?id=${encodeURIComponent(detail.returnId)}&code=${encodeURIComponent(detail.returnCode)}`;
    return toDataURL(payload, { width: 560, margin: 2, errorCorrectionLevel: 'M' }).catch(() => '');
  }
}
