import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { ApiService, UserIdentity } from '../../core/services/api.service';
import { guestSessionId } from '../../core/utils/guest-session';
import {
  AiCapabilities,
  AiEngineService,
  AiJob,
  AiTask,
  StudioAsset,
} from '../../core/services/ai-engine.service';
export interface VtoScenario {
  id: string;
  label: string;
  icon: string;
  badge: string;
  description: string;
  theme: 'light' | 'dark' | 'warm' | 'cool';
  backgroundGradient: string;
  lightingTone: string;
  vignetteStyle: string;
  podiumStyle: string;
  floorTexture: string;
  wallBackTexture: string;
  wallSideTexture: string;
  ceilingTexture: string;
  spotlightBeam: string;
}

export const VTO_SCENARIOS: VtoScenario[] = [
  {
    id: 'basic',
    label: 'Studio Chuẩn',
    icon: 'studio',
    badge: 'Atelier',
    description: 'Phông nền Trắng ngà Studio Atelier tối giản cao cấp',
    theme: 'light',
    backgroundGradient: 'radial-gradient(circle at 50% 30%, #FFFFFF 0%, #FAF6F0 50%, #ECE4DB 100%)',
    lightingTone: 'rgba(255, 255, 255, 0.4)',
    vignetteStyle: 'radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(122, 40, 60, 0.06) 100%)',
    podiumStyle: 'radial-gradient(ellipse at 50% 50%, rgba(200, 185, 175, 0.45) 0%, rgba(200, 185, 175, 0.15) 50%, transparent 70%)',
    floorTexture: 'linear-gradient(45deg, #E6DDD4 25%, transparent 25%), linear-gradient(-45deg, #E6DDD4 25%, transparent 25%), #F4EDE6',
    wallBackTexture: 'radial-gradient(circle at 50% 45%, #FFFFFF 0%, #FAF6F0 55%, #ECE4DB 100%)',
    wallSideTexture: 'linear-gradient(to right, #ECE4DB, #F5EFE8)',
    ceilingTexture: 'radial-gradient(circle at 50% 50%, #FFFFFF, #E2D9CE)',
    spotlightBeam: 'radial-gradient(ellipse at 50% 0%, rgba(255, 255, 255, 0.45) 0%, transparent 75%)',
  },
];

/** Consent-first image workflow with interactive 3D 360 perspective, rich studio scenes, and female-only models. */
@Component({
  selector: 'app-ai-image-workbench',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './ai-image-workbench.html',
  styleUrl: './ai-image-workbench.css',
})
export class AiImageWorkbench {
  readonly titleId = `ai-title-${crypto.randomUUID()}`;
  readonly task = input<AiTask>('virtual_try_on');
  readonly productId = input<string>('');
  readonly variantId = input<string>('');
  readonly hideTrigger = input<boolean>(false);
  /** Published products surviving the catalog's current filters; undefined leaves retrieval unrestricted. */
  readonly candidateProductIds = input<string[] | undefined>();
  readonly matches = output<string[]>();
  private readonly model = inject(AiEngineService);
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly destroy = inject(DestroyRef);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  readonly capabilities = signal<AiCapabilities | null>(null);
  readonly verifiedMember = signal(false);
  private capabilitiesEpoch = 0;
  /**
   * Whether the entry point is shown at all. Virtual try-on is offered only for products the server has
   * verified (flat-lay garment photo, supported category); unsupported items such as accessories get no button.
   * Other tasks are always offered.
   */
  readonly offered = signal(false);
  /** Try-on uses personal photos stored per account, so only signed-in users may use it. */
  readonly memberRequired = computed(
    () => this.task() === 'virtual_try_on' && !this.auth.isLoggedIn(),
  );
  readonly error = signal('');
  readonly consent = signal(false);
  readonly mode = signal<'personal' | 'studio'>('personal');
  readonly studio = signal('');
  readonly studioImage = signal('');
  readonly studioLoading = signal(false);
  private studioGeneration = 0;
  readonly preview = signal('');
  readonly result = signal('');
  /** Studio 3D: blob URLs of the turntable frames, indexed by orbit angle. */
  readonly frames3d = signal<string[]>([]);
  readonly has3d = computed(() => this.frames3d().length >= 12);
  /** Set when published frames could not be downloaded/decoded; the 2D try-on stays usable. */
  readonly frames3dFailed = signal(false);
  readonly frameSrc = computed(() => {
    const frames = this.frames3d();
    if (!frames.length) return this.result();
    const index = Math.round((((this.orbitAngle() % 360) + 360) % 360) / (360 / frames.length)) % frames.length;
    return frames[index];
  });
  readonly busy = signal(false);
  readonly job = signal<AiJob | null>(null);
  readonly qualityPassed = signal(false);
  readonly qualityWarning = signal<string | null>(null);
  readonly crop = signal({ x: 0, y: 0, width: 100, height: 100 });

