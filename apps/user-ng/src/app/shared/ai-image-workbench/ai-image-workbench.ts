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
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { guestSessionId } from '../../core/utils/guest-session';
import {
  AiCapabilities,
  AiEngineService,
  AiJob,
  AiTask,
  StudioAsset,
} from '../../core/services/ai-engine.service';

/** Consent-first image workflow with interactive 3D perspective, rich studio scenes, and responsive styling. */
@Component({
  selector: 'app-ai-image-workbench',
  standalone: true,
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
  private readonly destroy = inject(DestroyRef);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  readonly capabilities = signal<AiCapabilities | null>(null);
  readonly error = signal('');
  readonly consent = signal(false);
  readonly mode = signal<'personal' | 'studio'>('personal');
  readonly studio = signal('');
  readonly studioImage = signal('');
  readonly studioLoading = signal(false);
  private studioGeneration = 0;
  readonly preview = signal('');
  readonly result = signal('');
  readonly busy = signal(false);
  readonly job = signal<AiJob | null>(null);
  readonly qualityPassed = signal(false);
  readonly qualityWarning = signal<string | null>(null);
  readonly crop = signal({ x: 0, y: 0, width: 100, height: 100 });

  // --- STUDIO PRESETS & FILTERS ---
  readonly selectedGender = signal<'female' | 'male'>('female');
  readonly selectedScene = signal<string>('all');

  readonly filteredStudioAssets = computed(() => {
    const assets: StudioAsset[] = this.capabilities()?.studio_assets || [];
    return assets.filter((asset) => {
      if (asset.gender && asset.gender !== this.selectedGender())
        return false;
      const scene = this.selectedScene();
      if (scene === 'all') return true;
      if (scene === 'basic') return asset.occasion === 'basic';
      if (['spring', 'summer', 'autumn', 'winter'].includes(scene)) return asset.season === scene;
      return asset.occasion === scene;
    });
  });

  switchGender(gender: 'female' | 'male'): void {
    if (this.busy()) return;
    this.selectedGender.set(gender);
    const first = this.filteredStudioAssets()[0];
    if (first) {
      void this.selectStudio(first.id);
    }
  }

  switchScene(scene: string): void {
    if (this.busy()) return;
    this.selectedScene.set(scene);
    const first = this.filteredStudioAssets()[0];
    if (first) {
      void this.selectStudio(first.id);
    }
  }

  modelDisplayTitle(asset: StudioAsset): string {
    return (
      asset.label
        .replace(/^(Nữ|Nam)\s*[-–]\s*(Bối cảnh\s*)?/i, '')
        .replace(/\s*\/\s*(Đi làm|Đi học|Đi chơi|Party|Sang trọng)/i, '')
        .trim() || asset.label
    );
  }

  // --- AI RICH LOADING PROGRESS ---
  readonly loadingSeconds = signal<number>(0);
  readonly loadingStep = computed(() => {
    const s = this.loadingSeconds();
    if (s < 6) return 1;
    if (s < 18) return 2;
    if (s < 34) return 3;
    return 4;
  });
  readonly loadingMessage = computed(() => {
    const s = this.loadingSeconds();
    if (s < 6) return 'Đang phân tích vóc dáng và đo lường tỷ lệ khung xương...';
    if (s < 18) return 'Khớp mẫu trang phục, đo lường độ rủ và xếp nếp vải...';
    if (s < 34) return 'Mô hình AI Diffusion đang render và hòa phối trang phục lên cơ thể...';
    return 'Tinh chỉnh ánh sáng, khử răng cưa và hoàn thiện chi tiết trang phục...';
  });
  private loadingTimer: number | undefined;

  // --- INTERACTIVE 3D PERSPECTIVE & BEFORE/AFTER ---
  readonly view3D = signal<boolean>(true);
  readonly showOriginal = signal<boolean>(false);
  readonly tiltTransform = signal<string>('perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)');
  readonly glareBackground = signal<string>('none');

  onMouseMove(event: MouseEvent, target: HTMLElement): void {
    if (!this.view3D() || this.busy()) return;
    const rect = target.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const rotateX = ((centerY - y) / centerY) * 12;
    const rotateY = ((x - centerX) / centerX) * 12;
    this.tiltTransform.set(`perspective(1000px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) scale3d(1.02, 1.02, 1.02)`);
    this.glareBackground.set(`radial-gradient(circle at ${(x / rect.width * 100).toFixed(1)}% ${(y / rect.height * 100).toFixed(1)}%, rgba(255,255,255,0.25) 0%, transparent 60%)`);
  }

  onMouseLeave(): void {
    this.tiltTransform.set('perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)');
    this.glareBackground.set('none');
  }

  onTouchMove(event: TouchEvent, target: HTMLElement): void {
    if (!this.view3D() || this.busy() || !event.touches[0]) return;
    const touch = event.touches[0];
    const rect = target.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const rotateX = ((centerY - y) / centerY) * 10;
    const rotateY = ((x - centerX) / centerX) * 10;
    this.tiltTransform.set(`perspective(1000px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) scale3d(1.02, 1.02, 1.02)`);
  }

  toggleView3D(): void {
    this.view3D.update((v) => !v);
    if (!this.view3D()) {
      this.onMouseLeave();
    }
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
  readonly available = computed(
    () =>
      this.capabilities()?.tasks.some((t) => t.task === this.task() && t.enabled) === true &&
      (this.task() !== 'virtual_try_on' ||
        this.capabilities()?.product_supported === true),
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
    if (this.busy()) return;
    const epoch = ++this.studioGeneration;
    this.release(this.studioImage());
    this.studioImage.set('');
    this.studio.set(id);
    this.consent.set(false);
    this.studioLoading.set(false);
    this.release(this.result());
    this.result.set('');
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
    this.consent.set(mode === 'studio');
    this.release(this.result());
    this.result.set('');
    this.job.set(null);
    this.qualityWarning.set(null);
    if (mode === 'studio' && !this.studio() && this.capabilities()?.studio_assets?.length) {
      void this.selectStudio(this.capabilities()!.studio_assets![0].id);
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
    if (job.status === 'success')
      return job.task === 'image_quality'
        ? job.gate?.valid === true
          ? 'Ảnh đạt tiêu chuẩn thử đồ.'
          : 'Ảnh có lưu ý nhỏ nhưng vẫn có thể tiếp tục thử đồ.'
        : 'Thử đồ thành công! Xem góc nhìn 3D bên dưới.';
    if (job.status === 'validation_failed')
      return 'Ảnh chưa nhận diện được dáng người. Bạn nên chọn Người mẫu Studio bên dưới.';
    return job.status === 'cancelled' ? 'Đã hủy' : 'Chưa xử lý được ảnh. Vui lòng thử lại.';
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
      this.auth.session()?.userId;
      untracked(() => {
        this.generation++;
        this.clearTimer();
        this.stopLoadingTimer();
        this.release(this.preview());
        this.release(this.result());
        this.preview.set('');
        this.result.set('');
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
      this.productId();
      this.variantId();
      untracked(() => {
        this.generation++;
        this.capabilities.set(null);
        this.clearTimer();
        this.stopLoadingTimer();
        this.release(this.result());
        this.result.set('');
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
      this.release(this.preview());
      this.release(this.result());
      this.clearStudio();
    });
  }

  /** Opens a keyboard-accessible modal and reads readiness before uploading anything. */
  async open(): Promise<void> {
    const dialog = this.dialog()?.nativeElement;
    if (dialog && !dialog.open) dialog.showModal();
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
        if (this.mode() === 'studio' && !this.studio() && capabilities.studio_assets?.length) {
          void this.selectStudio(capabilities.studio_assets[0].id);
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
    this.dialog()?.nativeElement.close();
  }

  /** Validates local file envelope; smart validation accepts personal photos without blocking. */
  select(event: Event): void {
    const el = event.target as HTMLInputElement;
    const file = el.files?.[0];
    el.value = '';
    if (!file || this.busy()) return;
    const max = this.capabilities()?.max_upload_bytes || 8 * 1024 * 1024;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > max) {
      this.error.set('Chọn ảnh JPG, PNG hoặc WebP dưới 8MB.');
      return;
    }
    this.generation++;
    this.release(this.preview());
    this.release(this.result());
    this.preview.set(URL.createObjectURL(file));
    this.result.set('');
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

  /** Requires explicit confirmation to generate try-on. */
  async generate(): Promise<void> {
    if (
      this.task() === 'virtual_try_on' &&
      (!this.productId() || !this.variantId() || this.capabilities()?.variant_supported === false)
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
    } catch {
      if (epoch === this.generation) {
        this.busy.set(false);
        this.stopLoadingTimer();
        this.error.set('Yêu cầu AI chưa hoàn tất. Ảnh gốc vẫn được giữ nguyên.');
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
    const blob = await firstValueFrom(this.model.result(current.id));
    if (epoch !== this.generation) return;
    this.release(this.result());
    this.result.set(URL.createObjectURL(blob));
    this.showOriginal.set(false);
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

  private release(url: string): void {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
}
