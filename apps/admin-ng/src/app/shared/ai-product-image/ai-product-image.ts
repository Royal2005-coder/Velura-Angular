import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AdminSessionService } from '../../core/admin-session.service';
import { AdminAiEngineService, AiCapabilities, AiJob } from '../../core/admin-ai-engine.service';
import { ProductImageApprovalService, ProductImageApproval } from '../../core/product-image-approval.service';

/** Review only new/replacement uploads; a measured original needs no enhancement, and approval never publishes. */
@Component({
  selector: 'app-ai-product-image',
  standalone: true,
  templateUrl: './ai-product-image.html',
  styleUrl: './ai-product-image.css',
})
export class AiProductImage {
  readonly productId = input('');
  readonly expectedVersion = input(0);
  readonly sourceFile = input<File | null>(null);
  readonly existingImage = input('');
  readonly accepted = output<ProductImageApproval>();
  private readonly model = inject(AdminAiEngineService);
  private readonly approvals = inject(ProductImageApprovalService);
  private readonly session = inject(AdminSessionService);
  private readonly destroy = inject(DestroyRef);
  readonly capabilities = signal<AiCapabilities | null>(null);
  readonly preview = signal('');
  readonly result = signal('');
  readonly error = signal('');
  readonly busy = signal(false);
  readonly consent = signal(false);
  readonly visuallyReviewed = signal(false);
  readonly selected = signal<'original' | 'enhanced' | null>(null);
  readonly approved = signal<ProductImageApproval | null>(null);
  readonly background = signal<'white' | 'transparent'>('white');
  readonly brightness = signal(false);
  readonly sharpness = signal(false);
  readonly job = signal<AiJob | null>(null);
  readonly originalJob = signal<AiJob | null>(null);
  readonly enhancedJob = signal<AiJob | null>(null);
  readonly canMutate = computed(() => this.session.canMutate('products'));
  readonly qualityPassed = computed(() => this.originalJob()?.gate?.valid === true);
  readonly enhancedPassed = computed(() => this.enhancedJob()?.gate?.valid === true && !!this.result());
  readonly canAssess = computed(() => this.canMutate() && this.capabilities()?.tasks.some((t) => t.task === 'image_quality' && t.enabled) === true);
  readonly canEnhance = computed(() => this.canMutate() && this.capabilities()?.tasks.some((t) => t.task === 'product_image_enhance' && t.enabled) === true);
  readonly canApprove = computed(() => this.canMutate() && this.consent() && this.visuallyReviewed() && !this.busy() && !this.approved() &&
    (this.selected() === 'original' ? this.qualityPassed() : this.selected() === 'enhanced' && this.enhancedPassed()));
  private file: File | null = null;
  private sourceRevision = '';
  private asset = '';
  private generation = 0;
  private timer: number | undefined;

  constructor() {
    effect(() => {
      this.session.session()?.id;
      this.productId();
      this.expectedVersion();
      const file = this.sourceFile();
      untracked(() => {
        this.reset();
        if (file) void this.selectFile(file);
      });
    });
    this.destroy.onDestroy(() => this.reset());
  }

  private reset(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.release(this.preview());
    this.release(this.result());
    this.preview.set('');
    this.result.set('');
    this.job.set(null);
    this.originalJob.set(null);
    this.enhancedJob.set(null);
    this.approved.set(null);
    this.selected.set(null);
    this.busy.set(false);
    this.consent.set(false);
    this.visuallyReviewed.set(false);
    this.file = null;
    this.asset = '';
    this.sourceRevision = '';
    this.error.set('');
  }

  /** Quality measurement is CPU-only and remains useful when an enhancement model is unavailable. */
  async load(): Promise<void> {
    if (!this.canMutate()) return;
    try {
      this.capabilities.set(await firstValueFrom(this.model.capabilities()));
    } catch {
      this.error.set('Chưa truy cập được dịch vụ kiểm tra ảnh. Ảnh đã công bố được giữ nguyên.');
    }
  }


