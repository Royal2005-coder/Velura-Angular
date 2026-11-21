import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, effect, inject, input, output, signal, viewChild } from '@angular/core';
import jsQR from 'jsqr';
import { AdminErpModal } from './admin-modal';
import { AdminErpQrCode } from './admin-qr-code';

const DEFAULT_SCAN_STEPS: readonly string[] = [
  'Đưa camera vào mã QR trên label của ĐVVC, giữ mã nằm trọn trong khung và đủ sáng.',
  'Camera không dùng được thì tải ảnh label hoặc dán nội dung mã bên dưới.',
  'Sau khi quét, mã đơn, ĐVVC, mã vận đơn, tracking URL và người giao được khóa lại để bàn giao đúng label.',
];

/** Minimal typing for the browser BarcodeDetector API (Chrome/Edge/Android). */
interface NativeBarcodeDetector {
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue?: string }>>;
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): NativeBarcodeDetector;
}

function createBarcodeDetector(): NativeBarcodeDetector | null {
  try {
    const ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
    return typeof ctor === 'function' ? new ctor({ formats: ['qr_code'] }) : null;
  } catch {
    return null;
  }
}

/** Longest edge decoded from a camera frame or uploaded photo; jsQR cost grows with pixels. */
const MAX_SCAN_WIDTH = 480;
const MAX_PHOTO_WIDTH = 1600;
const SCAN_INTERVAL_MS = 350;

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
    <app-erp-modal [open]="open()" [title]="title()" size="md" [elevated]="true" (closed)="dismiss()">
      <div class="scan">
        <ol class="scan__steps">
          @for (step of steps(); track step) {
            <li>{{ step }}</li>
          }
        </ol>
        @if (error()) {
          <p class="scan__error" role="alert">{{ error() }}</p>
        }
        <div class="scan__stage" [class.scan__stage--ready]="cameraReady()">
          <video #video playsinline muted></video>
          <canvas #frame hidden></canvas>
          @if (cameraReady()) {
            <div class="scan__reticle" aria-hidden="true"></div>
            <span class="scan__live-pill" aria-hidden="true">Đang quét QR tự động…</span>
          } @else {
            <p class="scan__placeholder">Camera chưa sẵn sàng. Dùng ảnh QR hoặc dán mã bên dưới.</p>
          }
        </div>
        <p class="scan__hint">{{ hint() }}</p>

        <div class="scan__actions">
          <label class="erp-btn erp-btn--sm">
            Tải ảnh QR
            <input type="file" accept="image/*" (change)="onFile($event)" hidden />
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
      .scan__steps {
        margin: 0;
        padding-left: 18px;
        display: grid;
        gap: 2px;
        color: var(--erp-text-muted);
        font-size: 0.8rem;
      }
      .scan__stage {
        position: relative;
        display: grid;
        place-items: center;
        min-height: 200px;
        max-height: 260px;
        overflow: hidden;
        border: 1px dashed var(--erp-line);
        border-radius: var(--erp-radius-sm);
        background: var(--erp-surface-muted);
      }
      .scan__stage video {
        width: 100%;
        height: 240px;
        max-height: 260px;
        object-fit: cover;
      }
      .scan__reticle {
        position: absolute;
        width: 156px;
        height: 156px;
        border: 2px solid rgba(255, 255, 255, 0.9);
        border-radius: 14px;
        box-shadow: 0 0 0 9999px rgba(18, 12, 16, 0.28);
        pointer-events: none;
      }
      .scan__live-pill {
        position: absolute;
        bottom: 10px;
        left: 50%;
        transform: translateX(-50%);
        padding: 4px 12px;
        border-radius: 999px;
        background: rgba(18, 12, 16, 0.72);
        color: #fff;
        font-size: 0.75rem;
        font-weight: 500;
        white-space: nowrap;
        pointer-events: none;
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
        padding: 8px 12px;
        border-radius: 8px;
        background: #fef2f2;
        border: 1px solid #fecaca;
        color: var(--erp-danger-text, #b91c1c);
        font-size: 0.82rem;
        font-weight: 500;
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
  /** Caller-specific instructions; the default copy describes a carrier label. */
  readonly steps = input<readonly string[]>(DEFAULT_SCAN_STEPS);
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
  private starting = false;
  private scanningFrame = false;
  private detectorFailed = false;
  private readonly detector = createBarcodeDetector();
  /** Invalidates a getUserMedia promise that resolves after the modal was closed. */
  private session = 0;

  constructor() {
    effect(() => {
      const element = this.video()?.nativeElement;
      if (!this.open()) {
        this.stop();
        return;
      }
      if (element) void this.start(element, ++this.session);
    });
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  onManual(event: Event): void {
    this.error.set(null);
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
      if (this.detector) {
        try {
          const hits = await this.detector.detect(bitmap);
          const hit = hits.find((item) => item.rawValue)?.rawValue;
          if (hit) {
            bitmap.close();
            this.accept(hit);
            return;
          }
        } catch {
          // Fall back to jsQR decoding below.
        }
      }
      const scale = Math.min(1, MAX_PHOTO_WIDTH / Math.max(bitmap.width, 1));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('canvas');
      context.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
      const image = context.getImageData(0, 0, width, height);
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

  private async start(video: HTMLVideoElement, session: number): Promise<void> {
    if (this.stream || this.starting) return;
    this.starting = true;
    this.error.set(null);
    this.cameraReady.set(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      this.starting = false;
      this.error.set('Thiết bị này không mở được camera trong trình duyệt. Dùng ảnh QR hoặc dán mã.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      if (session !== this.session || !this.open()) {
        for (const track of stream.getTracks()) track.stop();
        this.starting = false;
        return;
      }
      this.stream = stream;
      video.srcObject = stream;
      await video.play();
      if (session !== this.session || !this.open()) {
        this.stop();
        return;
      }
      this.cameraReady.set(true);
      this.scheduleNext(video, session);
    } catch {
      if (session === this.session && this.open()) {
        this.error.set('Không mở được camera (có thể chưa cấp quyền). Dùng ảnh QR hoặc dán mã bên dưới.');
      }
    } finally {
      this.starting = false;
    }
  }

  /**
   * Schedules the next frame scan after the previous one settles so the main thread
   * always stays responsive for clicks, typing, and modal controls.
   */
  private scheduleNext(video: HTMLVideoElement, session: number): void {
    if (session !== this.session || !this.open()) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.tick(video, session);
    }, SCAN_INTERVAL_MS);
  }

  private async tick(video: HTMLVideoElement, session: number): Promise<void> {
    if (this.scanningFrame || session !== this.session || !this.open()) return;
    const canvas = this.frame()?.nativeElement;
    if (!canvas || video.readyState < 2 || !video.videoWidth) {
      this.scheduleNext(video, session);
      return;
    }
    this.scanningFrame = true;
    try {
      if (this.detector && !this.detectorFailed) {
        try {
          const hits = await this.detector.detect(video);
          const hit = hits.find((item) => item.rawValue)?.rawValue;
          if (hit && this.open()) {
            this.accept(hit);
            return;
          }
          // Native BarcodeDetector runs off-thread; skip synchronous jsQR to keep UI responsive.
          return;
        } catch {
          this.detectorFailed = true;
        }
      }
      const scale = Math.min(1, MAX_SCAN_WIDTH / video.videoWidth);
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return;
      context.drawImage(video, 0, 0, width, height);
      const image = context.getImageData(0, 0, width, height);
      const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
      if (code?.data && this.open()) {
        this.accept(code.data);
        return;
      }
    } finally {
      this.scanningFrame = false;
      if (session === this.session && this.open()) {
        this.scheduleNext(video, session);
      }
    }
  }

  private accept(text: string): void {
    this.stop();
    this.scanned.emit(text);
  }

  private stop(): void {
    this.session++;
    this.starting = false;
    this.scanningFrame = false;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
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
