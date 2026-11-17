import { ChangeDetectionStrategy, Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';

/** Normalized focal-point and zoom coordinates shared between Admin ERP cropper and Storefront hero surfaces. */
export interface AdminMediaFraming {
  readonly posX: number;
  readonly posY: number;
  readonly zoom: number;
}

interface DragOrigin {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly startX: number;
  readonly startY: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Interactive drag-to-reposition (`kéo lên/xuống/trái/phải`) and zoom/crop (`cắt ra/vô`) stage
 * rendered at the exact Storefront target aspect ratio so portraits and panoramic covers never chop off heads.
 */
@Component({
  selector: 'app-erp-image-cropper',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cropper">
      <div
        #stage
        class="cropper__stage"
        [class.is-dragging]="dragging()"
        [style.aspect-ratio]="aspectRatio()"
        tabindex="0"
        role="application"
        aria-label="Khung kéo căn vị trí và thu phóng ảnh. Dùng chuột kéo hoặc phím mũi tên để chỉnh vị trí, phím cộng trừ để phóng to thu nhỏ."
        data-testid="cropper-stage"
        (pointerdown)="onPointerDown($event)"
        (pointermove)="onPointerMove($event)"
        (pointerup)="onPointerUp($event)"
        (pointercancel)="onPointerUp($event)"
        (keydown)="onKeydown($event)"
      >
        @if (mediaType() === 'video') {
          <video
            class="cropper__media"
            [src]="src()"
            muted
            loop
            playsinline
            autoplay
            [style.object-position]="objectPosition()"
            [style.transform-origin]="objectPosition()"
            [style.transform]="transformStyle()"
            (loadedmetadata)="onVideoMetadata($event)"
            (error)="imageError.emit()"
          ></video>
        } @else {
          <img
            class="cropper__media"
            [src]="src()"
            [alt]="alt()"
            draggable="false"
            [style.object-position]="objectPosition()"
            [style.transform-origin]="objectPosition()"
            [style.transform]="transformStyle()"
            (load)="onImageLoad($event)"
            (error)="imageError.emit()"
          />
        }

        <div class="cropper__grid" aria-hidden="true">
          <span></span><span></span><span></span>
          <span></span><span></span><span></span>
          <span></span><span></span><span></span>
        </div>

        <div class="cropper__hud" aria-hidden="true">
          <span class="cropper__badge">Kéo ảnh để căn khung</span>
          <span class="cropper__coords">X {{ safeX() }}% · Y {{ safeY() }}% · {{ zoomPercent() }}%</span>
        </div>
      </div>

      <div class="cropper__toolbar">
        <div class="cropper__zoom">
          <span class="cropper__label">Cắt / Phóng</span>
          <button
            type="button"
            class="erp-btn erp-btn--sm cropper__step"
            aria-label="Thu nhỏ"
            [disabled]="safeZoom() <= 1"
            (click)="stepZoom(-0.1)"
          >
            −
          </button>
          <input
            type="range"
            class="cropper__slider"
            min="1"
            max="2.4"
            step="0.05"
            aria-label="Mức thu phóng ảnh"
            data-testid="cropper-zoom"
            [value]="safeZoom()"
            (input)="onZoomSlider($event)"
          />
          <button
            type="button"
            class="erp-btn erp-btn--sm cropper__step"
            aria-label="Phóng to"
            [disabled]="safeZoom() >= 2.4"
            (click)="stepZoom(0.1)"
          >
            +
          </button>
          <span class="cropper__zoom-val">{{ zoomPercent() }}%</span>
        </div>

        <div class="cropper__presets" role="group" aria-label="Góc căn nhanh">
          <button
            type="button"
            class="cropper__preset"
            [class.is-active]="isPresetActive(50, 14)"
            data-testid="cropper-preset-head"
            (click)="applyPreset(50, 14)"
          >
            Đầu mẫu
          </button>
          <button
            type="button"
            class="cropper__preset"
            [class.is-active]="isPresetActive(50, 28)"
            (click)="applyPreset(50, 28)"
          >
            1/3 trên
          </button>
          <button
            type="button"
            class="cropper__preset"
            [class.is-active]="isPresetActive(50, 50)"
            data-testid="cropper-preset-center"
            (click)="applyPreset(50, 50)"
          >
            Chính giữa
          </button>
          <button
            type="button"
            class="cropper__preset"
            [class.is-active]="isPresetActive(50, 82)"
            (click)="applyPreset(50, 82)"
          >
            Chân ảnh
          </button>
          <button type="button" class="cropper__preset cropper__preset--reset" data-testid="cropper-reset" (click)="resetFraming()">
            Đặt lại
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
      }
      .cropper {
        display: grid;
        gap: 8px;
        padding: 10px;
        border: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-md);
        background: var(--erp-surface-muted);
      }
      .cropper__stage {
        position: relative;
        width: 100%;
        min-height: 150px;
        max-height: 280px;
        overflow: hidden;
        border: 1px solid var(--erp-line-strong);
        border-radius: var(--erp-radius-sm);
        background: #1e293b;
        cursor: grab;
        touch-action: none;
        user-select: none;
      }
      .cropper__stage.is-dragging {
        cursor: grabbing;
      }
      .cropper__stage:focus-visible {
        outline: 2px solid var(--erp-accent);
        outline-offset: 2px;
      }
      .cropper__media {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
        pointer-events: none;
        will-change: transform, object-position;
      }
      .cropper__grid {
        position: absolute;
        inset: 0;
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        grid-template-rows: repeat(3, 1fr);
        pointer-events: none;
        opacity: 0;
        transition: opacity 140ms ease;
      }
      .cropper__stage:hover .cropper__grid,
      .cropper__stage:focus-visible .cropper__grid,
      .cropper__stage.is-dragging .cropper__grid {
        opacity: 1;
      }
      .cropper__grid span {
        border-right: 1px solid rgba(255, 255, 255, 0.28);
        border-bottom: 1px solid rgba(255, 255, 255, 0.28);
      }
      .cropper__grid span:nth-child(3n) {
        border-right: 0;
      }
      .cropper__grid span:nth-child(n + 7) {
        border-bottom: 0;
      }
      .cropper__hud {
        position: absolute;
        inset-inline: 8px;
        bottom: 8px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        pointer-events: none;
      }
      .cropper__badge,
      .cropper__coords {
        padding: 3px 8px;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.72);
        backdrop-filter: blur(4px);
        color: #fff;
        font-size: 11px;
        font-weight: 600;
        line-height: 1.3;
      }
      .cropper__coords {
        font-family: var(--erp-font-mono);
        font-variant-numeric: tabular-nums;
      }
      .cropper__toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .cropper__zoom {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex: 1 1 240px;
      }
      .cropper__label {
        color: var(--erp-muted);
        font-size: 12px;
        font-weight: 600;
        white-space: nowrap;
      }
      .cropper__step {
        width: 28px;
        min-height: 28px;
        padding: 0;
        font-family: var(--erp-font-mono);
      }
      .cropper__slider {
        flex: 1 1 110px;
        min-width: 90px;
        accent-color: var(--erp-accent);
        cursor: pointer;
      }
      .cropper__zoom-val {
        min-width: 42px;
        text-align: right;
        font-family: var(--erp-font-mono);
        font-variant-numeric: tabular-nums;
        font-size: 12px;
        font-weight: 600;
        color: var(--erp-ink);
      }
      .cropper__presets {
        display: inline-flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
      }
      .cropper__preset {
        min-height: 28px;
        padding: 0 9px;
        border: 1px solid var(--erp-line-strong);
        border-radius: var(--erp-radius-sm);
        background: var(--erp-surface);
        color: var(--erp-ink);
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
      }
      .cropper__preset:hover {
        border-color: var(--erp-control-border);
        background: var(--erp-surface-muted);
      }
      .cropper__preset.is-active {
        border-color: var(--erp-accent);
        background: var(--erp-accent-soft);
        color: var(--erp-accent-strong);
      }
      .cropper__preset--reset {
        color: var(--erp-muted);
      }
    `,
  ],
})
export class AdminErpImageCropper {
  readonly src = input.required<string>();
  readonly mediaType = input<'image' | 'video'>('image');
  readonly aspectRatio = input('3 / 1');
  readonly posX = input(50);
  readonly posY = input(16);
  readonly zoom = input(1);
  readonly defaultPosY = input(16);
  readonly alt = input('Xem trước khung hình');

  readonly framingChange = output<AdminMediaFraming>();
  readonly imageError = output<void>();

  protected readonly dragging = signal(false);
  private readonly naturalRatio = signal<number | null>(null);
  private readonly stageRef = viewChild<ElementRef<HTMLElement>>('stage');
  private dragOrigin: DragOrigin | null = null;

  protected readonly safeX = computed(() => clampRound(this.posX(), 50, 0, 100, 10));
  protected readonly safeY = computed(() => clampRound(this.posY(), this.defaultPosY(), 0, 100, 10));
  protected readonly safeZoom = computed(() => clampRound(this.zoom(), 1, 1, 2.4, 100));
  protected readonly zoomPercent = computed(() => Math.round(this.safeZoom() * 100));
  protected readonly objectPosition = computed(() => `${this.safeX()}% ${this.safeY()}%`);
  protected readonly transformStyle = computed(() => {
    const z = this.safeZoom();
    return z > 1.001 ? `scale(${z})` : null;
  });

  protected onImageLoad(event: Event): void {
    const img = event.target as HTMLImageElement;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      this.naturalRatio.set(img.naturalWidth / img.naturalHeight);
    }
  }

  protected onVideoMetadata(event: Event): void {
    const video = event.target as HTMLVideoElement;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      this.naturalRatio.set(video.videoWidth / video.videoHeight);
    }
  }

  /** Starts a pointer-captured pan gesture on the stage. */
  onPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const stage = this.stageRef()?.nativeElement;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    event.preventDefault();
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic PointerEvents in headless unit tests do not register active pointer IDs.
    }
    this.dragOrigin = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      startX: this.safeX(),
      startY: this.safeY(),
      width: rect.width,
      height: rect.height,
    };
    this.dragging.set(true);
  }

  /** Updates focal coordinates smoothly as the operator drags across the stage. */
  onPointerMove(event: PointerEvent): void {
    const origin = this.dragOrigin;
    if (!origin || origin.pointerId !== event.pointerId) return;
    const dx = event.clientX - origin.clientX;
    const dy = event.clientY - origin.clientY;
    const zoom = this.safeZoom();
    const sensitivity = 1.35;

    const stageRatio = origin.width / origin.height;
    const mediaRatio = this.naturalRatio();
    // At 1.0x zoom, only pan along an axis that actually overflows `object-fit: cover` so non-overflowing axis stays centered.
    const canPanX = zoom > 1.001 || mediaRatio === null || mediaRatio > stageRatio + 0.02;
    const canPanY = zoom > 1.001 || mediaRatio === null || mediaRatio < stageRatio - 0.02;

    const nextX = canPanX
      ? clampRound(origin.startX - (dx / origin.width) * (100 / zoom) * sensitivity, origin.startX, 0, 100, 10)
      : origin.startX;
    const nextY = canPanY
      ? clampRound(origin.startY - (dy / origin.height) * (100 / zoom) * sensitivity, origin.startY, 0, 100, 10)
      : origin.startY;

    this.emitFraming(nextX, nextY, zoom);
  }

  /** Releases pointer capture at the end of a pan gesture. */
  onPointerUp(event: PointerEvent): void {
    const origin = this.dragOrigin;
    if (!origin || origin.pointerId !== event.pointerId) return;
    const stage = this.stageRef()?.nativeElement;
    if (stage) {
      try {
        stage.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore synthetic test pointers.
      }
    }
    this.dragOrigin = null;
    this.dragging.set(false);
  }

  /** Keyboard framing nudges (never intercepts Escape so modal overlay stack works uninterrupted). */
  onKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 5 : 2;
    let x = this.safeX();
    let y = this.safeY();
    let z = this.safeZoom();

    if (event.key === 'ArrowUp') y = clampRound(y - step, y, 0, 100, 10);
    else if (event.key === 'ArrowDown') y = clampRound(y + step, y, 0, 100, 10);
    else if (event.key === 'ArrowLeft') x = clampRound(x - step, x, 0, 100, 10);
    else if (event.key === 'ArrowRight') x = clampRound(x + step, x, 0, 100, 10);
    else if (event.key === '+' || event.key === '=') z = clampRound(z + 0.05, z, 1, 2.4, 100);
    else if (event.key === '-' || event.key === '_') z = clampRound(z - 0.05, z, 1, 2.4, 100);
    else return;

    event.preventDefault();
    this.emitFraming(x, y, z);
  }

  protected onZoomSlider(event: Event): void {
    const val = Number.parseFloat((event.target as HTMLInputElement).value);
    this.emitFraming(this.safeX(), this.safeY(), clampRound(val, 1, 1, 2.4, 100));
  }

  /** Adjusts zoom multiplier by `delta` (`+0.1` / `-0.1`). */
  stepZoom(delta: number): void {
    const next = clampRound(this.safeZoom() + delta, 1, 1, 2.4, 100);
    this.emitFraming(this.safeX(), this.safeY(), next);
  }

  /** Applies a quick vertical/horizontal framing preset while keeping current zoom. */
  applyPreset(x: number, y: number): void {
    this.emitFraming(x, y, this.safeZoom());
  }

  /** Restores default fashion framing (`50%`, `defaultPosY`, `1.0x`). */
  resetFraming(): void {
    this.emitFraming(50, clampRound(this.defaultPosY(), 16, 0, 100, 10), 1);
  }

  protected isPresetActive(x: number, y: number): boolean {
    return Math.abs(this.safeX() - x) < 1 && Math.abs(this.safeY() - y) < 1.5;
  }

  private emitFraming(posX: number, posY: number, zoom: number): void {
    this.framingChange.emit({ posX, posY, zoom });
  }
}

function clampRound(value: number, fallback: number, min: number, max: number, factor: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const clamped = Math.min(max, Math.max(min, value));
  return Math.round(clamped * factor) / factor;
}