  // --- STUDIO PRESETS & FILTERS (LOCKED EXCLUSIVELY TO FEMALE MODELS) ---
  readonly selectedGender = signal<'female'>('female');
  /** One fixed studio backdrop; scene/season presets were retired in favour of one model in many poses. */
  readonly activeScenario: VtoScenario = VTO_SCENARIOS[0];

  readonly filteredStudioAssets = computed(() =>
    (this.capabilities()?.studio_assets || []).filter((asset: StudioAsset) => asset.gender === 'female'),
  );

  modelDisplayTitle(asset: StudioAsset): string {
    return (
      asset.label
        .replace(/^(Người mẫu\s*)?(Nữ|Nam)\s*[-–]?\s*(Bối cảnh\s*)?/i, '')
        .replace(/\s*\/\s*(Đi làm|Đi học|Đi chơi|Party|Sang trọng)/i, '')
        .trim() || asset.label
    );
  }

  // --- LIFECYCLE (spec 3.1.8) — derived from real state, never from elapsed time ---
  readonly lifecycleSteps = ['Chọn ảnh', 'Kiểm tra ảnh', 'Xác nhận', 'Đang xử lý', 'Kết quả'] as const;
  /** 1-based current step: input → validation → preview/confirm → processing → result. */
  readonly lifecycleStep = computed(() => {
    const job = this.job();
    if (this.result()) return 5;
    if (job?.task === 'virtual_try_on' && (job.status === 'queued' || job.status === 'running')) return 4;
    const hasInput = this.mode() === 'studio' ? !!this.studioImage() : !!this.preview();
    if (!hasInput) return 1;
    // Studio models are operator-verified, so they skip the photo quality gate.
    return this.mode() === 'studio' || this.qualityPassed() ? 3 : 2;
  });
  /** Seconds since the current job started; shown against the 2-minute VTO-09 budget, not used to fake progress. */
  readonly loadingSeconds = signal<number>(0);
  /** Studio try-on requests the 360° add-on; personal photos stay 2D. */
  readonly expects3d = computed(() => this.task() === 'virtual_try_on' && this.mode() === 'studio');
  readonly processingTitle = computed(() =>
    this.job()?.task === 'image_quality' ? 'Đang kiểm tra ảnh' : 'AI đang thử đồ',
  );
  readonly processingMessage = computed(() => {
    const job = this.job();
    if (!job) return 'Đang tải ảnh lên an toàn...';
    if (job.status === 'queued') return 'Đang chờ đến lượt xử lý trên GPU...';
    return job.task === 'image_quality'
      ? 'Đang kiểm tra độ nét, ánh sáng và dáng người...'
      : 'Đang phối trang phục lên ảnh — tối đa 2 phút.';
  });
  readonly elapsedLabel = computed(() => {
    const s = this.loadingSeconds();
    const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    return this.job()?.task === 'virtual_try_on' && this.job()?.status === 'running' ? `${clock} / 2:00` : clock;
  });
  /** Honest note about the 360° add-on once the 2D result is on screen. */
  readonly stage3dNote = computed<{ tone: 'info' | 'warn'; text: string } | null>(() => {
    const job = this.job();
    if (!this.expects3d() || !this.result() || job?.task !== 'virtual_try_on' || this.has3d()) return null;
    if (job.stage3d === 'pending') return { tone: 'info', text: 'Đang dựng góc nhìn 360° từ ảnh thử đồ...' };
    if (job.stage3d === 'failed' || this.frames3dFailed())
      return { tone: 'warn', text: 'Chưa dựng được góc nhìn 360°. Ảnh thử đồ vẫn dùng được.' };
    return null;
  });
  private loadingTimer: number | undefined;

  // --- 360° TURNTABLE VIEWER: rotation = choosing a real frame; the scene itself never rotates ---
  readonly showOriginal = signal<boolean>(false);
  readonly orbitAngle = signal<number>(0);
  readonly zoomLevel = signal<number>(1.0);
  readonly autoSpin = signal<boolean>(false);
  /** Auto-spin is not offered to users who asked the OS for reduced motion. */
  readonly reducedMotion =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  private isDragging3D = false;
  private dragStartX = 0;
  private dragStartAngle = 0;
  private autoSpinFrame: number | undefined;
  private lastAutoSpinTime = 0;

  readonly normalizedAngle = computed(() => ((this.orbitAngle() % 360) + 360) % 360);
  /** Drag/keyboard only make sense when real turntable frames are on screen. */
  readonly spinnable = computed(() => this.has3d() && !this.showOriginal());
  readonly roundedAngle = computed(() => Math.round(this.normalizedAngle()) % 360);