  private async selectFile(file: File): Promise<void> {
    if (!this.canMutate() || this.busy()) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024 || file.size === 0) {
      this.error.set('Chọn ảnh JPG, PNG hoặc WebP không quá 5 MB.');
      return;
    }
    const epoch = ++this.generation;
    let revision: string;
    try {
      const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      revision = Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
    } catch {
      this.error.set('Chưa đọc được ảnh mới. Ảnh đã công bố được giữ nguyên.');
      return;
    }
    if (epoch !== this.generation || revision === this.sourceRevision) return;
    this.reset();
    this.sourceRevision = revision;
    this.file = file;
    this.preview.set(URL.createObjectURL(file));
  }

  /** Confirm usage rights separately for each distinct source image. */
  agree(event: Event): void {
    this.consent.set((event.target as HTMLInputElement).checked);
  }

  /** Require a human comparison; segmentation and quality scores cannot prove garment fidelity. */
  review(event: Event): void {
    this.visuallyReviewed.set((event.target as HTMLInputElement).checked);
  }

  /** Request a background without changing hue, product geometry or pattern intentionally. */
  chooseBackground(event: Event): void {
    this.background.set((event.target as HTMLSelectElement).value === 'transparent' ? 'transparent' : 'white');
  }

  /** Optional bounded photometric changes remain distinct from generative image synthesis. */
  adjust(event: Event, kind: 'brightness' | 'sharpness'): void {
    this[kind].set((event.target as HTMLInputElement).checked);
  }

  /** An unchanged upload reuses its completed quality job instead of repeating assessment. */
  async assess(): Promise<void> {
    if (this.originalJob()?.status === 'success' || this.originalJob()?.status === 'validation_failed') return;
    if (this.canAssess()) await this.run('image_quality');
  }

  /** The deliberate Improve action is the only route to enhancement inference. */
  async enhance(): Promise<void> {
    if (this.canEnhance()) await this.run('product_image_enhance');
  }

  /** Select the exact measured original; selecting alone does not approve or publish it. */
  useOriginal(): void {
    if (!this.busy() && this.qualityPassed()) {
      this.selected.set('original');
      this.visuallyReviewed.set(false);
    }
  }

  /** Select the validated output for comparison; selecting alone does not approve or publish it. */
  useEnhanced(): void {
    if (!this.busy() && this.enhancedPassed()) {
      this.selected.set('enhanced');
      this.visuallyReviewed.set(false);
    }
  }

  /** Stage a reviewed selection and emit only its server-attested URL; the editor must still save successfully. */
  async approve(): Promise<void> {
    if (!this.canApprove()) return;
    const selection = this.selected();
    const job = selection === 'original' ? this.originalJob() : this.enhancedJob();
    if (!selection || !job) return;
    const epoch = this.generation;
    this.busy.set(true);
    this.error.set('');
    try {
      const approval = await firstValueFrom(this.approvals.approve({
        productId: this.productId() || null, expectedVersion: this.expectedVersion(),
        jobId: job.id, selection, reviewConfirmed: true,
      }));
      if (epoch !== this.generation) return;
      this.approved.set(approval);
      this.accepted.emit(approval);
    } catch {
      if (epoch === this.generation) this.error.set('Chưa phê duyệt được ảnh hoặc sản phẩm đã đổi phiên bản. Ảnh đã công bố được giữ nguyên.');
    } finally {
      if (epoch === this.generation) this.busy.set(false);
    }
  }

  /** Invalidate pending responses before asking the server to cancel a job. */
  async cancel(): Promise<void> {
    const id = this.job()?.id;
    this.generation++;
    clearTimeout(this.timer);
    this.busy.set(false);
    this.job.set(null);
    if (id) {
      try { await firstValueFrom(this.model.cancel(id)); }
      catch { this.error.set('Chưa xác nhận được thao tác hủy. Ảnh đã công bố được giữ nguyên.'); }
    }
  }

  /** Show measured quality and execution status as separate outcomes. */
  statusLabel(job: AiJob): string {
    if (job.status === 'queued') return 'Đang chờ xử lý';
    if (job.status === 'running') return 'Đang xử lý ảnh';
    if (job.status === 'success') return job.gate?.valid === true ? 'Ảnh đạt ngưỡng đo; vẫn cần chọn và phê duyệt.' : 'Ảnh chưa đạt ngưỡng chất lượng.';
    if (job.status === 'validation_failed') return 'Ảnh chưa đạt ngưỡng chất lượng.';
    return job.status === 'cancelled' ? 'Đã hủy tác vụ' : 'Chưa hoàn tất xử lý ảnh';
  }

  /** Explain failed measurements without claiming an automated fashion-fidelity check. */
  reasonLabel(reason: string): string {
    return ({ LOW_RESOLUTION: 'Ảnh quá nhỏ.', TOO_DARK: 'Ảnh thiếu sáng.', OVEREXPOSED: 'Ảnh bị cháy sáng.',
      BLURRY: 'Ảnh bị mờ.', BACKGROUND_BUSY: 'Nền ảnh chưa phù hợp.' } as Record<string, string>)[reason] || 'Kiểm tra chất lượng hoặc chọn ảnh khác.';
  }

  private async run(task: 'image_quality' | 'product_image_enhance'): Promise<void> {
    if (!this.file || !this.consent() || this.busy() || this.approved()) return;
    const epoch = ++this.generation;
    this.busy.set(true);
    this.error.set('');
    if (task === 'product_image_enhance') {
      this.release(this.result());
      this.result.set('');
      this.enhancedJob.set(null);
      this.selected.set(null);
      this.visuallyReviewed.set(false);
    }
    try {
      if (!this.asset) {
        const upload = await firstValueFrom(this.model.upload(this.file));
        if (epoch !== this.generation) return;
        this.asset = upload.asset_id;
      }
      const response = await firstValueFrom(this.model.create({
        task, background: this.background(), brightness: this.brightness(), sharpness: this.sharpness(),
        image_asset_id: this.asset, consent: true, confirmed: true, idempotency_key: crypto.randomUUID(),
      }));
      if (epoch !== this.generation) return;
      this.job.set(response.job);
      await this.poll(epoch);
    } catch {
      if (epoch === this.generation) {
        this.busy.set(false);
        this.error.set('Chưa xử lý được ảnh. Ảnh đã công bố được giữ nguyên.');
      }
    }
  }

  private async poll(epoch: number): Promise<void> {
    const job = this.job();
    if (!job || epoch !== this.generation) return;
    if (job.status === 'queued' || job.status === 'running') {
      this.timer = window.setTimeout(async () => {
        try {
          const response = await firstValueFrom(this.model.job(job.id));
          if (epoch !== this.generation) return;
          this.job.set(response.job);
          await this.poll(epoch);
        } catch {
          if (epoch === this.generation) { this.busy.set(false); this.error.set('Mất kết nối. Ảnh đã công bố được giữ nguyên.'); }
        }
      }, 1500);
      return;
    }
    if (job.task === 'image_quality') this.originalJob.set(job);
    if (job.status === 'success' && job.task === 'product_image_enhance' && job.gate?.valid === true) {
      const blob = await firstValueFrom(this.model.result(job.id));
      if (epoch !== this.generation) return;
      this.enhancedJob.set(job);
      this.result.set(URL.createObjectURL(blob));
    }
    if (epoch === this.generation) this.busy.set(false);
  }

  private release(url: string): void {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
}
