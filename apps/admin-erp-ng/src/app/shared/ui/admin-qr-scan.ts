import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, effect, inject, input, output, signal, viewChild } from '@angular/core';
import jsQR from 'jsqr';
import { AdminErpModal } from './admin-modal';
import { AdminErpQrCode } from './admin-qr-code';

/**
 * Một hộp quét dùng chung: camera sau (điện thoại), ảnh QR đã chụp, hoặc dán nội dung.
 *
 * Component không hiểu nội dung mã — caller phân tích bằng `core/admin-erp-qr.ts` và quyết định
 * điền vào đâu. `sample` cho phép hiện một mã mẫu để thử máy quét khi chưa có label thật.
 */
@Component({
  selector: 'app-erp-qr-scan',
  imports: [AdminErpModal, AdminErpQrCode],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-erp-modal [open]="open()" [title]="title()" size="md" (closed)="dismiss()">
      <div class="scan">
        <div class="scan__stage" [class.scan__stage--ready]="cameraReady()">
          <video #video playsinline muted></video>
          <canvas #frame hidden></canvas>
          @if (!cameraReady()) {
            <p class="scan__placeholder">Camera chưa sẵn sàng. Dùng ảnh QR hoặc dán mã bên dưới.</p>
          }
        </div>
        <p class="scan__hint">{{ hint() }}</p>

        @if (error()) {
          <p class="scan__error" role="alert">{{ error() }}</p>
        }

        <div class="scan__actions">
          <label class="erp-btn erp-btn--sm">
            Tải ảnh QR
            <input type="file" accept="image/*" capture="environment" (change)="onFile($event)" hidden />
          </label>
          @if (sample()) {
            <button class="erp-btn erp-btn--sm" type="button" (click)="sampleOpen.set(!sampleOpen())">
              {{ sampleOpen() ? 'Ẩn mã mẫu' : 'Mã mẫu' }}
            </button>
          }
        </div>

        @if (sampleOpen() && sample()) {
          <app-erp-qr-code [value]="sample()" [caption]="sampleCaption() || 'Mã mẫu — quét thử bằng camera hoặc tải ảnh này'" />
        }

        <label class="erp-field">
          <span>Hoặc dán nội dung mã</span>
          <textarea class="erp-input" rows="2" [value]="manual()" (input)="onManual($event)" placeholder="velura:shipment:1?… hoặc link /orders?focus=…"></textarea>
        </label>
      </div>
      <div footer>
        <button class="erp-btn" type="button" (click)="dismiss()">Đóng</button>
        @if (sample()) {
          <button class="erp-btn" type="button" (click)="useSample()">Dùng mã mẫu (demo)</button>
        }
        <button class="erp-btn erp-btn--primary" type="button" (click)="submitManual()">Dùng nội dung này</button>
      </div>
    </app-erp-modal>
  `,
  styles: [
    `
      .scan {
        display: grid;
        gap: 10px;
      }
      .scan__stage {
        position: relative;
        display: grid;
        place-items: center;
        min-height: 220px;
        overflow: hidden;
        border: 1px dashed var(--erp-line);
        border-radius: var(--erp-radius-sm);
        background: var(--erp-surface-muted);
      }
      .scan__stage video {
        width: 100%;
        max-height: 340px;
        object-fit: cover;
      }
      .scan__stage:not(.scan__stage--ready) video {
        display: none;
      }
      .scan__placeholder {
        margin: 0;
        padding: 16px;
        color: var(--erp-text-muted);
        font-size: 0.82rem;
        text-align: center;
      }
      .scan__hint {
        margin: 0;
        color: var(--erp-text-muted);
        font-size: 0.8rem;
      }
      .scan__error {
        margin: 0;
        color: var(--erp-danger-text, #b3261e);
        font-size: 0.82rem;
      }
      .scan__actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
    `,
  ],
})
export class AdminErpQrScan {
  readonly open = input(false);
  readonly title = input('Quét mã QR');
  readonly hint = input('Đưa mã vào khung hình, hoặc tải ảnh QR / dán nội dung mã.');
  readonly sample = input('');
  readonly sampleCaption = input('');
  readonly scanned = output<string>();
  readonly closed = output<void>();

  readonly error = signal<string | null>(null);
  readonly cameraReady = signal(false);
  readonly sampleOpen = signal(false);
  readonly manual = signal('');

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly frame = viewChild<ElementRef<HTMLCanvasElement>>('frame');
  private stream: MediaStream | null = null;
  private timer: number | null = null;

  constructor() {
    effect(() => {
      const element = this.video()?.nativeElement;
      if (!this.open()) {
        this.stop();
        return;
      }
      if (element) void this.start(element);
    });
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  onManual(event: Event): void {
    this.manual.set((event.target as HTMLTextAreaElement).value);
  }

  /**
   * Accepts the pasted payload through the same path as a camera hit.
   */
  submitManual(): void {
    const text = this.manual().trim();
    if (text.length < 4) {
      this.error.set('Nội dung mã quá ngắn. Kiểm lại mã hoặc quét bằng camera.');
      return;
    }
    this.accept(text);
  }

  /**
   * Applies the sample payload directly, so a demo on a machine without a camera still walks
   * the same fill path the camera uses.
   */
  useSample(): void {
    const sample = this.sample();
    if (sample) this.accept(sample);
  }

  /**
   * Decodes a photo of the label; on phones this opens the rear camera directly.
   */
  async onFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.error.set(null);
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('canvas');
      context.drawImage(bitmap, 0, 0);
      const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
      if (!code?.data) {
        this.error.set('Không đọc được mã trong ảnh này. Chụp gần hơn hoặc dùng mã mẫu để kiểm tra camera.');
        return;
      }
      this.accept(code.data);
    } catch {
      this.error.set('Không mở được ảnh. Thử ảnh khác.');
    }
  }

  dismiss(): void {
    this.stop();
    this.closed.emit();
  }

  private async start(video: HTMLVideoElement): Promise<void> {
    if (this.stream) return;
    this.error.set(null);
    this.cameraReady.set(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      this.error.set('Thiết bị này không mở được camera trong trình duyệt. Dùng ảnh QR hoặc dán mã.');
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      video.srcObject = this.stream;
      await video.play();
      this.cameraReady.set(true);
      this.timer = window.setInterval(() => this.tick(video), 260);
    } catch {
      this.error.set('Không mở được camera (có thể chưa cấp quyền). Dùng ảnh QR hoặc dán mã bên dưới.');
    }
  }

  private tick(video: HTMLVideoElement): void {
    const canvas = this.frame()?.nativeElement;
    if (!canvas || video.readyState < 2 || !video.videoWidth) return;
    if (canvas.width !== video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
    if (code?.data) this.accept(code.data);
  }

  private accept(text: string): void {
    this.stop();
    this.scanned.emit(text);
  }

  private stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    const video = this.video()?.nativeElement;
    if (video) video.srcObject = null;
    this.cameraReady.set(false);
  }
}