  readonly angleDisplayLabel = computed(() => {
    const a = this.roundedAngle();
    if (a <= 25 || a >= 335) return `${a}° · Mặt trước (Chính diện)`;
    if (a > 25 && a < 70) return `${a}° · Góc nghiêng 45° trái`;
    if (a >= 70 && a <= 110) return `${a}° · Cạnh trái (90°)`;
    if (a > 110 && a < 160) return `${a}° · Nghiêng sau trái (135°)`;
    if (a >= 160 && a <= 200) return `${a}° · Mặt sau (180°)`;
    if (a > 200 && a < 250) return `${a}° · Nghiêng sau phải (225°)`;
    if (a >= 250 && a <= 290) return `${a}° · Cạnh phải (270°)`;
    return `${a}° · Góc nghiêng 45° phải`;
  });

  readonly currentDisplayImage = computed(() => {
    if (this.showOriginal()) return this.mode() === 'personal' ? this.preview() : this.studioImage();
    // Real turntable frames replace the single render whenever the 3D stage produced them.
    return this.has3d() ? this.frameSrc() : this.result();
  });

  onStagePointerDown(event: PointerEvent): void {
    if (!this.spinnable() || this.busy()) return;
    this.isDragging3D = true;
    this.stopAutoSpin();
    this.dragStartX = event.clientX;
    this.dragStartAngle = this.orbitAngle();
    (event.currentTarget as HTMLElement)?.setPointerCapture?.(event.pointerId);
  }

  onStagePointerMove(event: PointerEvent): void {
    if (!this.isDragging3D || !this.spinnable()) return;
    const deltaX = event.clientX - this.dragStartX;
    // Same direction as auto-spin (angle grows), so dragging right continues the turn the user just watched.
    this.orbitAngle.set(((this.dragStartAngle + deltaX * 0.65) % 360 + 360) % 360);
  }

  onStagePointerUp(event: PointerEvent): void {
    if (!this.isDragging3D) return;
    this.isDragging3D = false;
    try {
      (event.currentTarget as HTMLElement)?.releasePointerCapture?.(event.pointerId);
    } catch {}
  }

  /** Arrow keys step exactly one published frame; Home returns to the front view. */
  onStageKeydown(event: KeyboardEvent): void {
    if (!this.spinnable()) return;
    const step = 360 / this.frames3d().length;
    if (event.key === 'ArrowLeft') this.setAnglePreset(this.orbitAngle() - step);
    else if (event.key === 'ArrowRight') this.setAnglePreset(this.orbitAngle() + step);
    else if (event.key === 'Home') this.setAnglePreset(0);
    else return;
    event.preventDefault();
  }

  setAnglePreset(angle: number): void {
    this.stopAutoSpin();
    this.orbitAngle.set((angle % 360 + 360) % 360);
  }

  toggleAutoSpin(): void {
    if (this.autoSpin()) {
      this.stopAutoSpin();
    } else {
      this.startAutoSpin();
    }
  }

  private startAutoSpin(): void {
    this.stopAutoSpin();
    if (this.reducedMotion || !this.spinnable()) return;
    this.autoSpin.set(true);
    this.lastAutoSpinTime = performance.now();
    const step = (now: number) => {
      if (!this.autoSpin()) return;
      const dt = Math.min(100, Math.max(1, now - this.lastAutoSpinTime));
      this.lastAutoSpinTime = now;
      const deltaDeg = dt * 0.036;
      this.orbitAngle.update((a) => (a + deltaDeg) % 360);
      this.autoSpinFrame = requestAnimationFrame(step);
    };
    this.autoSpinFrame = requestAnimationFrame(step);
  }

  stopAutoSpin(): void {
    this.autoSpin.set(false);
    if (this.autoSpinFrame) {
      cancelAnimationFrame(this.autoSpinFrame);
      this.autoSpinFrame = undefined;
    }
  }

  zoomIn(): void {
    this.zoomLevel.update((z) => Math.min(1.8, +(z + 0.2).toFixed(1)));
  }

  zoomOut(): void {
    this.zoomLevel.update((z) => Math.max(1.0, +(z - 0.2).toFixed(1)));
  }

  reset3DView(): void {
    this.stopAutoSpin();
    this.orbitAngle.set(0);
    this.zoomLevel.set(1.0);
  }

