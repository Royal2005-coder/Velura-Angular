import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, catchError, debounceTime, distinctUntilChanged, forkJoin, of, switchMap } from 'rxjs';
import {
  AdminBlogProduct,
  AdminBlogRow,
  AdminBlogSeoSuggestion,
  AdminContentCategory,
  AdminErpApiService,
  AdminProductRow,
} from '../../core/admin-erp-api.service';
import { blogEditorText, blogRowHtml, pasteHtmlFromClipboard, sanitizeEditorHtml } from '../../core/admin-erp-blog-html';
import {
  BLOG_META_DESCRIPTION_MAX,
  BLOG_META_TITLE_MAX,
  BLOG_PRODUCTS_MAX,
  blogRequestBody,
  blogSlugFromTitle,
  blogStatusLabel,
  blogStatusTone,
  blogStatusChoices,
  blogTags,
  emptyBlogDraft,
  validateBlogDraft,
  type BlogDraft,
} from '../../core/admin-erp-content';
import { adminDateTime, adminMoney } from '../../core/admin-erp-format';
import { useWorkspaceRefresh } from '../../core/admin-erp-refresh.service';
import {
  adminErrorMessage,
  adminErrorDetails,
  adminListCount,
  adminListRows,
  adminOffset,
  adminRangeLabel,
  type AdminListPayload,
} from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { AdminErpDataTable, AdminTableColumn } from '../../shared/ui/admin-data-table';
import { AdminErpFilterBar } from '../../shared/ui/admin-filter-bar';
import { AdminErpIcon } from '../../shared/ui/admin-erp-icon';
import { AdminErpKpiCard } from '../../shared/ui/admin-kpi-card';
import { AdminErpModal } from '../../shared/ui/admin-modal';
import { AdminErpPageHeader } from '../../shared/ui/admin-page-header';
import { AdminErpPagination } from '../../shared/ui/admin-pagination';
import { AdminErpTab, AdminErpTabs } from '../../shared/ui/admin-tabs';

type ContentTab = 'all' | 'draft' | 'published' | 'archived';
type EditorTab = 'content' | 'seo' | 'products';

const EMPTY_BLOGS: AdminListPayload<AdminBlogRow> = { rows: [], count: 0 };
const TABS: readonly ContentTab[] = ['all', 'draft', 'published', 'archived'];
const EDITOR_TABS: readonly EditorTab[] = ['content', 'seo', 'products'];
const PRODUCT_STATUS_LABELS: Readonly<Record<string, string>> = {
  on_sale: 'Đang bán',
  hidden: 'Đang ẩn',
  out_of_stock: 'Hết hàng',
  discontinued: 'Ngừng kinh doanh',
};

interface EditorMetrics {
  words: number;
  characters: number;
}

interface SeoCheck {
  key: string;
  label: string;
  hint: string;
  ok: boolean;
}

/**
 * CMS workspace for blog content (KAN-106).
 *
 * Only `super_admin` may read or write `content`; everything the editor can still get wrong is
 * blocked here, and the RPC in migration 078 stays the authority — including optimistic locking,
 * which is why a stale editor keeps its text and offers to reload the newer copy instead of
 * silently winning the last write.
 */
