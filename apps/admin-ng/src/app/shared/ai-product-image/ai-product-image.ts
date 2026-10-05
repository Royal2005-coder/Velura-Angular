import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AdminSessionService } from '../../core/admin-session.service';
import { AdminAiEngineService, AiCapabilities, AiJob } from '../../core/admin-ai-engine.service';

/** Non-destructive per-image quality and enhancement preview; emits a final file only after approval. */
@Component({
  selector: 'app-ai-product-image',
  standalone: true,
  templateUrl: './ai-product-image.html',
  styleUrl: './ai-product-image.css',
})
export class AiProductImage {
  readonly productId = input('');
  readonly accepted = output<File>();
  private readonly model = inject(AdminAiEngineService);
  private readonly session = inject(AdminSessionService);
  private readonly destroy = inject(DestroyRef);
  readonly capabilities = signal<AiCapabilities | null>(null);
  readonly preview = signal('');
  readonly result = signal('');
  readonly error = signal('');
  readonly busy = signal(false);
  readonly consent = signal(false);
  readonly background = signal<'white' | 'transparent'>('white');
  readonly brightness = signal(false);
  readonly sharpness = signal(false);
  /** Selects the requested background before generating an optional preview. */
  chooseBackground(event: Event): void {
    this.background.set(
      (event.target as HTMLSelectElement).value === 'transparent' ? 'transparent' : 'white',
    );
  }
  /** Optional bounded pixel adjustments are separate from AI segmentation. */
  adjust(event: Event, kind: 'brightness' | 'sharpness'): void {
    this[kind].set((event.target as HTMLInputElement).checked);
  }
  readonly job = signal<AiJob | null>(null);
  readonly qualityPassed = signal(false);
  readonly canAssess = computed(
    () => this.capabilities()?.tasks.some((t) => t.task === 'image_quality' && t.enabled) === true,
  );
  readonly canIndex = computed(
    () =>
      this.productId() !== '' &&
      this.capabilities()?.tasks.some((t) => t.task === 'image_embedding' && t.enabled) === true,
  );
  readonly canEnhance = computed(
    () =>
      this.capabilities()?.tasks.some((t) => t.task === 'product_image_enhance' && t.enabled) ===
      true,
  );
  /** Measured quality and inference success are distinct states for the operator. */
  statusLabel(job: AiJob): string {
    if (job.status === 'queued') return 'Đang chờ xử lý';
    if (job.status === 'running') return 'Đang xử lý ảnh';
    if (job.status === 'success')
      return job.task === 'image_quality'
        ? job.gate?.valid === true
          ? 'Ảnh đạt yêu cầu chất lượng.'
          : 'Ảnh chưa đạt yêu cầu chất lượng.'
        : job.task === 'image_embedding'
          ? 'Đã lập chỉ mục tìm kiếm ảnh.'
          : 'Đã có ảnh xem trước. Hãy kiểm tra và xác nhận.';
    return job.status === 'cancelled' ? 'Đã hủy tác vụ' : 'Chưa hoàn tất xử lý ảnh';
  }
  /** Shows actionable quality guidance instead of internal diagnostic codes. */
  reasonLabel(reason: string): string {
    return (
      (
        {
          LOW_RESOLUTION: 'Ảnh quá nhỏ; cần ảnh có độ phân giải cao hơn.',
          TOO_DARK: 'Ảnh thiếu sáng.',
          OVEREXPOSED: 'Ảnh bị cháy sáng.',
          BLURRY: 'Ảnh bị mờ; chọn ảnh rõ nét hơn.',
        } as Record<string, string>
      )[reason] || 'Ảnh chưa phù hợp. Kiểm tra bố cục hoặc chọn ảnh khác.'
    );
  }
  private file: File | null = null;
  private resultBlob: Blob | null = null;
  private asset = '';
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Resumes only an opaque job ID from this tab; source photographs are never persisted in browser storage. */
  async resume(): Promise<void> {
    const id = sessionStorage.getItem(this.storageKey());
    if (!id || this.busy()) return;
    const epoch = ++this.generation;
    this.busy.set(true);
    try {
      this.job.set((await firstValueFrom(this.model.job(id))).job);
      await this.poll(epoch);
    } catch {
      if (epoch === this.generation) {
        this.busy.set(false);
        this.error.set(
          'Tác vụ hết hạn hoặc chưa truy cập được. Ảnh sản phẩm hiện tại không thay đổi.',
        );
      }
    }
  }
  private storageKey(): string {
    return `velura_admin_ai_${this.session.session()?.id || 'anonymous'}_${this.productId() || 'draft'}`;
  }
  constructor() {
    effect(() => {
      this.session.session()?.id;
      untracked(() => {
        this.generation++;
        if (this.timer) clearTimeout(this.timer);
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
        this.resultBlob = null;
      });
    });
    this.destroy.onDestroy(() => {
      this.generation++;
      if (this.timer) clearTimeout(this.timer);
      this.release(this.preview());
      this.release(this.result());
    });
  }
  /** Checks actual engine readiness before transferring any product image. */
  async load(): Promise<void> {
    try {
      this.capabilities.set(await firstValueFrom(this.model.capabilities()));
    } catch {
      this.error.set('Dịch vụ AI chưa sẵn sàng. Ảnh gốc được giữ nguyên.');
    }
  }
  /** Selects one source image for review; it does not change the catalog. */
  select(event: Event): void {
    const el = event.target as HTMLInputElement;
    const file = el.files?.[0];
    el.value = '';
    if (!file || this.busy()) return;
    if (
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
      file.size > (this.capabilities()?.max_upload_bytes || 5 * 1024 * 1024)
    ) {
      this.error.set('Chọn ảnh JPG, PNG hoặc WebP trong giới hạn dung lượng.');
      return;
    }
    this.generation++;
    this.release(this.preview());
    this.release(this.result());
    this.preview.set(URL.createObjectURL(file));
    this.result.set('');
    this.resultBlob = null;
    this.asset = '';
    this.file = file;
    this.job.set(null);
    this.qualityPassed.set(false);
    this.error.set('');
    this.consent.set(false);
  }
  /** Requires image rights confirmation for each new photo. */
  agree(event: Event): void {
    this.consent.set((event.target as HTMLInputElement).checked);
  }
  /** Returns a measured quality report without changing an image. */
  async assess(): Promise<void> {
    if (this.canAssess()) await this.run('image_quality');
  }
  /** Applies foreground-preserving studio enhancement, never automatic catalog replacement. */
  async enhance(): Promise<void> {
    if (this.canEnhance()) await this.run('product_image_enhance');
  }
  /** Explicit original approval preserves the exact selected bytes. */
  useOriginal(): void {
    if (this.file && !this.busy() && this.qualityPassed()) this.accepted.emit(this.file);
  }
  /** Indexes the server-selected published product image; customer photos are never added to the catalog. */
  async indexProduct(): Promise<void> {
    if (!this.canIndex() || this.busy()) return;
    const epoch = ++this.generation;
    this.busy.set(true);
    try {
      const response = await firstValueFrom(
        this.model.create({
          task: 'image_embedding',
          catalog_index: true,
          product_id: this.productId(),
          consent: true,
          confirmed: true,
          idempotency_key: crypto.randomUUID(),
        }),
      );
      if (epoch !== this.generation) return;
      this.job.set(response.job);
      sessionStorage.setItem(this.storageKey(), response.job.id);
      await this.poll(epoch);
    } catch {
      if (epoch === this.generation) {
        this.busy.set(false);
        this.error.set('Chưa lập được chỉ mục ảnh sản phẩm. Thử lại sau.');
      }
    }
  }
  /** Explicit improved-image approval is the only point that emits processed bytes to the editor. */
  useEnhanced(): void {
    if (this.resultBlob && !this.busy())
      this.accepted.emit(
        new File([this.resultBlob], 'product-ai.png', {
          type: this.resultBlob.type || 'image/png',
        }),
      );
  }
  /** Cancels work and ignores late successful completions. */
  async cancel(): Promise<void> {
    const id = this.job()?.id;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.busy.set(false);

    if (id) {
      try {
        await firstValueFrom(this.model.cancel(id));
      } catch {
        this.error.set(
          'Chưa xác nhận được thao tác hủy. Kiểm tra lại trạng thái trước khi thử tiếp.',
        );
      }
    }
  }
  private async run(task: 'image_quality' | 'product_image_enhance'): Promise<void> {
    if (!this.file || !this.consent() || this.busy()) return;
    const epoch = ++this.generation;
    this.busy.set(true);
    this.error.set('');
    try {
      if (!this.asset) {
        const upload = await firstValueFrom(this.model.upload(this.file));
        if (epoch !== this.generation) return;
        this.asset = upload.asset_id;
      }
      const response = await firstValueFrom(
        this.model.create({
          task,
          background: this.background(),
          brightness: this.brightness(),
          sharpness: this.sharpness(),
          image_asset_id: this.asset,
          consent: true,
          confirmed: true,
          idempotency_key: crypto.randomUUID(),
        }),
      );
      if (epoch !== this.generation) return;
      this.job.set(response.job);
      sessionStorage.setItem(this.storageKey(), response.job.id);
      await this.poll(epoch);
    } catch {
      if (epoch === this.generation) {
        this.busy.set(false);
        this.error.set('AI chưa xử lý được ảnh. Giữ ảnh gốc hoặc thử lại.');
      }
    }
  }
  private async poll(epoch: number): Promise<void> {
    const job = this.job();
    if (!job || epoch !== this.generation) return;
    if (job.status === 'queued' || job.status === 'running') {
      this.timer = setTimeout(async () => {
        try {
          const response = await firstValueFrom(this.model.job(job.id));
          if (epoch !== this.generation) return;
          this.job.set(response.job);
          await this.poll(epoch);
        } catch {
          if (epoch === this.generation) {
            this.busy.set(false);
            this.error.set('Mất kết nối. Ảnh gốc chưa bị thay đổi.');
          }
        }
      }, 1500);
      return;
    }
    this.busy.set(false);
    if (job.status === 'success' && job.task === 'image_quality')
      this.qualityPassed.set(job.gate?.valid === true);
    if (job.status === 'success' && job.task === 'product_image_enhance') {
      const blob = await firstValueFrom(this.model.result(job.id));
      if (epoch !== this.generation) return;
      this.resultBlob = blob;
      this.release(this.result());
      this.result.set(URL.createObjectURL(blob));
    }
  }
  private release(url: string): void {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
}