  toggleShowOriginal(): void {
    this.showOriginal.update((v) => !v);
  }
  downloadResult(): void {
    const res = this.result();
    if (!res) return;
    const a = document.createElement('a');
    a.href = res;
    a.download = `velura-virtual-tryon-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /** Selects the desired garment region as percentages of the original image. */
  setCrop(event: Event, field: 'x' | 'y' | 'width' | 'height'): void {
    this.crop.update((current) => ({
      ...current,
      [field]: Number((event.target as HTMLInputElement).value),
    }));
  }

  /** Applies a local crop and requires consent again for the final selected image. */
  async applyCrop(): Promise<void> {
    if (!this.file || this.busy()) return;
    try {
      const cropped = await this.model.crop(this.file, this.crop());
      this.select({ target: { files: [cropped], value: '' } } as unknown as Event);
      this.crop.set({ x: 0, y: 0, width: 100, height: 100 });
    } catch {
      this.error.set('Vùng chọn chưa hợp lệ. Kiểm tra vị trí và kích thước vùng ảnh.');
    }
  }

  /** Quality validation for tests or explicit quality gate checks. */
  async validate(): Promise<void> {
    await this.start('image_quality');
  }
  /** Availability requires enabled task and, for virtual try-on, supported product and exact variant. */
   readonly available = computed(
     () =>
      this.capabilities()?.enabled === true &&
      this.capabilities()?.tasks.some((t) => t.task === this.task() && t.enabled === true) === true &&
       (this.task() !== 'virtual_try_on' ||
        (this.capabilities()?.product_supported === true && this.capabilities()?.variant_supported === true)),
   );

  readonly title = computed(() =>
    this.task() === 'image_embedding' ? 'Tìm sản phẩm bằng ảnh' : 'Phòng thử đồ thông minh AI 3D',
  );

  /** Consent belongs to the selected photo and is never enabled by default. */
  setConsent(event: Event): void {
    if (this.mode() === 'studio' && (!this.studioImage() || this.studioLoading())) return;
    this.consent.set((event.target as HTMLInputElement).checked);
  }
  /** Studio selection must be an explicit choice from server assets. */
  async selectStudio(idOrEvent: string | Event): Promise<void> {
    const id = typeof idOrEvent === 'string' ? idOrEvent : (((idOrEvent as Event).target as HTMLSelectElement | null)?.value || '');
    const epoch = ++this.studioGeneration;
    this.release(this.studioImage());
    this.studioImage.set('');
    this.studio.set(id);
    this.consent.set(false);
    this.studioLoading.set(false);
    this.clearResult();
    this.job.set(null);
    if (!id || !this.capabilities()?.studio_assets?.some((asset) => asset.id === id)) return;
    this.studioLoading.set(true);
    this.error.set('');
    try {
      const blob = await firstValueFrom(this.model.studioPreview(id));
      if (epoch !== this.studioGeneration) return;
      this.studioImage.set(URL.createObjectURL(blob));
    } catch {
      if (epoch === this.studioGeneration)
        this.error.set('Chưa tải được ảnh người mẫu. Chọn lại hoặc thử sau.');
    } finally {
      if (epoch === this.studioGeneration) this.studioLoading.set(false);
    }
  }

  /** Changing input mode requires clean state; personal identity is never merged with a studio model. */
  chooseMode(mode: 'personal' | 'studio'): void {
    if (this.busy()) return;
    this.mode.set(mode);
    this.clearResult();
    this.job.set(null);
    this.qualityWarning.set(null);
    if (mode === 'studio' && !this.studio() && this.filteredStudioAssets().length) {
      void this.selectStudio(this.filteredStudioAssets()[0].id);
    }
  }

  /** An unreadable image is not accepted as a completed preview. */
  studioPreviewFailed(): void {
    this.release(this.studioImage());
    this.studioImage.set('');
    this.consent.set(false);
    this.error.set('Ảnh người mẫu chưa hiển thị được. Vui lòng chọn lại.');
  }

  private clearStudio(): void {
    this.studioGeneration++;
    this.release(this.studioImage());
    this.studioImage.set('');
    this.studio.set('');
    this.studioLoading.set(false);
  }

  /** Displays job lifecycle without claiming a failed gate succeeded. */
  statusLabel(job: AiJob): string {
    if (job.status === 'queued') return 'Đang xếp hàng tính toán trên GPU';
    if (job.status === 'running') return 'AI đang phối đồ và render theo góc chụp...';
    if (job.status === 'success') {
      if (job.task === 'image_quality')
        return job.gate?.valid === true
          ? 'Ảnh đạt tiêu chuẩn thử đồ.'
          : 'Ảnh có lưu ý nhỏ nhưng vẫn có thể tiếp tục thử đồ.';
      return job.frames3d?.length ? 'Thử đồ thành công! Kéo ảnh để xoay 360°.' : 'Thử đồ thành công!';
    }
    if (job.status === 'validation_failed')
      return 'Ảnh chưa nhận diện được dáng người. Bạn nên chọn Người mẫu Studio bên dưới.';
    if (job.status === 'cancelled') return 'Đã hủy';
    // VTO-09 Timeout and VTO-10 Retry: the server records the deadline as AI_JOB_TIMEOUT on a failed job.
    if (job.error === 'AI_JOB_TIMEOUT') return 'Quá 2 phút xử lý nên hệ thống đã dừng chờ. Bạn có thể thử lại.';
    if (job.error === 'VTO_PRODUCT_UNAVAILABLE')
      return 'Sản phẩm hoặc biến thể không còn hỗ trợ thử đồ. Vui lòng quay lại trang sản phẩm.';
    return 'Chưa xử lý được ảnh. Vui lòng thử lại.';
  }

  /** Converts measured gate codes to actionable guidance without blocking users. */
  reasonLabel(reason: string): string {
    const labels: Record<string, string> = {
      LOW_RESOLUTION: 'Ảnh độ phân giải hơi thấp. Bạn nên chọn ảnh sắc nét hơn để xem rõ chất vải.',
      TOO_DARK: 'Ảnh thiếu sáng. Thử chụp lại ở nơi có ánh sáng rõ hơn.',
      OVEREXPOSED: 'Ảnh có độ sáng cao. Bạn nên giảm nguồn sáng chói.',
      BLURRY: 'Ảnh hơi mờ. Giữ điện thoại cố định khi chụp.',
      PERSON_NOT_DETECTED: 'Không nhận diện được người. Vui lòng chụp rõ phần thân hoặc chọn Người mẫu Studio.',
      POSE_CHECK_UNAVAILABLE: 'Dáng người chưa rõ. Bạn có thể chọn Người mẫu Studio bên dưới.',
      BODY_NOT_VISIBLE: 'Chưa thấy rõ cơ thể. Chọn ảnh đứng rõ phần thân người.',
      BODY_CROPPED_OR_OCCLUDED: 'Vùng cơ thể cần mặc đồ bị che. Chọn ảnh chụp rộng hơn một chút.',
      MULTIPLE_PEOPLE: 'Ảnh có nhiều người. Hãy chọn ảnh một người để AI nhận dạng đúng.',
      POSE_NOT_FRONTAL: 'Gợi ý: Đứng hướng chính diện sẽ cho form dáng trang phục chuẩn xác nhất.',
      BACKGROUND_TOO_COMPLEX: 'Nền ảnh có cảnh vật thực tế - AI sẽ tự động phân tách trang phục và bảo toàn cảnh quan xung quanh.',
      BACKGROUND_NOT_VISIBLE: 'Người hơi sát mép ảnh. AI vẫn sẽ thử đồ nhưng chụp rộng hơn sẽ đẹp hơn.',
      BACKGROUND_CHECK_UNAVAILABLE: 'Chưa phân tích được nền ảnh. Tiếp tục thử đồ bình thường.',
    };
    return labels[reason] || 'Gợi ý: Chọn ảnh rõ nét và thẳng người để trang phục lên form đẹp nhất.';
  }

  private file: File | null = null;
  private asset = '';
  private generation = 0;
  private pendingKey = '';
  private pendingFingerprint = '';
  private timer: number | undefined;

   constructor() {
     effect(() => {
      const session = this.auth.session();
       untracked(() => {
         this.generation++;
        this.verifiedMember.set(false);
        if (session?.userId && session?.role === 'member') {
          void this.verifyMemberIdentity();
        }
         this.clearTimer();
         this.stopLoadingTimer();
         this.stopAutoSpin();
         this.clearResult();
         this.preview.set('');
         this.job.set(null);
         this.busy.set(false);
         this.consent.set(false);
         this.qualityPassed.set(false);
         this.qualityWarning.set(null);
         this.file = null;
         this.asset = '';
         this.pendingKey = '';
         this.clearStudio();
       });
     });
     effect(() => {
       const task = this.task();
       const productId = this.productId();
      const variantId = this.variantId();
       untracked(() => {
         if (task !== 'virtual_try_on') {
           this.offered.set(true);
           return;
         }
         this.offered.set(false);
        if (!productId || !variantId) return;
        const epoch = ++this.capabilitiesEpoch;
        void firstValueFrom(this.model.capabilities(productId, variantId))
           .then((caps) => {
            if (epoch === this.capabilitiesEpoch && productId === this.productId() && variantId === this.variantId()) {
              this.offered.set(caps.product_supported === true && caps.variant_supported === true);
            }
           })
           .catch(() => {
            if (epoch === this.capabilitiesEpoch) this.offered.set(false);
           });
       });
     });
     effect(() => {
       this.productId();
       this.variantId();
       untracked(() => {
         this.capabilities.set(null);
         this.clearTimer();
         this.stopLoadingTimer();
         this.stopAutoSpin();
         this.clearResult();
         this.job.set(null);
         this.busy.set(false);
         this.clearStudio();
         this.pendingKey = '';
         this.pendingFingerprint = '';
         if (this.dialog()?.nativeElement.open) void this.open();
       });
     });
    this.destroy.onDestroy(() => {
      this.generation++;
      this.clearTimer();
      this.stopLoadingTimer();
      this.stopAutoSpin();
      this.release(this.preview());
      this.clearResult();
      this.clearStudio();
    });
  }

  /** Opens a keyboard-accessible modal and reads readiness before uploading anything. */
  async open(): Promise<void> {
    this.auth.refresh();
    if (this.memberRequired()) {
      this.openGateModal();
      return;
    }
     const dialog = this.dialog()?.nativeElement;
     if (dialog && !dialog.open) dialog.showModal?.();
     // A reopen must not stack a second poll loop: while a job is in flight its own loop keeps running and nothing
     // is resumed; otherwise any leftover (e.g. a 360° watch) is stopped and the saved job is resumed once.
     const resumable = !this.busy();
     if (resumable) {
       this.clearTimer();
       this.generation++;
     }
     const epoch = this.generation;
     this.capabilities.set(null);
     this.error.set('');
     try {
       const capabilities = await firstValueFrom(
         this.model.capabilities(
           this.task() === 'virtual_try_on' ? this.productId() : undefined,
           this.task() === 'virtual_try_on' ? this.variantId() : undefined,
         ),
       );
       if (epoch === this.generation) {
         this.capabilities.set(capabilities);
        if (this.mode() === 'studio' && !this.studio() && this.filteredStudioAssets().length) {
          void this.selectStudio(this.filteredStudioAssets()[0].id);
        }
        const savedId = sessionStorage.getItem(this.storageKey());
          const savedPending = sessionStorage.getItem(`${this.storageKey()}_pending`);
          if (resumable && (savedId || savedPending)) {
            try {
              const recovered = await firstValueFrom(savedId ? this.model.job(savedId) : this.model.recover(savedPending!));
              const job = recovered.job;
              const sameSelection = this.task() !== 'virtual_try_on' ||
                ((!job.product_id || job.product_id === this.productId()) &&
                  (!job.variant_id || !this.variantId() || job.variant_id === this.variantId()));
              if (epoch === this.generation && sameSelection) {
                this.job.set(job);
                if (job.status === 'queued' || job.status === 'running') {
                  this.busy.set(true);
                  this.startLoadingTimer();
                }
                await this.poll(epoch);
              }
            } catch {
              sessionStorage.removeItem(this.storageKey());
              sessionStorage.removeItem(`${this.storageKey()}_pending`);
            }
          }
        }
      } catch {
      if (epoch === this.generation)
        this.error.set('Chưa kết nối được dịch vụ AI. Vui lòng thử lại sau.');
    }
  }

  /** Native close restores focus to the opener. Work stays resumable within the owner session. */
  close(): void {
    this.stopLoadingTimer();
    this.stopAutoSpin();
    this.dialog()?.nativeElement.close?.();
  }

  /** Validates local file envelope; smart validation accepts personal photos without blocking. */
  async select(event: Event): Promise<void> {
    const el = event.target as HTMLInputElement;
     const file = el.files?.[0];
     el.value = '';
     if (!file || this.busy()) return;
    if (this.task() === 'virtual_try_on') {
      const isMember = await this.verifyMemberIdentity();
      if (!isMember) {
        this.openGateModal();
        return;
      }
    }
     const max = this.capabilities()?.max_upload_bytes || 8 * 1024 * 1024;
     if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > max) {
       this.error.set('Chọn ảnh JPG, PNG hoặc WebP dưới 8MB.');
       return;
     }
    this.release(this.preview());
    this.clearResult();
    this.preview.set(URL.createObjectURL(file));
    this.file = file;
    this.asset = '';
    this.pendingKey = '';
    this.pendingFingerprint = '';
    this.job.set(null);
    this.qualityPassed.set(false);
    this.qualityWarning.set(null);
    this.consent.set(false);
    this.error.set('');
  }

  /** Fetch and decode every turntable frame before showing any, so dragging never hits a half-loaded frame. */
  private async load3dArtifacts(job: AiJob): Promise<void> {
    this.frames3d().forEach((url) => URL.revokeObjectURL(url));
    this.frames3d.set([]);
    this.frames3dFailed.set(false);
    const names = (job.frames3d ?? []).map((path) => path.split('/').pop() ?? '');
    if (!names.length) return;
    const epoch = this.generation;
    let urls: string[] = [];
    try {
      const blobs = await Promise.all(
        names.map((name) => firstValueFrom(this.model.resultFile(job.id, name))),
      );
      urls = blobs.map((b) => URL.createObjectURL(b));
      await Promise.all(urls.map((src) => Object.assign(new Image(), { src }).decode()));
      if (epoch !== this.generation) throw new Error('STALE');
      this.frames3d.set(urls);
      this.orbitAngle.set(0);
    } catch {
      urls.forEach((url) => URL.revokeObjectURL(url));
      if (epoch === this.generation) this.frames3dFailed.set(true);
    }
  }

  /** VTO-08: after the try-on is shown, keep following the 360° add-on until it publishes frames or reports failure. */
  private watchStage3d(epoch: number, id: string): void {
    this.timer = window.setTimeout(async () => {
      try {
        const { job } = await firstValueFrom(this.model.job(id));
        if (epoch !== this.generation) return;
        this.job.set(job);
        if (job.stage3d === 'pending') this.watchStage3d(epoch, id);
        else await this.load3dArtifacts(job);
      } catch {
        if (epoch === this.generation) this.frames3dFailed.set(true);
      }
    }, 2000);
  }

   async generate(): Promise<void> {
    if (this.task() === 'virtual_try_on') {
      const isMember = await this.verifyMemberIdentity();
      if (!isMember) {
        this.openGateModal();
        return;
      }
    }
     if (
       this.task() === 'virtual_try_on' &&
      (!this.productId() || !this.variantId() || !this.available())
     ) {
       this.error.set('Chọn màu và cỡ sản phẩm trước khi thử đồ.');
       return;
     }
    if (this.task() === 'virtual_try_on' && this.mode() === 'personal' && !this.qualityPassed())
      return;
    if (this.mode() === 'studio' && (!this.studio() || !this.studioImage() || this.studioLoading()))
      return;
    if (this.mode() === 'personal' && !this.preview()) return;
    await this.start(this.task());
  }

  /** Cancels the authoritative server job; late poll responses cannot change the UI. */
  async cancel(): Promise<void> {
    const id = this.job()?.id;
    this.generation++;
    this.clearTimer();
    this.stopLoadingTimer();
    this.busy.set(true);
    if (id) {
      const epoch = this.generation;
      try {
        await firstValueFrom(this.model.cancel(id));
        const response = await firstValueFrom(this.model.job(id));
        if (epoch !== this.generation) return;
        this.job.set(response.job);
        await this.poll(epoch);
      } catch {
        if (epoch === this.generation) {
          this.busy.set(false);
          this.error.set('Chưa xác nhận được thao tác hủy. Thử lại sau.');
        }
      }
    } else {
      this.busy.set(false);
    }
  }

  private startLoadingTimer(): void {
    this.stopLoadingTimer();
    this.loadingSeconds.set(0);
    this.loadingTimer = window.setInterval(() => {
      this.loadingSeconds.update((s) => s + 1);
    }, 1000);
  }

  private stopLoadingTimer(): void {
    window.clearInterval(this.loadingTimer);
    this.loadingTimer = undefined;
  }
  private async start(task: AiTask): Promise<void> {
    if (this.busy() || !this.consent() || !this.available()) return;
    if (this.mode() === 'personal' && !this.file) return;
    if (this.task() === 'virtual_try_on') {
      const isMember = await this.verifyMemberIdentity();
      if (!isMember) {
        this.openGateModal();
        return;
      }
    }
    const epoch = ++this.generation;
    this.busy.set(true);
    this.error.set('');
    this.startLoadingTimer();
    try {
      if (this.mode() === 'personal' && this.file && !this.asset) {
        const uploaded = await firstValueFrom(this.model.upload(this.file));
        if (epoch !== this.generation) return;
        this.asset = uploaded.asset_id;
      }
      const body = {
        task,
        filters: task === 'image_embedding' && this.candidateProductIds() !== undefined
          ? { product_ids: this.candidateProductIds()! } : undefined,
        person_check: task === 'image_quality' && this.task() === 'virtual_try_on',
        image_asset_id: this.mode() === 'personal' ? this.asset || undefined : undefined,
        person_asset_id: this.mode() === 'personal' ? this.asset || undefined : undefined,
        product_id: this.productId() || undefined,
        variant_id: this.variantId() || undefined,
        mode: this.mode(),
        studio_asset_id: this.mode() === 'studio' ? this.studio() : undefined,
        render3d: this.mode() === 'studio',
        consent: true as const,
        confirmed: true as const,
        idempotency_key: '',
      };
      const fingerprint = JSON.stringify(body);
      if (!this.pendingKey || this.pendingFingerprint !== fingerprint) {
        this.pendingKey = crypto.randomUUID();
        this.pendingFingerprint = fingerprint;
      }
      body.idempotency_key = this.pendingKey;
      sessionStorage.setItem(`${this.storageKey()}_pending`, this.pendingKey);
      const response = await firstValueFrom(this.model.create(body));
      if (epoch !== this.generation) return;
      this.job.set(response.job);
      this.remember(response.job.id);
      await this.poll(epoch);
    } catch (err: unknown) {
      if (epoch === this.generation) {
        this.busy.set(false);
        this.stopLoadingTimer();
        let message = 'Yêu cầu AI chưa hoàn tất. Ảnh gốc vẫn được giữ nguyên.';
        if (err instanceof Error && err.message) {
          message = err.message;
        }
        this.error.set(message);
      }
    }
  }

  private async poll(epoch: number): Promise<void> {
    const current = this.job();
    if (!current || epoch !== this.generation) return;
    if (current.status === 'queued' || current.status === 'running') {
      if (!Number.isFinite(Date.parse(current.expires_at)) || Date.parse(current.expires_at) <= Date.now()) {
        this.busy.set(false);
        this.stopLoadingTimer();
        this.error.set('Tác vụ đã vượt thời gian lưu tạm. Vui lòng thử lại.');
        return;
      }
      this.timer = window.setTimeout(async () => {
        try {
          const response = await firstValueFrom(this.model.job(current.id));
          if (epoch !== this.generation) return;
          this.job.set(response.job);
          await this.poll(epoch);
        } catch {
          if (epoch === this.generation) {
            this.busy.set(false);
            this.stopLoadingTimer();
            this.error.set('Mất kết nối máy chủ AI. Đang kiểm tra lại...');
          }
        }
      }, 1500);
      return;
    }
    this.busy.set(false);
    this.stopLoadingTimer();
    if (
      current.status === 'failed' ||
      current.status === 'cancelled' ||
      current.status === 'validation_failed'
    )
      this.pendingKey = '';
    if (current.status === 'failed' || current.status === 'validation_failed') {
      this.error.set(this.statusLabel(current));
    }
    if (current.status !== 'success') return;
    if (current.task === 'image_quality') {
      this.qualityPassed.set(current.gate?.valid === true);
      if (current.gate?.reasons?.includes('BACKGROUND_TOO_COMPLEX')) {
        this.qualityWarning.set('Nền ảnh có cảnh vật thực tế - AI sẽ tự động phân tách trang phục và bảo toàn không gian xung quanh.');
      }
      return;
    }
    if (current.task === 'image_embedding') {
      this.matches.emit((current.matches || []).map((match) => match.product_id));
      return;
    }
    if (
      current.task === 'virtual_try_on' &&
      ((current.product_id && current.product_id !== this.productId()) ||
        (current.variant_id && this.variantId() && current.variant_id !== this.variantId()))
    ) {
      return;
    }
    try {
      const blob = await firstValueFrom(this.model.result(current.id));
      if (epoch !== this.generation) return;
      this.release(this.result());
      this.result.set(URL.createObjectURL(blob));
      this.showOriginal.set(false);
      if (current.stage3d === 'pending') this.watchStage3d(epoch, current.id);
      else await this.load3dArtifacts(current);
    } catch {
      if (epoch !== this.generation) return;
      this.clearResult();
      this.error.set('Không thể tải kết quả thử đồ hoặc sản phẩm không còn khả dụng. Vui lòng thử lại.');
    }
  }

  private storageKey(): string {
    return `velura_ai_job_${this.auth.session()?.userId || guestSessionId()}_${this.task()}_${this.productId()}_${this.variantId()}`;
  }

  private remember(id: string): void {
    sessionStorage.setItem(this.storageKey(), id);
  }

  private clearTimer(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Drop the 2D result AND its 360° frames together, so a new selection never shows the previous one's frames. */
  private clearResult(): void {
    this.release(this.result());
    this.result.set('');
    this.frames3d().forEach((url) => URL.revokeObjectURL(url));
    this.frames3d.set([]);
    this.frames3dFailed.set(false);
    this.orbitAngle.set(0);
  }

   private release(url: string): void {
     if (url.startsWith('blob:')) URL.revokeObjectURL(url);
   }

  /** Opens the guest signin/signup modal without mounting any file input or photo workbench. */
  private openGateModal(): void {
    const gate = this.dialog()?.nativeElement;
    if (gate && !gate.open) gate.showModal?.();
  }

  /** Verifies an active authenticated identity against the authoritative server endpoint before personal data entry. */
  async verifyMemberIdentity(): Promise<boolean> {
    if (!this.auth.isLoggedIn()) {
      this.verifiedMember.set(false);
      return false;
    }
    try {
      const identity = await firstValueFrom(this.api.me());
      const valid = Boolean(
        identity?.user?.id &&
        identity?.profile?.user_id &&
        identity.user.id === identity.profile.user_id &&
        identity.profile.is_active === true,
      );
      this.verifiedMember.set(valid);
      return valid;
    } catch {
      // The AI API re-checks the live identity and active state on every request.
      // Keep a live session usable when /me is transiently unavailable.
      const hasSession = this.auth.isLoggedIn();
      this.verifiedMember.set(hasSession);
      return hasSession;
    }
  }
}