@Component({
  selector: 'app-admin-erp-content-page',
  imports: [
    AdminErpPageHeader,
    AdminErpKpiCard,
    AdminErpTabs,
    AdminErpFilterBar,
    AdminErpDataTable,
    AdminErpPagination,
    AdminErpModal,
    AdminErpIcon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-erp-content.page.html',
  styleUrl: './admin-erp-content.page.scss',
})
export class AdminErpContentPage {
  private readonly api = inject(AdminErpApiService);
  private readonly session = inject(AdminErpSessionService);

  readonly tab = signal<ContentTab>('all');
  readonly search = signal('');
  readonly rows = signal<AdminBlogRow[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pageSize = 10;
  readonly loading = signal(true);
  readonly hasLoadedOnce = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly counts = signal({ draft: 0, published: 0, archived: 0, categories: 0 });
  readonly categories = signal<AdminContentCategory[]>([]);
  readonly categoryError = signal<string | null>(null);

  /** Editor state: `null` đóng form; bản đang sửa giữ `editing` để biết version gửi lại. */
  readonly draft = signal<BlogDraft | null>(null);
  readonly editing = signal<AdminBlogRow | null>(null);
  readonly errors = signal<Record<string, string>>({});
  readonly conflict = signal(false);
  readonly dirty = signal(false);
  readonly discardOpen = signal(false);
  readonly saving = signal(false);

  /** Rich composer state. The editor element is written once per open, never on every keystroke. */
  readonly editorTab = signal<EditorTab>('content');
  readonly editorSession = signal(0);
  readonly editorMetrics = signal<EditorMetrics>({ words: 0, characters: 0 });
  readonly previewOpen = signal(false);
  readonly linkPanel = signal(false);
  readonly linkUrl = signal('');
  readonly imagePanel = signal(false);
  readonly imageUrlInput = signal('');
  readonly aiLoading = signal(false);
  readonly aiError = signal<string | null>(null);
  readonly aiNotice = signal<string | null>(null);
  private readonly editor = viewChild<ElementRef<HTMLElement>>('editor');

  /** Attached shop products. The cache also feeds the picker so chips survive list refreshes. */
  readonly productQuery = signal('');
  readonly productResults = signal<AdminBlogProduct[]>([]);
  readonly productSearching = signal(false);
  readonly productError = signal<string | null>(null);
  private readonly productCache = signal<Record<string, AdminBlogProduct>>({});
  private readonly productSearch$ = new Subject<string>();
  readonly selectedProducts = computed<AdminBlogProduct[]>(() => {
    const draft = this.draft();
    if (!draft) return [];
    const cache = this.productCache();
    return draft.productIds.map((id) => cache[id] || { product_id: id, name: 'Sản phẩm đang tải…' });
  });

  readonly canRead = computed(() => this.session.can('read', 'content'));
  readonly canCreate = computed(() => this.session.can('create', 'content'));
  readonly canUpdate = computed(() => this.session.can('update', 'content'));
  readonly canEdit = computed(() => this.canCreate() || this.canUpdate());

  readonly tabs = computed<readonly AdminErpTab[]>(() => [
    { key: 'all', label: 'Tất cả', count: this.total() },
    { key: 'draft', label: 'Bản nháp', count: this.counts().draft },
    { key: 'published', label: 'Đã công bố', count: this.counts().published },
    { key: 'archived', label: 'Đã lưu trữ', count: this.counts().archived },
  ]);
  readonly editorTabs = computed<readonly { key: EditorTab; label: string }[]>(() => [
    { key: 'content', label: 'Nội dung' },
    { key: 'seo', label: 'SEO' },
    { key: 'products', label: `Sản phẩm (${this.draft()?.productIds.length ?? 0})` },
  ]);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize)));
  readonly rangeLabel = computed(() => adminRangeLabel(this.total(), this.page(), this.pageSize, 'bài viết'));
  readonly statusChoices = computed(() => blogStatusChoices(this.editing()?.status, !this.editing()));
  readonly categoryOptions = computed(() => this.categories());
  readonly contentWords = computed(() => this.editorMetrics().words);
  readonly contentCharacters = computed(() => this.editorMetrics().characters);
  readonly previewHtml = computed(() => sanitizeEditorHtml(this.draft()?.contentHtml || ''));
  readonly metaTitleLength = computed(() => (this.draft()?.metaTitle || '').trim().length);
  readonly metaDescriptionLength = computed(() => (this.draft()?.metaDescription || '').trim().length);
  readonly tagCount = computed(() => blogTags(this.draft()?.tags || '').length);
  readonly metaTitleMax = BLOG_META_TITLE_MAX;
  readonly metaDescriptionMax = BLOG_META_DESCRIPTION_MAX;
  readonly productMax = BLOG_PRODUCTS_MAX;
  readonly seoChecks = computed<SeoCheck[]>(() => {
    const draft = this.draft();
    if (!draft) return [];
    const title = draft.metaTitle.trim() || draft.title.trim();
    const description = draft.metaDescription.trim() || draft.excerpt.trim();
    return [
      { key: 'title', label: 'Tiêu đề SEO 30–60 ký tự', hint: `${title.length} ký tự`, ok: title.length >= 30 && title.length <= 60 },
      { key: 'description', label: 'Meta description 70–155 ký tự', hint: `${description.length} ký tự`, ok: description.length >= 70 && description.length <= 155 },
      { key: 'slug', label: 'Slug ngắn, có từ khóa chính', hint: draft.slug, ok: draft.slug.length >= 5 && draft.slug.length <= 75 },
      { key: 'image', label: 'Ảnh đại diện / OG image', hint: draft.ogImageUrl || draft.imageUrl || 'Chưa có', ok: Boolean((draft.ogImageUrl || draft.imageUrl).trim()) },
      { key: 'tags', label: '3–8 tag chủ đề', hint: `${this.tagCount()} tag`, ok: this.tagCount() >= 3 && this.tagCount() <= 8 },
      { key: 'products', label: 'Đính kèm sản phẩm liên quan', hint: `${draft.productIds.length} sản phẩm`, ok: draft.productIds.length > 0 },
    ];
  });
  readonly seoPassed = computed(() => this.seoChecks().filter((check) => check.ok).length);
  readonly serpTitle = computed(() => {
    const draft = this.draft();
    if (!draft) return '';
    return draft.metaTitle.trim() || draft.title.trim() || 'Tiêu đề bài viết';
  });
  readonly serpDescription = computed(() => {
    const draft = this.draft();
    if (!draft) return '';
    return draft.metaDescription.trim() || draft.excerpt.trim() || 'Mô tả ngắn sẽ hiển thị dưới tiêu đề trên công cụ tìm kiếm.';
  });
  readonly serpUrl = computed(() => {
    const draft = this.draft();
    if (!draft) return 'velura.vn/blog';
    const canonical = draft.canonicalUrl.trim();
    if (canonical) return canonical.replace(/^https:\/\//, '');
    return `velura.vn/blog/${draft.slug}`;
  });
  readonly columns = computed<readonly AdminTableColumn[]>(() => [
    { key: 'title', label: 'Bài viết', value: (row) => (row as AdminBlogRow).title },
    { key: 'slug', label: 'Slug', value: (row) => (row as AdminBlogRow).slug || '—', mono: true },
    { key: 'category', label: 'Danh mục', value: (row) => this.categoryLabel((row as AdminBlogRow).category_slug) },
    {
      key: 'status',
      label: 'Trạng thái',
      value: (row) => blogStatusLabel((row as AdminBlogRow).status),
      badge: (row) => ({ label: blogStatusLabel((row as AdminBlogRow).status), tone: blogStatusTone((row as AdminBlogRow).status) }),
    },
    { key: 'seo', label: 'SEO', value: (row) => ((row as AdminBlogRow).meta_title ? 'Đã cấu hình' : '—') },
    {
      key: 'products',
      label: 'Sản phẩm',
      value: (row) => String((((row as AdminBlogRow).product_ids || (row as AdminBlogRow).products || []) as unknown[]).length || 0),
      align: 'right',
      mono: true,
    },
    { key: 'featured', label: 'Nổi bật', value: (row) => ((row as AdminBlogRow).is_featured ? 'Có' : '—') },
    { key: 'updated', label: 'Sửa lần cuối', value: (row) => this.dateTime((row as AdminBlogRow).updated_at) },
  ]);

  constructor() {
    this.loadCategories();
    this.reload();
    useWorkspaceRefresh(() => this.reload());

    this.productSearch$
      .pipe(
        debounceTime(250),
        distinctUntilChanged(),
        switchMap((query) => {
          this.productSearching.set(true);
          this.productError.set(null);
          return this.api.listProducts({ q: query, limit: '12', order: 'updated_at.desc' }).pipe(
            catchError((error: unknown) => {
              this.productError.set(adminErrorMessage(error, 'Không tìm được sản phẩm.'));
              return of({ rows: [], count: 0 } as AdminListPayload<AdminProductRow>);
            }),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe((payload) => {
        const products = adminListRows(payload)
          .map((row) => this.toBlogProduct(row))
          .filter((product) => product.status === 'on_sale' || product.status === 'out_of_stock')
          .slice(0, 8);
        this.cacheProducts(products);
        this.productResults.set(products);
        this.productSearching.set(false);
      });

    effect(() => {
      const session = this.editorSession();
      const element = this.editor()?.nativeElement;
      if (!session || !element) return;
      const raw = untracked(() => this.draft()?.contentHtml || '');
      const html = sanitizeEditorHtml(raw);
      if (element.innerHTML !== html) {
        element.innerHTML = html;
      }
      untracked(() => this.refreshEditorMetrics());
    });
  }

  /**
   * Loads the active queue plus the per-status counts the KPI cards and tabs show.
   */
  reload(): void {
    if (!this.canRead()) {
      this.loading.set(false);
      this.rows.set([]);
      this.total.set(0);
      return;
    }
    this.loading.set(true);
    this.loadError.set(null);
    const status = this.tab() === 'all' ? '' : this.tab();
    forkJoin({
      list: this.api.listBlogs({ status, q: this.search(), limit: String(this.pageSize), offset: adminOffset(this.page(), this.pageSize) }).pipe(
        catchError((error: unknown) => {
          this.loadError.set(adminErrorMessage(error, 'Không tải được danh sách bài viết.'));
          return of(EMPTY_BLOGS);
        }),
      ),
      draft: this.api.listBlogs({ status: 'draft', limit: '1' }).pipe(catchError(() => of(EMPTY_BLOGS))),
      published: this.api.listBlogs({ status: 'published', limit: '1' }).pipe(catchError(() => of(EMPTY_BLOGS))),
      archived: this.api.listBlogs({ status: 'archived', limit: '1' }).pipe(catchError(() => of(EMPTY_BLOGS))),
    }).subscribe((payload) => {
      const rows = adminListRows(payload.list);
      this.rows.set(rows);
      this.cacheProducts(rows.flatMap((row) => row.products || []));
      this.total.set(adminListCount(payload.list));
      this.counts.update((current) => ({
        ...current,
        draft: adminListCount(payload.draft),
        published: adminListCount(payload.published),
        archived: adminListCount(payload.archived),
      }));
      this.loading.set(false);
      this.hasLoadedOnce.set(true);
    });
  }

  /**
   * Reads blog categories once; the RPC refuses a post whose category does not exist.
   */
  private loadCategories(): void {
    this.api.listContentCategories('blog').subscribe({
      next: (payload) => {
        const rows = payload.rows || [];
        this.categories.set(rows);
        this.categoryError.set(null);
        this.counts.update((current) => ({ ...current, categories: rows.length }));
      },
      error: (error: unknown) => {
        this.categories.set([]);
        this.categoryError.set(adminErrorMessage(error, 'Không tải được danh mục blog.'));
      },
    });
  }

  /**
   * Retries the category lookup after a transient failure.
   */
  retryCategories(): void {
    this.loadCategories();
  }

  /**
   * Switches queue tabs.
   */
  setTab(tab: string): void {
    if (this.loading()) return;
    if (!TABS.includes(tab as ContentTab)) return;
    this.tab.set(tab as ContentTab);
    this.page.set(1);
    this.reload();
  }

  /**
   * Applies the server-side title/slug search.
   */
  applyFilters(): void {
    this.page.set(1);
    this.reload();
  }

  resetFilters(): void {
    this.search.set('');
    this.page.set(1);
    this.reload();
  }

  goPage(page: number): void {
    this.page.set(Math.min(this.totalPages(), Math.max(1, page)));
    this.reload();
  }

  onSearchInput(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  /**
   * Opens the editor for a new post.
   */
  openCreate(): void {
    if (!this.canCreate()) return;
    this.notice.set(null);
    this.conflict.set(false);
    this.errors.set({});
    this.editing.set(null);
    this.draft.set({ ...emptyBlogDraft });
    this.resetEditorState();
    this.dirty.set(false);
  }

  /**
   * Opens the editor for one existing post, carrying its version for optimistic locking.
   * Posts authored before the rich editor are converted from plain text once, in memory.
   */
  openEdit(row: unknown): void {
    const blog = row as AdminBlogRow;
    if (!this.canUpdate()) return;
    this.notice.set(null);
    this.conflict.set(false);
    this.errors.set({});
    this.editing.set(blog);
    const productIds = blog.product_ids?.length
      ? [...blog.product_ids]
      : (blog.products || []).map((product) => product.product_id);
    this.cacheProducts(blog.products || []);
    this.draft.set({
      slug: blog.slug || '',
      title: blog.title || '',
      categorySlug: blog.category_slug || '',
      status: blog.status || 'draft',
      excerpt: blog.excerpt || '',
      content: blog.content || '',
      contentHtml: blogRowHtml(blog),
      imageUrl: blog.image_url || '',
      metaTitle: blog.meta_title || '',
      metaDescription: blog.meta_description || '',
      canonicalUrl: blog.canonical_url || '',
      ogImageUrl: blog.og_image_url || '',
      tags: (blog.tags || []).join(', '),
      productIds,
      author: blog.author || 'Velura Editorial',
      readMinutes: Number(blog.read_minutes ?? 5),
      isFeatured: Boolean(blog.is_featured),
    });
    this.resetEditorState();
    this.dirty.set(false);
  }

  private resetEditorState(): void {
    this.editorTab.set('content');
    this.previewOpen.set(false);
    this.linkPanel.set(false);
    this.linkUrl.set('');
    this.imagePanel.set(false);
    this.imageUrlInput.set('');
    this.aiLoading.set(false);
    this.aiError.set(null);
    this.aiNotice.set(null);
    this.productQuery.set('');
    this.productResults.set([]);
    this.productError.set(null);
    this.productSearching.set(false);
    this.editorSession.update((value) => value + 1);
  }

  /**
   * Closes the editor. A dirty draft asks before discarding typed changes.
   */
  closeEditor(): void {
    if (this.dirty()) {
      this.discardOpen.set(true);
      return;
    }
    this.forceCloseEditor();
  }

  /**
   * Marks the open draft as edited.
   */
  markDirty(): void {
    this.dirty.set(true);
  }

  /**
   * Confirms discarding the draft and closes the editor.
   */
  confirmDiscard(): void {
    this.discardOpen.set(false);
    this.dirty.set(false);
    this.forceCloseEditor();
  }

  /**
   * Keeps the editor open after the discard prompt is cancelled.
   */
  cancelDiscard(): void {
    this.discardOpen.set(false);
  }

  private forceCloseEditor(): void {
    this.draft.set(null);
    this.editing.set(null);
    this.errors.set({});
    this.conflict.set(false);
    this.saving.set(false);
    this.dirty.set(false);
    this.discardOpen.set(false);
    this.previewOpen.set(false);
    this.aiLoading.set(false);
  }

  /**
   * Edits one text field of the draft.
   */
  onField(
    field: 'slug' | 'title' | 'categorySlug' | 'status' | 'excerpt' | 'imageUrl' | 'author' | 'metaTitle' | 'metaDescription' | 'canonicalUrl' | 'ogImageUrl' | 'tags',
    event: Event,
  ): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
    this.draft.update((draft) => (draft ? { ...draft, [field]: value } : draft));
  }

  /**
   * Edits the numeric and boolean fields of the draft.
   */
  onNumberField(event: Event): void {
    const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
    this.draft.update((draft) => (draft ? { ...draft, readMinutes: Number.isFinite(value) ? value : 0 } : draft));
  }

  onFeaturedChange(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.draft.update((draft) => (draft ? { ...draft, isFeatured: checked } : draft));
  }

  /**
   * Slug from the title, so the operator does not invent a URL for every post.
   */
  suggestSlug(): void {
    const draft = this.draft();
    if (!draft) return;
    this.draft.set({ ...draft, slug: blogSlugFromTitle(draft.title) });
  }

  /** Switches between the composer, SEO panel and product picker without losing editor content. */
  setEditorTab(tab: string): void {
    if (!EDITOR_TABS.includes(tab as EditorTab)) return;
    this.editorTab.set(tab as EditorTab);
    if (tab === 'products' && !this.productResults().length && !this.productSearching()) {
      this.productSearch$.next(this.productQuery());
    }
  }

  /**
   * Reads the contenteditable DOM once per input. The signal holds the exact HTML that will be
   * sanitized and saved; the DOM is not rewritten here, so the caret never jumps.
   */
  onEditorInput(): void {
    const element = this.editor()?.nativeElement;
    if (!element) return;
    this.draft.update((draft) => (draft ? { ...draft, contentHtml: element.innerHTML } : draft));
    this.refreshEditorMetrics();
    this.markDirty();
  }

  private refreshEditorMetrics(): void {
    const text = blogEditorText(this.draft()?.contentHtml || '');
    this.editorMetrics.set({
      words: text ? text.split(/\s+/).length : 0,
      characters: text.length,
    });
  }

  hasError(field: string): string | undefined {
    return this.errors()[field];
  }

  private clearError(field: string): void {
    if (!this.errors()[field]) return;
    const errors = { ...this.errors() };
    delete errors[field];
    this.errors.set(errors);
  }

  /**
   * Toolbar commands keep the native undo stack. Formatting is applied to the selection only.
   */
  format(command: string, value?: string): void {
    const element = this.editor()?.nativeElement;
    if (!element) return;
    element.focus();
    document.execCommand(command, false, value);
    this.onEditorInput();
  }

  /**
   * Applies a block format (p, h2, h3, blockquote) to the current line.
   */
  formatBlock(tag: 'p' | 'h2' | 'h3' | 'blockquote'): void {
    this.format('formatBlock', `<${tag}>`);
  }

  /**
   * Clears inline formatting but keeps the paragraph structure.
   */
  clearFormat(): void {
    this.format('removeFormat');
    this.format('formatBlock', '<p>');
  }

  /**
   * Opens the small link panel; the URL is validated before it is applied.
   */
  openLink(): void {
    this.linkPanel.set(true);
    this.imagePanel.set(false);
  }

  cancelLink(): void {
    this.linkPanel.set(false);
    this.linkUrl.set('');
  }

  onLinkInput(event: Event): void {
    this.linkUrl.set((event.target as HTMLInputElement).value);
  }

  /**
   * Wraps the current selection in an https/mailto link, with a safe target/rel.
   */
  applyLink(): void {
    const url = this.linkUrl().trim();
    if (!/^(https?:\/\/|mailto:)/i.test(url)) {
      this.errors.update((errors) => ({ ...errors, linkUrl: 'Link phải bắt đầu bằng https://, http:// hoặc mailto:.' }));
      return;
    }
    const element = this.editor()?.nativeElement;
    if (!element) return;
    element.focus();
    document.execCommand('createLink', false, url);
    this.linkPanel.set(false);
    this.linkUrl.set('');
    this.clearError('linkUrl');
    this.onEditorInput();
  }

  /**
   * Inserts an image by URL; only https sources are accepted and alt is left empty for the editor
   * to fill in the image's meaning.
   */
  openImage(): void {
    this.imagePanel.set(true);
    this.linkPanel.set(false);
  }

  cancelImage(): void {
    this.imagePanel.set(false);
    this.imageUrlInput.set('');
  }

  onImageInput(event: Event): void {
    this.imageUrlInput.set((event.target as HTMLInputElement).value);
  }

  applyImage(): void {
    const url = this.imageUrlInput().trim();
    if (!/^https:\/\//i.test(url)) {
      this.errors.update((errors) => ({ ...errors, imageUrlInput: 'Ảnh phải là URL https:// công khai.' }));
      return;
    }
    this.editor()?.nativeElement.focus();
    document.execCommand('insertHTML', false, `<figure><img src="${url.replace(/"/g, '&quot;')}" alt=""><figcaption></figcaption></figure>`);
    this.imagePanel.set(false);
    this.imageUrlInput.set('');
    this.clearError('imageUrlInput');
    this.onEditorInput();
  }

  /**
   * Pasted pages are sanitized before insertion. Images/links stay, scripts, styles and event
   * handlers do not.
   */
  onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    const clipboard = event.clipboardData;
    const html = pasteHtmlFromClipboard(clipboard?.getData('text/html') || '', clipboard?.getData('text/plain') || '');
    if (html) {
      document.execCommand('insertHTML', false, html);
      this.onEditorInput();
    }
  }

  /**
   * A drag from another browser window is just another untrusted paste.
   */
  onDrop(event: DragEvent): void {
    event.preventDefault();
    const transfer = event.dataTransfer;
    const html = pasteHtmlFromClipboard(transfer?.getData('text/html') || '', transfer?.getData('text/plain') || '');
    if (!html) return;
    const caret = (document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    }).caretRangeFromPoint?.(event.clientX, event.clientY);
    if (caret) {
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(caret);
    }
    document.execCommand('insertHTML', false, html);
    this.onEditorInput();
  }

  togglePreview(): void {
    this.previewOpen.update((open) => !open);
  }

  /**
   * AI writes only suggestions; the operator still reviews every field. No request is made while
   * the article is too short to describe.
   */
  suggestSeo(): void {
    const draft = this.draft();
    if (!draft || this.aiLoading()) return;
    const text = blogEditorText(draft.contentHtml);
    if (draft.title.trim().length < 4 || text.length < 40) {
      this.aiError.set('Nhập tiêu đề và ít nhất 40 ký tự nội dung trước khi gợi ý SEO.');
      return;
    }
    this.aiLoading.set(true);
    this.aiError.set(null);
    this.aiNotice.set(null);
    this.api.suggestBlogSeo({ title: draft.title.trim(), contentHtml: sanitizeEditorHtml(draft.contentHtml) }).subscribe({
      next: (suggestion: AdminBlogSeoSuggestion) => {
        this.aiLoading.set(false);
        this.draft.update((current) => current ? {
          ...current,
          metaTitle: suggestion.metaTitle || current.metaTitle,
          metaDescription: suggestion.metaDescription || current.metaDescription,
          tags: suggestion.tags.length ? suggestion.tags.join(', ') : current.tags,
          excerpt: current.excerpt.trim() || suggestion.summary.slice(0, 500),
        } : current);
        this.aiNotice.set('AI đã điền gợi ý. Đọc lại và chỉnh trước khi lưu.');
        this.markDirty();
      },
      error: (error: unknown) => {
        this.aiLoading.set(false);
        this.aiError.set(adminErrorMessage(error, 'AI chưa soạn được gợi ý SEO. Thử lại sau.'));
      },
    });
  }

  /**
   * Product search is debounced and limited to sellable products, so a published post cannot
   * advertise a product that the storefront will hide.
   */
  onProductQueryInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.productQuery.set(value);
    this.productSearch$.next(value);
  }

  searchProducts(): void {
    this.productSearch$.next(this.productQuery());
  }

  isAttached(productId: string): boolean {
    return this.draft()?.productIds.includes(productId) ?? false;
  }

  attachProduct(product: AdminBlogProduct): void {
    const draft = this.draft();
    if (!draft || draft.productIds.includes(product.product_id)) return;
    if (draft.productIds.length >= BLOG_PRODUCTS_MAX) {
      this.errors.update((errors) => ({ ...errors, productIds: `Tối đa ${BLOG_PRODUCTS_MAX} sản phẩm đính kèm.` }));
      return;
    }
    this.cacheProducts([product]);
    this.draft.set({ ...draft, productIds: [...draft.productIds, product.product_id] });
    this.clearError('productIds');
    this.markDirty();
  }

  removeProduct(productId: string): void {
    const draft = this.draft();
    if (!draft) return;
    this.draft.set({ ...draft, productIds: draft.productIds.filter((id) => id !== productId) });
    this.markDirty();
  }

  moveProduct(productId: string, direction: -1 | 1): void {
    const draft = this.draft();
    if (!draft) return;
    const ids = [...draft.productIds];
    const index = ids.indexOf(productId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    this.draft.set({ ...draft, productIds: ids });
    this.markDirty();
  }

  productImage(product: AdminBlogProduct): string {
    return product.images?.find((url) => typeof url === 'string' && url.trim()) || '';
  }

  productPrice(product: AdminBlogProduct): string {
    const price = Number(product.sale_price ?? product.base_price ?? 0);
    return price > 0 ? adminMoney(price) : '—';
  }

  productStatus(product: AdminBlogProduct): string {
    return PRODUCT_STATUS_LABELS[product.status || ''] || product.status || '—';
  }

  private toBlogProduct(row: AdminProductRow): AdminBlogProduct {
    return {
      product_id: row.product_id,
      name: row.name,
      slug: row.slug,
      images: row.images,
      base_price: row.base_price,
      sale_price: row.sale_price,
      status: row.status,
    };
  }

  private cacheProducts(products: AdminBlogProduct[]): void {
    if (!products.length) return;
    this.productCache.update((cache) => {
      const next = { ...cache };
      for (const product of products) {
        if (product?.product_id) next[product.product_id] = { ...next[product.product_id], ...product };
      }
      return next;
    });
  }

  /**
   * Saves the draft: create for a new post, versioned update for an existing one.
   */
  save(): void {
    const draft = this.draft();
    const editing = this.editing();
    if (!draft || this.saving()) return;
    if (editing && !this.canUpdate()) return;
    if (!editing && !this.canCreate()) return;

    const element = this.editor()?.nativeElement;
    const current = element ? { ...draft, contentHtml: element.innerHTML } : draft;
    const errors = validateBlogDraft(current, !!editing);
    this.errors.set(errors);
    if (Object.keys(errors).length) {
      this.focusFirstError(errors);
      return;
    }

    this.saving.set(true);
    this.conflict.set(false);
    const body = blogRequestBody(current, editing ? Number(editing.version ?? 0) : undefined);
    const request = editing ? this.api.updateBlog(editing.blog_id, body) : this.api.createBlog(body);
    request.subscribe({
      next: (saved) => {
        this.saving.set(false);
        this.dirty.set(false);
        this.closeEditor();
        this.notice.set(
          editing
            ? `Đã lưu "${saved.title}" (bản ${saved.version}, trạng thái ${blogStatusLabel(saved.status)}).`
            : `Đã tạo "${saved.title}" ở trạng thái ${blogStatusLabel(saved.status)}.`,
        );
        this.reload();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        const code = this.errorCode(error);
        if (code === 'VERSION_CONFLICT' && editing) {
          this.conflict.set(true);
          this.errors.set({});
          return;
        }
        const fieldErrors = code === 'CONTENT_VALIDATION' ? this.fieldErrors(error) : {};
        this.errors.set(fieldErrors);
        this.focusFirstError(fieldErrors);
        this.notice.set(adminErrorMessage(error, 'Không lưu được bài viết.'));
      },
    });
  }

  private focusFirstError(errors: Record<string, string>): void {
    if (errors['content']) this.editorTab.set('content');
    else if (errors['metaTitle'] || errors['metaDescription'] || errors['canonicalUrl'] || errors['ogImageUrl'] || errors['tags']) this.editorTab.set('seo');
    else if (errors['productIds']) this.editorTab.set('products');
  }

  /**
   * Refetches the newer copy of a conflicting post before reopening the editor, so the
   * operator edits the version that actually won and the next save does not conflict again.
   */
  reloadConflict(): void {
    const editing = this.editing();
    if (!editing) return;
    this.conflict.set(false);
    this.api.listBlogs({ q: editing.slug || editing.title || '', status: '', limit: '200' }).subscribe({
      next: (payload) => {
        const fresh = (payload.rows || []).find((row) => row.blog_id === editing.blog_id);
        if (!fresh) {
          this.notice.set('Không tìm thấy bản mới nhất của bài viết. Tải lại danh sách rồi thử lại.');
          this.reload();
          return;
        }
        this.openEdit(fresh);
        this.notice.set('Đã tải bản mới nhất vào trình soạn. Nội dung cũ của bạn đã bị ghi đè bởi người khác.');
      },
      error: (error: unknown) => {
        this.conflict.set(true);
        this.notice.set(adminErrorMessage(error, 'Không tải được bản mới nhất của bài viết.'));
      },
    });
  }

  /**
   * Category label for a table row.
   */
  categoryLabel(slug: string | undefined): string {
    if (!slug) return '—';
    return this.categories().find((category) => category.slug === slug)?.name || slug;
  }

  statusLabel(status: string | undefined): string {
    return blogStatusLabel(status);
  }

  statusTone(status: string | undefined): 'neutral' | 'success' | 'warning' {
    return blogStatusTone(status);
  }

  dateTime(value: string | undefined | null): string {
    return adminDateTime(value);
  }

  private errorCode(error: unknown): string {
    if (!(error instanceof HttpErrorResponse)) return '';
    const payload = error.error as { error?: { code?: string } | string } | null;
    return typeof payload?.error === 'object' ? payload.error?.code || '' : '';
  }

  private fieldErrors(error: unknown): Record<string, string> {
    const details = adminErrorDetails(error) || {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(details)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  }
}
