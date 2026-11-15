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
} from '../../core/services/ai-engine.service';

/** One of the studio poses in display order; `src` stays empty until its image has been downloaded. */
export interface PoseSlot {
  id: string;
  label: string;
  src: string;
}

/** Consent-first image workflow: personal-photo try-on or one studio job that tries the garment on every studio pose. */
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
  /** Preview (object URL) of the standing studio model, the fixed input of every studio try-on. */
  readonly studioImage = signal('');
  readonly studioLoading = signal(false);
  private studioGeneration = 0;
  /** Preview of the selected product variant's garment, the second input of every studio try-on. */
  readonly garmentImage = signal('');
  readonly garmentLoading = signal(false);
  readonly garmentFailed = signal(false);
  private garmentGeneration = 0;
  readonly preview = signal('');
  readonly result = signal('');
  readonly busy = signal(false);
  readonly job = signal<AiJob | null>(null);
  readonly qualityPassed = signal(false);
  readonly qualityWarning = signal<string | null>(null);
  readonly crop = signal({ x: 0, y: 0, width: 100, height: 100 });

  /** Licensed studio poses in server order; the first one is the standing model. */
  readonly studioAssets = computed(() => this.capabilities()?.studio_assets ?? []);
  /** Id of the standing model shown as the studio input preview. */
  readonly standingAssetId = computed(() => this.studioAssets()[0]?.id ?? '');

  // --- STUDIO POSES: object URLs of the published poses, keyed by pose id ---
  readonly poseUrls = signal<Record<string, string>>({});
  private poseEpoch = 0;
  private poseJobId = '';
  private readonly poseRequested = new Set<string>();

  /** The poses of the job in studio order; unfinished ones have an empty `src` and render as skeletons. */
  readonly poseSlots = computed<PoseSlot[]>(() => {
    const urls = this.poseUrls();
    const known = this.studioAssets().map((asset) => ({ id: asset.id, label: asset.label }));
    const extra = (this.job()?.poses ?? []).filter((pose) => !known.some((slot) => slot.id === pose.id));
    return [...known, ...extra].map((slot) => ({ ...slot, src: urls[slot.id] ?? '' }));
  });
  /** Whether the studio pose grid replaces the single-image result. */
  readonly showPoses = computed(() => {
    const job = this.job();
    if (!job || job.task !== 'virtual_try_on') return false;
    if ((job.status === 'running' || job.status === 'success') && job.poses?.length) return true;
    return this.mode() === 'studio' && (job.status === 'queued' || job.status === 'running');
  });
  readonly poseProgress = computed(() => {
    const job = this.job();
    if (!job || !this.showPoses()) return '';
    const done = job.poses?.length ?? 0;
    const total = this.poseSlots().length || 10;
    if (job.status === 'running') return `Đã xong ${done}/${total} dáng`;
    return job.status === 'success' ? `${done}/${total} dáng` : '';
  });
  /** A finished try-on is on screen: the single result image or a successful pose set. */
  readonly resultReady = computed(
    () => !!this.result() || (this.job()?.status === 'success' && !!this.job()?.poses?.length),
  );

  // --- LIFECYCLE (spec 3.1.8) — derived from real state, never from elapsed time ---
  readonly lifecycleSteps = ['Chọn ảnh', 'Kiểm tra ảnh', 'Xác nhận', 'Đang xử lý', 'Kết quả'] as const;
  /** 1-based current step: input → validation → preview/confirm → processing → result. */
  readonly lifecycleStep = computed(() => {
    const job = this.job();
    if (this.resultReady()) return 5;
    if (job?.task === 'virtual_try_on' && (job.status === 'queued' || job.status === 'running')) return 4;
    const hasInput = this.mode() === 'studio' ? !!this.studioImage() : !!this.preview();
    if (!hasInput) return 1;
    // Studio models are operator-verified, so they skip the photo quality gate.
    return this.mode() === 'studio' || this.qualityPassed() ? 3 : 2;
  });
  /** Seconds since the current job started; shown against the 2-minute VTO-09 budget, not used to fake progress. */
  readonly loadingSeconds = signal<number>(0);
  readonly processingTitle = computed(() =>
    this.job()?.task === 'image_quality' ? 'Đang kiểm tra ảnh' : 'AI đang thử đồ',
  );
  readonly processingMessage = computed(() => {
    const job = this.job();
    if (!job) return 'Đang tải ảnh lên an toàn...';
    if (job.status === 'queued') return 'Đang chờ đến lượt xử lý trên GPU...';
    if (job.task === 'image_quality') return 'Đang kiểm tra độ nét, ánh sáng và dáng người...';
    return this.mode() === 'studio'
      ? `Đang thử đồ lần lượt trên ${this.poseSlots().length || 'các'} dáng — mỗi dáng tối đa 2 phút.`
      : 'Đang phối trang phục lên ảnh — tối đa 2 phút.';
  });
  readonly elapsedLabel = computed(() => {
    const s = this.loadingSeconds();
    const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const budgeted =
      this.job()?.task === 'virtual_try_on' && this.job()?.status === 'running' && this.mode() !== 'studio';
    return budgeted ? `${clock} / 2:00` : clock;
  });
  private loadingTimer: number | undefined;

  readonly showOriginal = signal<boolean>(false);

  /** Caption on the single-result preview. */
  readonly stageTag = computed(() => (this.showOriginal() ? 'Ảnh gốc' : 'Ảnh thử đồ AI'));
  /** What the single-result preview shows: the original photo or the try-on result. */
  readonly currentDisplayImage = computed(() =>
    this.showOriginal()
      ? this.mode() === 'personal'
        ? this.preview()
        : this.studioImage()
      : this.result(),
  );

  toggleShowOriginal(): void {
    this.showOriginal.update((v) => !v);
  }

  /** Saves the single result, or one finished studio pose when `pose` is given. */
  downloadResult(pose?: PoseSlot): void {
    const res = pose ? pose.src : this.result();
    if (!res) return;
    const a = document.createElement('a');
    a.href = res;
    a.download = `velura-virtual-tryon-${pose ? `${pose.id}-` : ''}${Date.now()}.png`;
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
    this.task() === 'image_embedding' ? 'Tìm sản phẩm bằng ảnh' : 'Phòng thử đồ AI',
  );

  /** Consent belongs to the selected photo and is never enabled by default. */
  setConsent(event: Event): void {
    if (this.mode() === 'studio' && (!this.studioImage() || this.studioLoading())) return;
    this.consent.set((event.target as HTMLInputElement).checked);
  }
  /** Loads the exact garment (selected colour/size SKU) that the studio job will try on, so the customer can verify it before consent. */
  async loadGarmentPreview(): Promise<void> {
    const epoch = ++this.garmentGeneration;
    this.release(this.garmentImage());
    this.garmentImage.set('');
    this.garmentFailed.set(false);
    if (!this.productId() || !this.variantId()) return;
    this.garmentLoading.set(true);
    try {
      const blob = await firstValueFrom(this.model.garmentPreview(this.productId(), this.variantId()));
      if (epoch !== this.garmentGeneration) return;
      this.garmentImage.set(URL.createObjectURL(blob));
    } catch {
      if (epoch === this.garmentGeneration) this.garmentFailed.set(true);
    } finally {
      if (epoch === this.garmentGeneration) this.garmentLoading.set(false);
    }
  }
  /** Loads the preview of the standing studio model (first licensed pose) shown before consent. */
  async loadStudioPreview(): Promise<void> {
    const id = this.standingAssetId();
    const epoch = ++this.studioGeneration;
    this.release(this.studioImage());
    this.studioImage.set('');
    this.consent.set(false);
    this.studioLoading.set(false);
    if (!id) return;
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
    if (mode === 'studio' && !this.studioImage() && this.standingAssetId()) {
      void this.loadStudioPreview();
    }
    if (mode === 'studio') void this.loadGarmentPreview();
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
    this.garmentGeneration++;
    this.release(this.studioImage());
    this.release(this.garmentImage());
    this.studioImage.set('');
    this.garmentImage.set('');
    this.studioLoading.set(false);
  }

  /** Displays job lifecycle without claiming a failed gate succeeded. */
  statusLabel(job: AiJob): string {
    if (job.status === 'queued') return 'Đang xếp hàng tính toán trên GPU';
    if (job.status === 'running')
      return this.mode() === 'studio'
        ? 'AI đang thử đồ lần lượt trên từng dáng người mẫu...'
        : 'AI đang phối đồ lên ảnh của bạn...';
    if (job.status === 'success') {
      if (job.task === 'image_quality')
        return job.gate?.valid === true
          ? 'Ảnh đạt tiêu chuẩn thử đồ.'
          : 'Ảnh có lưu ý nhỏ nhưng vẫn có thể tiếp tục thử đồ.';
      return 'Thử đồ thành công!';
    }
    if (job.status === 'validation_failed')
      return 'Ảnh chưa nhận diện được dáng người. Bạn nên chọn Người mẫu studio ở trên.';
    if (job.status === 'cancelled') return 'Đã hủy';
    // VTO-09 Timeout and VTO-10 Retry: the server records the deadline as AI_JOB_TIMEOUT on a failed job.
    if (job.error === 'AI_JOB_TIMEOUT')
      return this.mode() === 'studio'
        ? 'Quá thời gian xử lý nên hệ thống đã dừng chờ. Bạn có thể thử lại.'
        : 'Quá 2 phút xử lý nên hệ thống đã dừng chờ. Bạn có thể thử lại.';
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
      PERSON_NOT_DETECTED: 'Không nhận diện được người. Vui lòng chụp rõ phần thân hoặc chọn Người mẫu studio.',
      POSE_CHECK_UNAVAILABLE: 'Dáng người chưa rõ. Bạn có thể chọn Người mẫu studio ở trên.',
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
     // is resumed; otherwise the saved job is resumed once.
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
        if (this.mode() === 'studio' && !this.studioImage() && this.standingAssetId()) {
          void this.loadStudioPreview();
        }
        if (this.mode() === 'studio') void this.loadGarmentPreview();
        const savedId = sessionStorage.getItem(this.storageKey());
          const savedPending = sessionStorage.getItem(`${this.storageKey()}_pending`);
          if (resumable && (savedId || savedPending)) {
            try {
              const recovered = await firstValueFrom(savedId ? this.model.job(savedId) : this.model.recover(savedPending!));
              const job = recovered.job;
              const sameSelection = this.task() !== 'virtual_try_on' || this.matchesSelection(job);
              if (epoch === this.generation && sameSelection) {
                this.applyJob(job);
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

  /** True when a job belongs to the product and variant currently selected on the page. */
  private matchesSelection(job: AiJob): boolean {
    return (
      (!job.product_id || job.product_id === this.productId()) &&
      (!job.variant_id || !this.variantId() || job.variant_id === this.variantId())
    );
  }

  /** Adopts server job state and downloads any newly published studio poses. */
  private applyJob(job: AiJob): void {
    this.job.set(job);
    this.syncPoses(job);
  }

  /** Downloads each published pose once; failures are retried by the next poll while the job still runs. */
  private syncPoses(job: AiJob): void {
    if (job.task !== 'virtual_try_on' || !job.poses?.length || !this.matchesSelection(job)) return;
    if (this.poseJobId !== job.id) {
      this.dropPoses();
      this.poseJobId = job.id;
    }
    const epoch = this.poseEpoch;
    for (const pose of job.poses) {
      if (this.poseRequested.has(pose.id)) continue;
      this.poseRequested.add(pose.id);
      void firstValueFrom(this.model.pose(job.id, pose.id))
        .then((blob) => {
          if (epoch !== this.poseEpoch) return;
          this.poseUrls.update((urls) => ({ ...urls, [pose.id]: URL.createObjectURL(blob) }));
        })
        .catch(() => {
          if (epoch !== this.poseEpoch) return;
          this.poseRequested.delete(pose.id);
          if (this.job()?.status === 'success')
            this.error.set('Không thể tải một số ảnh thử đồ. Vui lòng thử lại.');
        });
    }
  }

  /** Revokes every pose image and forgets the selection. */
  private dropPoses(): void {
    this.poseEpoch++;
    Object.values(this.poseUrls()).forEach((url) => this.release(url));
    this.poseUrls.set({});
    this.poseRequested.clear();
    this.poseJobId = '';
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
    if (this.mode() === 'studio' && (!this.studioImage() || this.studioLoading())) return;
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
        this.applyJob(response.job);
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
    this.dropPoses();
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
      this.applyJob(response.job);
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
          this.applyJob(response.job);
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
    if (current.task === 'virtual_try_on' && !this.matchesSelection(current)) {
      return;
    }
    // Studio jobs publish every pose (downloaded by applyJob); only single-image results are fetched here.
    if (current.poses?.length) {
      this.showOriginal.set(false);
      return;
    }
    try {
      const blob = await firstValueFrom(this.model.result(current.id));
      if (epoch !== this.generation) return;
      this.release(this.result());
      this.result.set(URL.createObjectURL(blob));
      this.showOriginal.set(false);
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

  /** Drops the single result and every pose image together, so a new selection never shows the previous one's. */
  private clearResult(): void {
    this.release(this.result());
    this.result.set('');
    this.dropPoses();
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
