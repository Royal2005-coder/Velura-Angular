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
} from '../../core/services/ai-engine.service';

/** Consent-first image workflow. Studio means a shop model, never an invented face replacement. */
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
  readonly crop = signal({ x: 0, y: 0, width: 100, height: 100 });
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
  readonly available = computed(
    () =>
      this.capabilities()?.tasks.some((t) => t.task === this.task() && t.enabled) === true &&
      (this.task() !== 'virtual_try_on' ||
        this.capabilities()?.product_supported === true),
  );
  readonly title = computed(() =>
    this.task() === 'image_embedding' ? 'Tìm sản phẩm bằng ảnh' : 'Thử đồ với AI',
  );
  /** Consent belongs to the selected photo and is never enabled by default. */
  setConsent(event: Event): void {
    if (this.mode() === 'studio' && (!this.studioImage() || this.studioLoading())) return;
    this.consent.set((event.target as HTMLInputElement).checked);
  }
  /** Studio selection must be an explicit choice from server assets. */
  async selectStudio(event: Event): Promise<void> {
    if (this.busy()) return;
    const id = (event.target as HTMLSelectElement).value;
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
  /** Changing input mode requires a new explicit consent; personal identity is never merged with a studio model. */
  chooseMode(mode: 'personal' | 'studio'): void {
    if (this.busy()) return;
    this.mode.set(mode);
    this.consent.set(false);
    this.release(this.result());
    this.result.set('');
    this.job.set(null);
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
    this.consent.set(false);
  }
  /** Displays job lifecycle without claiming a failed gate succeeded. */
  statusLabel(job: AiJob): string {
    if (job.status === 'queued') return 'Đang chờ xử lý';
    if (job.status === 'running') return 'AI đang xử lý ảnh';
    if (job.status === 'success')
      return job.task === 'image_quality'
        ? job.gate?.valid === true
          ? 'Ảnh đạt yêu cầu. Xác nhận để thử đồ.'
          : 'Ảnh chưa đạt yêu cầu. Chọn ảnh khác hoặc người mẫu studio.'
        : 'Đã xử lý xong';
    if (job.status === 'validation_failed')
      return 'Ảnh chưa đạt yêu cầu. Chọn ảnh khác hoặc người mẫu studio.';
    return job.status === 'cancelled' ? 'Đã hủy' : 'Chưa xử lý được ảnh';
  }
  /** Converts measured gate codes to actionable guidance without inventing new detections. */
  reasonLabel(reason: string): string {
    const labels: Record<string, string> = {
      LOW_RESOLUTION: 'Ảnh quá nhỏ. Chọn ảnh có độ phân giải cao hơn.',
      TOO_DARK: 'Ảnh thiếu sáng. Chụp lại ở nơi có ánh sáng đều.',
      OVEREXPOSED: 'Ảnh bị cháy sáng. Giảm ánh sáng trực tiếp.',
      BLURRY: 'Ảnh chưa rõ nét. Giữ máy ổn định khi chụp.',
      PERSON_NOT_DETECTED: 'Chưa thấy rõ người trong ảnh. Chụp toàn thân, đứng thẳng.',
      POSE_CHECK_UNAVAILABLE: 'Chưa kiểm tra được tư thế. Thử lại sau hoặc chọn người mẫu studio.',
      BODY_NOT_VISIBLE: 'Chưa thấy rõ thân người. Chọn ảnh toàn thân, không bị che khuất.',
      BODY_CROPPED_OR_OCCLUDED: 'Ảnh bị cắt hoặc che vùng cơ thể cần thử đồ. Chọn ảnh toàn thân rõ ràng.',
      MULTIPLE_PEOPLE: 'Ảnh có nhiều người. Chọn ảnh chỉ có một người để thử đồ.',
      POSE_NOT_FRONTAL: 'Hãy đứng thẳng, hướng người về phía máy ảnh.',
      BACKGROUND_TOO_COMPLEX: 'Nền ảnh có nhiều chi tiết. Chọn nền đơn giản hoặc người mẫu studio.',
      BACKGROUND_NOT_VISIBLE: 'Người quá sát khung ảnh. Chụp rộng hơn để thấy toàn thân và nền.',
      BACKGROUND_CHECK_UNAVAILABLE: 'Chưa kiểm tra được nền ảnh. Thử lại hoặc chọn người mẫu studio.',
    };
    return labels[reason] || 'Ảnh chưa phù hợp để thử đồ. Chọn ảnh khác hoặc chế độ studio.';
  }
  private file: File | null = null;
  private asset = '';
  private generation = 0;
  private pendingKey = '';
  private pendingFingerprint = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor() {
    effect(() => {
      this.auth.session()?.userId;
      untracked(() => {
        this.generation++;
        this.clearTimer();
        this.release(this.preview());
        this.release(this.result());
        this.preview.set('');
        this.result.set('');
        this.job.set(null);
        this.busy.set(false);
        this.consent.set(false);
        this.qualityPassed.set(false);
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
      const capabilities = await firstValueFrom(this.model.capabilities(
        this.task() === 'virtual_try_on' ? this.productId() : undefined,
        this.task() === 'virtual_try_on' ? this.variantId() : undefined,
      ));
      if (epoch === this.generation) this.capabilities.set(capabilities);
    } catch {
      if (epoch === this.generation) this.error.set('Chưa kết nối được dịch vụ AI. Vui lòng thử lại.');
    }
  }
  /** Native close restores focus to the opener. Work stays resumable within the owner session. */
  close(): void {
    this.dialog()?.nativeElement.close();
  }
  /** Validates local file envelope; actual pose/background gates run on the server. */
  select(event: Event): void {
    const el = event.target as HTMLInputElement;
    const file = el.files?.[0];
    el.value = '';
    if (!file || this.busy()) return;
    const max = this.capabilities()?.max_upload_bytes || 5 * 1024 * 1024;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > max) {
      this.error.set('Chọn ảnh JPG, PNG hoặc WebP trong giới hạn dung lượng.');
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
    this.consent.set(false);
    this.error.set('');
  }
  /** Quality validation never silently switches the user's identity to a studio model. */
  async validate(): Promise<void> {
    await this.start('image_quality');
  }
  /** Requires a second explicit confirmation after personal-image validation or studio selection. */
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
    await this.start(this.task());
  }
  /** Cancels the authoritative server job; late poll responses cannot change the UI. */
  async cancel(): Promise<void> {
    const id = this.job()?.id;
    this.generation++;
    this.clearTimer();
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
          this.error.set('Chưa xác nhận được thao tác hủy. Tiếp tục tác vụ để kiểm tra trạng thái.');
        }
      }
    } else {
      this.busy.set(false);
    }
  }
  private async start(task: AiTask): Promise<void> {
    if (this.busy() || !this.consent() || !this.available()) return;
    if (this.mode() === 'personal' && !this.file) return;
    const epoch = ++this.generation;
    this.busy.set(true);
    this.error.set('');
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
        this.error.set('Yêu cầu AI chưa hoàn tất. Ảnh gốc vẫn được giữ nguyên.');
      }
    }
  }
  /** Restores a server job ID only; uploaded photos are never written to browser storage. */
  async resume(): Promise<void> {
    const id = sessionStorage.getItem(this.storageKey());
    const key = sessionStorage.getItem(`${this.storageKey()}_pending`);
    if ((!id && !key) || this.busy()) return;
    const epoch = ++this.generation;
    this.busy.set(true);
    try {
      this.job.set((await firstValueFrom(id ? this.model.job(id) : this.model.recover(key!))).job);
      await this.poll(epoch);
    } catch {
      this.busy.set(false);
      this.error.set('Tác vụ đã hết hạn hoặc không thuộc phiên này.');
      sessionStorage.removeItem(this.storageKey());
      sessionStorage.removeItem(`${this.storageKey()}_pending`);
    }
  }
  private async poll(epoch: number): Promise<void> {
    const current = this.job();
    if (!current || epoch !== this.generation) return;
    if (current.status === 'queued' || current.status === 'running') {
      if (!Number.isFinite(Date.parse(current.expires_at)) || Date.parse(current.expires_at) <= Date.now()) {
        this.busy.set(false);
        this.error.set('Tác vụ đã vượt thời gian lưu tạm. Tiếp tục tác vụ để đọc trạng thái máy chủ; chưa có kết quả thành công.');
        return;
      }
      this.timer = setTimeout(async () => {
        try {
          const response = await firstValueFrom(this.model.job(current.id));
          if (epoch !== this.generation) return;
          this.job.set(response.job);
          await this.poll(epoch);
        } catch {
          if (epoch === this.generation) {
            this.busy.set(false);
            this.error.set('Mất kết nối. Tiếp tục tác vụ để kiểm tra trước khi gửi yêu cầu mới.');
          }
        }
      }, 1500);
      return;
    }
    this.busy.set(false);
    if (
      current.status === 'failed' ||
      current.status === 'cancelled' ||
      current.status === 'validation_failed'
    )
      this.pendingKey = '';
    if (current.status !== 'success') return;
    if (current.task === 'image_quality') {
      this.qualityPassed.set(current.gate?.valid === true);
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
  }
  private storageKey(): string {
    return `velura_ai_job_${this.auth.session()?.userId || guestSessionId()}_${this.task()}_${this.productId()}_${this.variantId()}`;
  }
  private remember(id: string): void {
    sessionStorage.setItem(this.storageKey(), id);
  }
  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  private release(url: string): void {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
}
