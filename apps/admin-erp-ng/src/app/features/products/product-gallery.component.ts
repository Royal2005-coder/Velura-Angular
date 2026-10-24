import { ChangeDetectionStrategy, Component, computed, inject, input, model, signal } from '@angular/core';
import { finalize } from 'rxjs';
import { AdminErpApiService, AdminImageApproval, AdminImageQualityAnalysis } from '../../core/admin-erp-api.service';
import { MAX_PRODUCT_IMAGES, moveImageKey } from '../../core/admin-erp-catalog';
import { adminErrorMessage } from '../../core/admin-erp-http';
import { AdminErpIcon } from '../../shared/ui/admin-erp-icon';
import { AdminBadgeTone, AdminErpStatusBadge } from '../../shared/ui/admin-status-badge';

type StudioBackground = 'studio_white' | 'velura_cream' | 'transparent' | 'keep';

const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Product gallery editor with the studio image pipeline. The operator picks a slot,
 * uploads or enhances a picture, and only a server-approved URL may enter the list —
 * an unreviewed URL is refused here and by the API on save.
 */
@Component({
  selector: 'app-erp-product-gallery',
  imports: [AdminErpIcon, AdminErpStatusBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './product-gallery.component.html',
  styleUrl: './product-gallery.component.scss',
})
export class ProductGalleryComponent {
  private readonly api = inject(AdminErpApiService);

  /** Gallery URLs; index 0 is always the primary image. */
  readonly images = model<string[]>([]);
  /** Image URL to variant color; URLs without an entry are common shots. */
  readonly imageColors = model<Record<string, string>>({});
  /** Approvals staged this session; the product save may only publish these URLs. */
  readonly approvals = model<AdminImageApproval[]>([]);
  /** True while an image step runs, so the editor cannot publish a half-finished URL. */
  readonly busy = model(false);
  /** Colors the operator may attach to a gallery image. */
  readonly variantColors = input<readonly string[]>([]);
  /** Product being edited; `null` marks a create, which approves against version 0. */
  readonly productId = input<string | null>(null);
  /** Version the approval must match; the API requires 0 for a new product. */
  readonly expectedVersion = input(0);
  readonly editable = input(false);
  /** Hint for the vision model; the server falls back to a generic label when empty. */
  readonly productName = input('');

  readonly slot = signal(0);
  readonly note = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly analysis = signal<AdminImageQualityAnalysis | null>(null);
  readonly enhanced = signal<{ url: string; model: string; after: AdminImageQualityAnalysis } | null>(null);
  readonly background = signal<StudioBackground>('studio_white');
  readonly lighting = signal(true);
  readonly sharpness = signal(true);
  readonly upscale = signal(true);
  /** Quality report of each measured URL, so a score follows the image actually saved. */
  readonly scores = signal<Record<string, AdminImageQualityAnalysis>>({});
  /** Data URL of the file just chosen, before the server has produced a URL for it. */
  readonly pendingDataUrl = signal('');
  /** Server URL of the pending upload, produced by the quality measurement. */
  readonly originalUrl = signal('');

  private pendingMime = 'image/jpeg';
  private sequence = 0;

  readonly maxImages = MAX_PRODUCT_IMAGES;
  readonly hasPending = computed(() => this.pendingDataUrl().length > 0);
  readonly canApply = computed(
    () => this.editable() && !this.busy() && (this.enhanced() !== null || this.originalUrl().length > 0),
  );
  readonly scoreTone = computed<AdminBadgeTone>(() => {
    const report = this.analysis();
    if (!report) {
      return 'neutral';
    }
    if (report.passed) {
      return 'success';
    }
    return report.grade === 'D' ? 'danger' : 'warning';
  });

  /**
   * Chooses a saved image or the append slot and drops an unpublished preview.
   */
  selectSlot(index: number): void {
    this.sequence++;
    this.slot.set(index);
    this.pendingDataUrl.set('');
    this.originalUrl.set('');
    this.enhanced.set(null);
    this.error.set(null);
    const url = this.images()[index];
    if (url) {
      this.analysis.set(this.scores()[url] || null);
      this.note.set(this.scores()[url] ? 'Ảnh đang chọn đã được kiểm định.' : null);
    } else {
      this.analysis.set(null);
    }
  }

  /**
   * Reads a chosen file and measures its studio quality.
   */
  onFilePicked(event: Event): void {
    const picker = event.target as HTMLInputElement;
    const file = picker.files?.[0];
    picker.value = '';
    if (!file || !this.editable()) {
      return;
    }
    if (this.slot() >= this.images().length && this.images().length >= MAX_PRODUCT_IMAGES) {
      this.error.set(`Tối đa ${MAX_PRODUCT_IMAGES} ảnh cho mỗi sản phẩm.`);
      return;
    }
    if (!ACCEPTED_MIME.includes(file.type) || file.size > MAX_UPLOAD_BYTES) {
      this.error.set('Vui lòng chọn ảnh JPG, PNG hoặc WebP dưới 8 MB.');
      return;
    }
    this.error.set(null);
    this.enhanced.set(null);
    this.pendingMime = file.type;
    this.note.set('Đang phân tích chất lượng ảnh vừa tải lên...');
    this.busy.set(true);
    const reader = new FileReader();
    reader.onload = () => {
      this.busy.set(false);
      const dataUrl = String(reader.result || '');
      this.pendingDataUrl.set(dataUrl);
      this.originalUrl.set('');
      if (!dataUrl) {
        this.error.set('Chưa đọc được ảnh vừa chọn. Vui lòng chọn lại ảnh.');
        return;
      }
      this.analyze();
    };
    reader.onerror = () => {
      this.busy.set(false);
      this.error.set('Chưa đọc được ảnh vừa chọn. Vui lòng chọn lại ảnh.');
    };
    reader.readAsDataURL(file);
  }

  /**
   * Runs the quality measurement on the pending upload, or on the saved image in the slot.
   */
  analyze(): void {
    if (this.busy()) {
      return;
    }
    const pending = this.pendingDataUrl();
    const existingUrl = pending ? '' : this.imageUrlAtSlot();
    if (!pending && !existingUrl) {
      this.error.set('Chưa có ảnh để phân tích. Hãy tải ảnh lên hoặc chọn một ảnh trong thư viện.');
      return;
    }
    if (!pending && this.scores()[existingUrl]) {
      this.analysis.set(this.scores()[existingUrl] || null);
      return;
    }
    const sequence = ++this.sequence;
    this.busy.set(true);
    this.error.set(null);
    this.api
      .analyzeProductImage({
        ...(pending ? { imageBase64: pending, mimeType: this.pendingMime } : { imageUrl: existingUrl }),
        productName: this.productName(),
      })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (report) => {
          if (sequence !== this.sequence) {
            return;
          }
          if (typeof report?.overallScore !== 'number') {
            return;
          }
          const measuredUrl = pending ? report.uploadedUrl : existingUrl;
          if (measuredUrl) {
            this.scores.update((scores) => ({ ...scores, [measuredUrl]: report }));
          }
          if (pending && report.uploadedUrl) {
            this.originalUrl.set(report.uploadedUrl);
          }
          this.analysis.set(report);
          this.note.set(
            report.passed
              ? 'Ảnh đạt chuẩn studio. Dùng ảnh gốc hoặc bấm Cải thiện bằng AI.'
              : 'AI phát hiện điểm cần tối ưu về ánh sáng hoặc nền ảnh.',
          );
        },
        error: (error: unknown) => {
          if (sequence !== this.sequence) {
            return;
          }
          this.error.set(adminErrorMessage(error, 'Không phân tích được chất lượng ảnh lúc này.'));
        },
      });
  }

  /**
   * Produces the enhanced studio copy of the pending or selected image.
   */
  enhance(): void {
    if (!this.editable() || this.busy()) {
      return;
    }
    const pending = this.pendingDataUrl();
    const existingUrl = pending ? '' : this.imageUrlAtSlot();
    if (!pending && !existingUrl) {
      this.error.set('Hãy chọn hoặc tải ảnh lên trước khi cải thiện bằng AI.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.api
      .enhanceProductImage({
        ...(pending ? { imageBase64: pending, mimeType: this.pendingMime } : { imageUrl: existingUrl }),
        options: {
          background: this.background(),
          lighting: this.lighting(),
          sharpness: this.sharpness(),
          upscale: this.upscale(),
        },
      })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (result) => {
          if (!result?.enhancedUrl) {
            this.error.set('AI chưa trả về ảnh cải thiện. Hãy thử lại.');
            return;
          }
          this.sequence++;
          this.enhanced.set({ url: result.enhancedUrl, model: result.modelUsed || 'velura-studio', after: result.afterAnalysis });
          this.scores.update((scores) => ({ ...scores, [result.enhancedUrl]: result.afterAnalysis }));
          this.analysis.set(result.afterAnalysis);
          this.note.set('AI đã tạo bản ảnh studio. Bấm Áp dụng để ghi vào danh sách ảnh.');
        },
        error: (error: unknown) => this.error.set(adminErrorMessage(error, 'Chưa thể cải thiện ảnh lúc này.')),
      });
  }

  /**
   * Stores the operator's explicit choice as a server approval and puts its URL in the slot.
   */
  apply(): void {
    if (!this.editable() || this.busy()) {
      return;
    }
    const enhanced = this.enhanced();
    const url = enhanced?.url || this.originalUrl();
    if (!url) {
      this.error.set('Chưa có URL ảnh do máy chủ tạo để áp dụng.');
      return;
    }
    const report = enhanced ? enhanced.after : this.analysis();
    const replaced = this.images()[this.slot()] as string | undefined;
    this.busy.set(true);
    this.error.set(null);
    this.api
      .approveStudioImage({
        imageUrl: url,
        productId: this.productId(),
        expectedVersion: this.productId() ? this.expectedVersion() : 0,
        selection: enhanced ? 'enhanced' : 'original',
        reviewConfirmed: true,
      })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (approval) => {
          if (!approval?.approvalId || !approval.url) {
            this.error.set('Chưa lưu được phê duyệt ảnh. Ảnh hiện tại được giữ nguyên.');
            return;
          }
          const next = [...this.images()];
          const index = Math.min(this.slot(), next.length);
          if (next.includes(approval.url) && next[index] !== approval.url) {
            this.error.set('Ảnh này đã có trong sản phẩm.');
            return;
          }
          if (index >= next.length && next.length >= MAX_PRODUCT_IMAGES) {
            this.error.set(`Tối đa ${MAX_PRODUCT_IMAGES} ảnh cho mỗi sản phẩm.`);
            return;
          }
          if (report) {
            this.scores.update((scores) => ({
              ...scores,
              [approval.url]: { ...report, overallScore: approval.qualityScore ?? report.overallScore },
            }));
          }
          next.splice(index, index < next.length ? 1 : 0, approval.url);
          this.imageColors.set(moveImageKey(this.imageColors(), replaced, approval.url, replaced ? this.imageColors()[replaced] : null));
          this.images.set(next);
          this.approvals.set([...this.approvals().filter((row) => next.includes(row.url)), approval]);
          this.pendingDataUrl.set('');
          this.originalUrl.set('');
          this.enhanced.set(null);
          this.analysis.set(this.scores()[approval.url] || null);
          this.note.set('Đã áp dụng ảnh được máy chủ phê duyệt. Bấm Lưu để xuất bản.');
        },
        error: (error: unknown) => this.error.set(adminErrorMessage(error, 'Chưa áp dụng được ảnh. Ảnh hiện tại được giữ nguyên.')),
      });
  }

  /**
   * Moves an image to the primary slot without losing its color assignment.
   */
  makePrimary(index: number): void {
    if (!this.editable() || index <= 0 || this.hasPending()) {
      return;
    }
    const next = [...this.images()];
    if (index >= next.length) {
      return;
    }
    const [url] = next.splice(index, 1);
    next.unshift(url);
    this.images.set(next);
    this.slot.set(0);
  }

  /**
   * Removes an image and its color link, always keeping one primary.
   */
  removeAt(index: number): void {
    if (!this.editable()) {
      return;
    }
    const current = [...this.images()];
    if (index < 0 || index >= current.length) {
      return;
    }
    if (current.length === 1) {
      this.error.set('Phải giữ ít nhất một ảnh chính.');
      return;
    }
    const colors = { ...this.imageColors() };
    delete colors[current[index]];
    const scores = { ...this.scores() };
    delete scores[current[index]];
    this.scores.set(scores);
    this.imageColors.set(colors);
    current.splice(index, 1);
    this.images.set(current);
    this.approvals.set(this.approvals().filter((approval) => current.includes(approval.url)));
    const slot = Math.min(this.slot(), current.length - 1);
    this.slot.set(slot);
    this.selectSlot(slot);
  }

  /**
   * Attaches a gallery image to an existing variant color, or clears the link.
   */
  assignColor(url: string, event: Event): void {
    const color = (event.target as HTMLSelectElement).value;
    if (!this.editable() || (color && !this.variantColors().includes(color))) {
      return;
    }
    const next = { ...this.imageColors() };
    if (color) {
      next[url] = color;
    } else {
      delete next[url];
    }
    this.imageColors.set(next);
  }

  /**
   * Color currently bound to an image.
   */
  colorOf(url: string): string {
    return this.imageColors()[url] || '';
  }

  /**
   * Chooses the studio backdrop for the next enhancement.
   */
  setBackground(event: Event): void {
    this.background.set((event.target as HTMLSelectElement).value as StudioBackground);
  }

  /**
   * Toggles one enhancement flag.
   */
  setStudioFlag(flag: 'lighting' | 'sharpness' | 'upscale', event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    if (flag === 'lighting') {
      this.lighting.set(checked);
    } else if (flag === 'sharpness') {
      this.sharpness.set(checked);
    } else {
      this.upscale.set(checked);
    }
  }

  /**
   * Browser-resolvable URL for a stored asset path.
   */
  resolve(url: string): string {
    return url.replace('/src/assets/', '/assets/');
  }

  /**
   * Measured score of a saved image, or null when it was never measured this session.
   */
  scoreOf(url: string): number | null {
    return this.scores()[url]?.overallScore ?? null;
  }

  private imageUrlAtSlot(): string {
    const url = this.images()[this.slot()] || this.images()[0] || '';
    return url.startsWith('http') || url.includes('localhost') ? url : this.resolve(url);
  }
}
