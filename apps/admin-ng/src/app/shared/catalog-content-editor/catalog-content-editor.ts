import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AdminSessionService } from '../../core/admin-session.service';
import { AdminCatalogContentService, CatalogBatch, CatalogContent, CatalogDraft, CatalogSource } from '../../core/admin-catalog-content.service';

/** Saved-product and bulk SEO editor; generation, approval and publication are separate explicit actions. */
@Component({
  selector: 'app-catalog-content-editor', standalone: true,
  templateUrl: './catalog-content-editor.html', styleUrl: './catalog-content-editor.css',
})
export class CatalogContentEditor {
  readonly productId = input('');
  readonly expectedVersion = input(0);
  readonly products = input<{ productId: string; expectedVersion: number }[]>([]);
  readonly liveContent = input({ title: '', description: '', seoTitle: '', metaDescription: '', slug: '' });
  readonly published = output<string>();
  readonly sourceChanged = output<string>();
  private readonly model = inject(AdminCatalogContentService);
  private readonly session = inject(AdminSessionService);
  private readonly destroy = inject(DestroyRef);
  readonly canWrite = computed(() => this.session.canMutate('products'));
  readonly source = signal<CatalogSource | null>(null);
  readonly drafts = signal<CatalogDraft[]>([]);
  readonly selected = signal<CatalogDraft | null>(null);
  readonly batch = signal<CatalogBatch | null>(null);
  readonly editor = signal('');
  readonly factsEditor = signal('{}');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly message = signal('');
  readonly sourceFields = computed(() => Object.entries(this.source()?.fields || {}).map(([field, value]) => ({ field, value })));
  readonly preview = computed(() => {
    try { return JSON.parse(this.editor()) as CatalogContent; } catch { return null; }
  });
  readonly changedSinceApproval = computed(() => {
    const draft = this.selected();
    return !draft || this.editor() !== JSON.stringify(draft.reviewed || draft.generated, null, 2);
  });
  private epoch = 0;
  private timer: number | undefined;
  private pendingKey = '';
  private pendingProducts = '';
  constructor() {
    effect(() => {
      const product = this.productId();
      this.expectedVersion();
      this.products();
      this.session.session()?.id;
      untracked(() => {
        this.epoch++;
        window.clearTimeout(this.timer);
        this.timer = undefined;
        this.source.set(null); this.drafts.set([]); this.selected.set(null); this.batch.set(null);
        this.error.set(''); this.message.set(''); this.editor.set(''); this.busy.set(false);
        this.pendingKey = ''; this.pendingProducts = '';
        if (product && this.canWrite()) void this.load();
      });
    });
    this.destroy.onDestroy(() => { this.epoch++; window.clearTimeout(this.timer); });
  }
  /** Loads immutable history and latest verified context, never pulling facts from generated copy. */
  async load(): Promise<void> {
    const epoch = this.epoch;
    this.busy.set(true); this.error.set('');
    try {
      const response = await firstValueFrom(this.model.drafts(this.productId()));
      if (epoch !== this.epoch) return;
      this.source.set(response.source); this.drafts.set(response.drafts);
      const fields: Record<string, string[]> = {};
      for (const [field, value] of Object.entries(response.source.fields)) {
        const key = field.split('.')[0];
        if (['material', 'features', 'styling', 'care', 'tags'].includes(key) && !field.startsWith('tags.catalog.')) (fields[key] ||= []).push(value);
      }
      this.factsEditor.set(JSON.stringify(fields, null, 2));
      if (response.drafts.length) this.select(response.drafts[0]);
    } catch (e: unknown) { if (epoch === this.epoch) this.failure(e); }
    finally { if (epoch === this.epoch) this.busy.set(false); }
  }
  /** Choosing history does not overwrite a live product or automatically approve it. */
  select(draft: CatalogDraft): void {
    this.selected.set(draft); this.editor.set(JSON.stringify(draft.reviewed || draft.generated, null, 2));
  }
  /** Captures text edits locally; backend validates every claim and source before accepting them. */
  edit(event: Event): void { this.editor.set((event.target as HTMLTextAreaElement).value); }
  /** Changes the independently verified facts form, not the immutable draft evidence. */
  editFacts(event: Event): void { this.factsEditor.set((event.target as HTMLTextAreaElement).value); }
  /** Updates common SEO fields without hiding their evidence; changed quotes must also be edited in JSON. */
  editSeo(event: Event, field: 'seoTitle' | 'metaDescription' | 'proposedSlug'): void {
    try {
      const content = JSON.parse(this.editor()) as CatalogContent;
      const value = (event.target as HTMLInputElement).value;
      if (field === 'proposedSlug') content.proposedSlug = value; else content[field].text = value;
      this.editor.set(JSON.stringify(content, null, 2));
    } catch { this.error.set('JSON nội dung chưa hợp lệ.'); }
  }
  /** Uses a new key only for a new generation; network retries retain the original key and product list. */
  async generate(): Promise<void> {
    if (this.busy() || !this.canWrite()) return;
    const list = this.products().length ? this.products() : [{ productId: this.productId(), expectedVersion: this.source()?.version || this.expectedVersion() }];
    const fingerprint = JSON.stringify(list);
    if (fingerprint !== this.pendingProducts || !this.pendingKey) { this.pendingKey = crypto.randomUUID(); this.pendingProducts = fingerprint; }
    const epoch = this.epoch;
    this.busy.set(true); this.error.set(''); this.message.set('');
    try {
      const batch = await firstValueFrom(this.model.generate(list, this.pendingKey));
      if (epoch !== this.epoch) return;
      this.batch.set(batch);
      await this.poll(epoch, batch.id);
    } catch (e: unknown) { if (epoch === this.epoch) { this.failure(e); this.busy.set(false); } }
  }
  private async poll(epoch: number, id: string): Promise<void> {
    const batch = await firstValueFrom(this.model.batch(id));
    if (epoch !== this.epoch) return;
    this.batch.set(batch);
    if (batch.status === 'complete') {
      this.pendingKey = ''; this.busy.set(false);
      this.message.set('Tạo nháp hoàn tất. Nội dung đang bán chưa thay đổi.');
      if (this.productId()) await this.load();
      return;
    }
    this.timer = window.setTimeout(() => { void this.poll(epoch, id).catch((e: unknown) => { if (epoch === this.epoch) { this.failure(e); this.busy.set(false); } }); }, 2000);
  }
  /** A save clears approval; approval and rejection still never publish automatically. */
  async review(decision: 'save' | 'approve' | 'reject'): Promise<void> {
    const draft = this.selected();
    if (!draft || this.busy() || !this.canWrite()) return;
    const epoch = this.epoch;
    this.busy.set(true); this.error.set('');
    try {
      const content: unknown = decision === 'reject' ? null : JSON.parse(this.editor());
      const updated = await firstValueFrom(this.model.review(draft, content, decision));
      if (epoch !== this.epoch) return;
      this.select(updated); this.drafts.update(rows => rows.map(d => d.id === updated.id ? updated : d));
      this.message.set(decision === 'approve' ? 'Đã duyệt nháp. Bấm Xuất bản để áp dụng.' : decision === 'reject' ? 'Đã từ chối nháp.' : 'Đã lưu nháp; cần duyệt lại trước khi xuất bản.');
    } catch (e: unknown) { if (epoch === this.epoch) this.failure(e); }
    finally { if (epoch === this.epoch) this.busy.set(false); }
  }
  /** Publishes only unchanged approved content; stale catalog changes fail without changing the product. */
  async publish(): Promise<void> {
    const draft = this.selected();
    if (!draft || draft.status !== 'approved' || this.changedSinceApproval() || this.busy() || !this.canWrite()) return;
    const epoch = this.epoch;
    this.busy.set(true); this.error.set('');
    try {
      const updated = await firstValueFrom(this.model.publish(draft));
      if (epoch !== this.epoch) return;
      this.select(updated); this.message.set('Đã xuất bản nội dung đã duyệt.'); this.published.emit(updated.product_id);
      await this.load();
    } catch (e: unknown) { if (epoch === this.epoch) this.failure(e); }
    finally { if (epoch === this.epoch) this.busy.set(false); }
  }
  /** An operator explicitly confirms these facts; updating them invalidates prior drafts. */
  async saveFacts(): Promise<void> {
    const source = this.source();
    if (!source || this.busy() || !this.canWrite()) return;
    const epoch = this.epoch;
    this.busy.set(true); this.error.set('');
    try {
      const fields = JSON.parse(this.factsEditor()) as Record<string, string[]>;
      const updated = await firstValueFrom(this.model.facts(this.productId(), source.version, fields));
      if (epoch !== this.epoch) return;
      this.source.set(updated); this.sourceChanged.emit(this.productId());
      this.message.set('Đã xác nhận dữ liệu nguồn. Hãy tạo nháp mới trước khi xuất bản.');
    } catch (e: unknown) { if (epoch === this.epoch) this.failure(e); }
    finally { if (epoch === this.epoch) this.busy.set(false); }
  }
  private failure(error: unknown): void {
    const response = error as { error?: { message?: string }; message?: string };
    this.error.set(response.error?.message || 'Không thực hiện được. Nội dung đang bán không thay đổi; kiểm tra dữ liệu và thử lại.');
  }
}
