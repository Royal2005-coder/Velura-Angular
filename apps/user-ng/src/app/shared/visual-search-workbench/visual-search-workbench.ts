import { Component, DestroyRef, ElementRef, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { VisualSearchModel, type VisualAttributes, type VisualFilters, type VisualResult } from '../../core/services/visual-search.service';
import { ProductCard } from '../product-card/product-card';

/** Maps Gemini Vision detected categories to Velura catalog slugs. */
const CATEGORY_QUERY_MAP: Record<string, string> = {
  top: 'ao', blouse: 'ao', shirt: 'ao', tshirt: 'ao',
  pants: 'quan', trousers: 'quan', jeans: 'quan',
  dress: 'dam-vay', skirt: 'dam-vay',
  jacket: 'ao-khoac', coat: 'ao-khoac', blazer: 'ao-khoac',
  set: 'set-do', suit: 'set-do',
  accessories: 'phu-kien', bag: 'phu-kien', hat: 'phu-kien', scarf: 'phu-kien',
  shoes: 'giay-dep', sandals: 'giay-dep', boots: 'giay-dep', sneakers: 'giay-dep',
};
const CATEGORY_LABELS: Record<string, string> = {
  ao: 'Áo', quan: 'Quần', 'dam-vay': 'Đầm & Váy', 'ao-khoac': 'Áo khoác',
  'set-do': 'Set đồ', 'phu-kien': 'Phụ kiện', 'giay-dep': 'Giày dép',
};

/** Consent-first camera search with single-garment crop and source-free refinements. */
@Component({ selector: 'app-visual-search-workbench', standalone: true, imports: [ProductCard, RouterLink], templateUrl: './visual-search-workbench.html', styleUrl: './visual-search-workbench.css' })
export class VisualSearchWorkbench {
  readonly hideTrigger = input(false);
  readonly candidateProductIds = input<string[] | undefined>();
  readonly filters = input<VisualFilters>({});
  readonly matches = output<string[]>();
  readonly searchResult = output<VisualResult>();
  readonly attributeKeys: Array<keyof VisualAttributes> = ['category', 'color', 'fit', 'material', 'style'];
  readonly labels: Record<keyof VisualAttributes, string> = { category: 'Loại trang phục', color: 'Màu sắc', fit: 'Phom dáng', material: 'Chất liệu', style: 'Phong cách' };
  readonly cropKeys = ['x', 'y', 'width', 'height'] as const;
  readonly cropLabels = { x: 'Vị trí ngang', y: 'Vị trí dọc', width: 'Chiều rộng', height: 'Chiều cao' };
  readonly titleId = `visual-${crypto.randomUUID()}`;
  readonly preview = signal('');
  readonly crop = signal({ x: 0, y: 0, width: 100, height: 100 });
  readonly consent = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly result = signal<VisualResult | null>(null);
  readonly attributes = signal<VisualAttributes>({ category: null, color: null, fit: null, material: null, style: null });
  readonly keywords = signal('');
  readonly cameraOpen = signal(false);
  private readonly model = inject(VisualSearchModel);
  private readonly auth = inject(AuthService);
  private readonly destroy = inject(DestroyRef);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private file: File | null = null;
  private stream?: MediaStream;
  private requestId = '';
  private subscription?: Subscription;
  private epoch = 0;
  private refineTimer?: ReturnType<typeof setTimeout>;
  constructor() {
    effect(() => { this.auth.session(); untracked(() => { this.cancel(); this.result.set(null); }); });
    effect(() => {
      this.candidateProductIds(); this.filters();
      untracked(() => {
        if (!this.result() || this.busy()) return;
        clearTimeout(this.refineTimer);
        this.refineTimer = setTimeout(() => this.refine(), 350);
      });
    });
    this.destroy.onDestroy(() => { clearTimeout(this.refineTimer); this.cancel(); });
  }
  /** Existing header camera calls the same accessible modal entry point. */
  open(): void { this.error.set(''); this.dialog()?.nativeElement.showModal(); }
  /** Close and cancel both browser and server work, revoking every source preview. */
  close(): void { this.cancel(); this.dialog()?.nativeElement.close(); }
  /** Handle the dialog Escape event without leaving inference or camera streams running. */
  escape(event: Event): void { event.preventDefault(); this.close(); }
  /** Upload picker and mobile capture both use the same decoded image validation. */
  select(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0]; if (file) void this.accept(file);
    input.value = '';
  }
  /** Accept exactly one dropped file, never remote image URLs. */
  drop(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer?.files.length !== 1) { this.error.set('Chỉ chọn một ảnh có một trang phục.'); return; }
    void this.accept(event.dataTransfer.files[0]);
  }
  /** Pasted raster files are validated identically to uploaded images. */
  paste(event: ClipboardEvent): void {
    const files = event.clipboardData?.files;
    if (!files?.length) return;
    event.preventDefault();
    if (files.length !== 1) { this.error.set('Chỉ dán một ảnh.'); return; }
    void this.accept(files[0]);
  }
  /** Expose precise crop controls; preview overlay shows exactly the selected region. */
  setCrop(event: Event, key: typeof this.cropKeys[number]): void {
    this.crop.update(value => ({ ...value, [key]: Number((event.target as HTMLInputElement).value) }));
    this.consent.set(false);
  }
  /** Replace preview with cropped pixels before explicit confirmation. */
  async applyCrop(): Promise<void> {
    if (!this.file || this.busy()) return;
    try { await this.accept(await this.model.crop(this.file, this.crop())); }
    catch { this.error.set('Vùng ảnh chưa hợp lệ hoặc ảnh cắt vượt 5 MB. Kiểm tra vị trí và kích thước.'); }
  }
  /** Consent never carries across file/crop changes. */
  setConsent(event: Event): void { this.consent.set((event.target as HTMLInputElement).checked); }
  /** Capture live camera using browser permissions; permission errors do not pretend success. */
  async camera(): Promise<void> {
    if (this.busy()) return;
    const epoch = this.epoch;
    this.error.set(''); this.cameraOpen.set(true);
    try {
      const stream = await this.model.camera();
      if (epoch !== this.epoch) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stopCamera(); this.cameraOpen.set(true); this.stream = stream;
      const video = this.video()?.nativeElement;
      if (!video) throw new Error('Máy ảnh chưa sẵn sàng.');
      video.srcObject = stream; await video.play();
    } catch { this.stopCamera(); this.error.set('Không mở được máy ảnh. Cho phép truy cập máy ảnh hoặc chọn ảnh từ thiết bị.'); }
  }
  /** Keep only a single captured frame; release the camera immediately. */
  async capture(): Promise<void> {
    const video = this.video()?.nativeElement; if (!video) return;
    try { const file = await this.model.capture(video); this.stopCamera(); await this.accept(file); }
    catch { this.error.set('Chưa chụp được ảnh. Đợi máy ảnh sẵn sàng hoặc chọn tệp.'); }
  }
  /** Search only the consented preview; non-default crop must first be applied visibly. */
  search(): void {
    if (!this.file || !this.consent() || this.busy()) return;
    const crop = this.crop();
    if (crop.x || crop.y || crop.width !== 100 || crop.height !== 100) { this.error.set('Áp dụng vùng ảnh trước khi xác nhận tìm kiếm.'); return; }
    this.begin(false);
  }
  /** Attributes may be changed or removed without uploading the deleted source image. */
  edit(event: Event, key: keyof VisualAttributes): void { this.attributes.update(value => ({ ...value, [key]: (event.target as HTMLInputElement).value.trim() || null })); }
  /** Keywords are independent of extracted attributes and can be cleared. */
  editKeywords(event: Event): void { this.keywords.set((event.target as HTMLInputElement).value); }
  /** Requery current attributes and catalog filters using the refinement token only. */
  refine(): void { if (this.result() && !this.busy()) this.begin(true); }
  /** Abort HTTP callbacks and revoke source data on all cancellation paths. */
  cancel(): void {
    clearTimeout(this.refineTimer);
    this.epoch++;
    this.subscription?.unsubscribe();
    if (this.requestId) this.model.cancel(this.requestId).subscribe({ error: () => undefined });
    this.requestId = ''; this.busy.set(false); this.clearSource(); this.stopCamera();
  }
  private async accept(file: File): Promise<void> {
    if (this.busy()) return;
    this.cancel(); const epoch = this.epoch; this.error.set(''); this.result.set(null);
    try {
      await this.model.validate(file);
      if (epoch !== this.epoch) return;
      this.file = file; this.preview.set(URL.createObjectURL(file)); this.crop.set({ x: 0, y: 0, width: 100, height: 100 });
    } catch (error) { if (epoch === this.epoch) this.error.set(error instanceof Error ? error.message : 'Không đọc được ảnh.'); }
  }
  private begin(refine: boolean): void {
    const result = this.result();
    const requestId = crypto.randomUUID(), epoch = ++this.epoch;
    this.requestId = requestId; this.busy.set(true); this.error.set('');
    const filters = { ...this.filters(), ...(this.candidateProductIds() !== undefined ? { product_ids: this.candidateProductIds() } : {}) };
    const request = refine && result ? this.model.refine(result, requestId, this.attributes(), this.keywords(), filters) : this.model.search(this.file!, requestId, filters);
    this.subscription = request.subscribe({
      next: response => {
        if (epoch !== this.epoch) return;
        this.result.set(response); this.attributes.set(response.attributes); this.keywords.set(response.keywords);
        this.matches.emit(response.matches.map(row => row.product_id)); this.searchResult.emit(response);
        this.finish();
      },
      error: (error: unknown) => {
        if (epoch !== this.epoch) return;
        const payload = error as { error?: { code?: string; message?: string; error?: string } };
        this.error.set(payload.error?.message || payload.error?.error || 'Chưa tìm được bằng ảnh. Vui lòng thử lại.'); this.finish();
      },
    });
  }
  private finish(): void { this.requestId = ''; this.busy.set(false); this.clearSource(); }
  private clearSource(): void { if (this.preview()) URL.revokeObjectURL(this.preview()); this.preview.set(''); this.file = null; this.consent.set(false); }
  private stopCamera(): void { this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined; this.cameraOpen.set(false); }
  /** Map Gemini Vision category to Velura catalog slug for routing. */
  mapCategory(category: string | null): string {
    if (!category) return '';
    const lower = category.toLowerCase().trim();
    return CATEGORY_QUERY_MAP[lower] || lower;
  }
  /** Human-readable Vietnamese category label for UI display. */
  categoryLabel(category: string | null): string {
    const slug = this.mapCategory(category);
    return CATEGORY_LABELS[slug] || category || '';
  }
}
