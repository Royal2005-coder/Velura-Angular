import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import {
  AdminCategoryRow,
  AdminComboItemRow,
  AdminErpApiService,
  AdminImageApproval,
  AdminProductCreateInput,
  AdminProductFashionSeoResult,
  AdminProductRow,
  AdminProductUpdateInput,
  AdminProductVariant,
  AdminProductVariantInput,
  AdminSkuCheck,
} from '../../core/admin-erp-api.service';
import {
  CREATE_STATUSES,
  MAX_PRODUCT_IMAGES,
  SKU_DUPLICATE_MESSAGE,
  SKU_FORMAT_MESSAGE,
  SKU_PATTERN,
  buildVariantMatrix,
  duplicateSkus,
  guessColorHex,
  lowStockVariants,
  normalizeColorCode,
  parseListInput,
  productStatusLabel,
  slugifyProductText,
} from '../../core/admin-erp-catalog';
import { adminMoney } from '../../core/admin-erp-format';
import { adminErrorMessage, adminListRows } from '../../core/admin-erp-http';
import { AdminErpDataTable } from '../../shared/ui/admin-data-table';
import { AdminErpModal } from '../../shared/ui/admin-modal';
import { AdminErpTab, AdminErpTabs } from '../../shared/ui/admin-tabs';
import type { AdminTableColumn } from '../../shared/ui/admin-data-table';
import { ProductGalleryComponent } from './product-gallery.component';

const TONE_OPTIONS = [
  { value: 'Neutral', label: 'Tông da Trung tính' },
  { value: 'Warm', label: 'Tông da Ấm' },
  { value: 'Cool', label: 'Tông da Lạnh' },
];

const STYLE_PRESETS = ['Elegant', 'Smart Casual', 'Minimalist', 'Classic', 'Modern', 'Luxury', 'Feminine', 'Streetwear'];

const OCCASION_OPTIONS = [
  { value: 'Office', label: 'Công sở' },
  { value: 'Party', label: 'Dự tiệc' },
  { value: 'Casual', label: 'Dạo phố' },
  { value: 'Travel', label: 'Du lịch' },
  { value: 'Date', label: 'Hẹn hò' },
  { value: 'Event', label: 'Sự kiện' },
];

const BODY_SHAPE_OPTIONS = [
  { value: 'Hourglass', label: 'Dáng đồng hồ cát' },
  { value: 'Rectangle', label: 'Dáng chữ nhật' },
  { value: 'Pear', label: 'Dáng quả lê' },
  { value: 'Apple', label: 'Dáng quả táo' },
  { value: 'Inverted Triangle', label: 'Dáng tam giác ngược' },
];

const MATERIAL_LINE = /Chất liệu:\s*([^\n.]+)/i;

type EditorSection = 'info' | 'variants' | 'content' | 'gallery' | 'combo';

/**
 * Product create/edit form. The same shell serves both modes: creation owns price,
 * status and the variant matrix, while an edit patches catalog fields and routes price
 * through change-price so each write keeps its own audit reason.
 */
@Component({
  selector: 'app-erp-product-editor',
  imports: [AdminErpModal, AdminErpTabs, AdminErpDataTable, ProductGalleryComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './product-editor.component.html',
  styleUrl: './product-editor.component.scss',
})
export class ProductEditorComponent {
  private readonly api = inject(AdminErpApiService);

  /** `undefined` closes the modal, `null` opens it in create mode, a row opens it for editing. */
  readonly product = input<AdminProductRow | null | undefined>(undefined);
  readonly categories = input<readonly AdminCategoryRow[]>([]);
  readonly componentOptions = input<readonly AdminProductRow[]>([]);
  readonly canChangePrice = input(false);

  readonly saved = output<AdminProductRow>();
  readonly cancelled = output<void>();
  /** Raised when the server reports the row moved under us, so the page can reread it. */
  readonly conflict = output<void>();

  readonly name = signal('');
  readonly sku = signal('');
  readonly slug = signal('');
  readonly categoryId = signal('');
  readonly brand = signal('Velura');
  readonly collection = signal('Velura Atelier');
  readonly basePrice = signal(0);
  readonly salePrice = signal(0);
  readonly status = signal<(typeof CREATE_STATUSES)[number]>('on_sale');
  readonly isFeatured = signal(false);
  readonly isCombo = signal(false);
  readonly description = signal('');
  readonly material = signal('Lụa & Sợi tự nhiên cao cấp');
  readonly seoTitle = signal('');
  readonly seoDescription = signal('');
  readonly colorTone = signal('Neutral');
  readonly styleTags = signal<string[]>(['Elegant', 'Smart Casual']);
  readonly customTag = signal('');
  readonly occasions = signal<string[]>(['Office', 'Casual']);
  readonly bodyShapes = signal<string[]>(['Hourglass', 'Rectangle']);

  readonly images = signal<string[]>([]);
  readonly imageColors = signal<Record<string, string>>({});
  readonly approvals = signal<AdminImageApproval[]>([]);
  readonly galleryBusy = signal(false);

  readonly colorsInput = signal('Đen, Đỏ Ruby');
  readonly sizesInput = signal('S, M, L');
  readonly matrix = signal<AdminProductVariantInput[]>([]);
  readonly variantSkuConflicts = signal<string[]>([]);
  readonly skuMessage = signal<string | null>(null);
  /** Opening stock of the single default variant, used only when no matrix is generated. */
  readonly initialStock = signal(10);
  /** Low-stock threshold of that default variant. */
  readonly initialThreshold = signal(5);

  readonly newColor = signal('');
  readonly newSize = signal('');
  readonly newStock = signal(0);
  readonly newThreshold = signal(5);
  readonly variantSaving = signal(false);
  readonly variantMessage = signal<string | null>(null);

  readonly variants = signal<AdminProductVariant[]>([]);
  readonly comboItems = signal<AdminComboItemRow[]>([]);
  readonly comboComponentId = signal('');
  readonly comboQuantity = signal(1);

  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly aiSeoBusy = signal(false);
  readonly aiSeoError = signal<string | null>(null);
  readonly aiSeoNote = signal<string | null>(null);
  readonly aiSeo = signal<AdminProductFashionSeoResult | null>(null);
  /** Form section shown inside the modal; catalog operators jump straight to the one they need. */
  readonly section = signal<EditorSection>('info');

  private skuTimer: number | null = null;
  private skuRevision = 0;

  readonly isCreate = computed(() => this.product() === null);
  readonly open = computed(() => this.product() !== undefined);
  readonly current = computed(() => this.product());
  readonly title = computed(() => (this.isCreate() ? 'Thêm sản phẩm' : 'Chỉnh sửa sản phẩm'));
  readonly toneOptions = TONE_OPTIONS;
  readonly stylePresets = STYLE_PRESETS;
  readonly occasionOptions = OCCASION_OPTIONS;
  readonly bodyShapeOptions = BODY_SHAPE_OPTIONS;
  readonly statusOptions = CREATE_STATUSES.map((value) => ({ value, label: productStatusLabel(value) }));
  readonly categoryOptions = computed(() => [
    { value: '', label: 'Chọn danh mục' },
    ...this.categories().map((category) => ({ value: category.category_id, label: category.name })),
  ]);
  readonly variantColors = computed(() => {
    const fromMatrix = this.matrix().map((row) => row.color);
    const fromSaved = this.variants().map((variant) => String(variant.color || ''));
    return [...new Set([...fromMatrix, ...fromSaved].map((color) => color.trim()).filter(Boolean))];
  });
  readonly matrixStock = computed(() =>
    this.matrix().reduce((sum, row) => sum + Math.max(0, Number(row.stockQuantity) || 0), 0),
  );
  readonly matrixDuplicates = computed(() => duplicateSkus(this.matrix().map((row) => row.sku || '')));
  readonly matrixComboClash = computed(() => {
    const keys = this.matrix().map((row) => `${String(row.color).toLowerCase()}|${row.size}`);
    return keys.length !== new Set(keys).size;
  });
  readonly variantSkuMessage = computed(() => {
    const clashes = [...new Set([...this.matrixDuplicates(), ...this.variantSkuConflicts()])];
    return clashes.length ? `${SKU_DUPLICATE_MESSAGE} (${clashes.join(', ')})` : null;
  });
  readonly lowStockVariants = computed(() => lowStockVariants(this.variants()));
  readonly priceInvalid = computed(() => this.salePrice() > this.basePrice());
  readonly priceChanged = computed(() => {
    const product = this.current();
    if (!product || this.isCreate()) {
      return false;
    }
    return this.basePrice() !== Number(product.base_price || 0) || this.salePrice() !== Number(product.sale_price ?? product.base_price ?? 0);
  });
  readonly comboTotal = computed(() =>
    this.comboItems().reduce(
      (sum, item) => sum + Number(item.product?.sale_price || item.product?.base_price || 0) * Number(item.quantity || 1),
      0,
    ),
  );
  readonly comboSavings = computed(() => Math.max(0, this.comboTotal() - this.salePrice()));
  readonly selectableComponents = computed(() => {
    const existing = new Set(this.comboItems().map((item) => item.component_product_id));
    return this.componentOptions().filter((row) => !row.is_combo && row.product_id !== this.current()?.product_id && !existing.has(row.product_id));
  });
  /**
   * Any URL that is neither stored on the product nor a first-party asset must carry a
   * server approval from the gallery before the product may publish it.
   */
  readonly missingApproval = computed(() => {
    const approved = new Set(this.approvals().map((approval) => approval.url));
    const previous = this.current()?.images || [];
    return this.images().some(
      (url) => !previous.includes(url) && !url.startsWith('/assets/') && !approved.has(url),
    );
  });
  readonly canSave = computed(() => {
    const images = this.images();
    const needsImage = this.isCreate() ? this.status() === 'on_sale' : true;
    return (
      !this.saving() &&
      !this.galleryBusy() &&
      this.name().trim().length >= 2 &&
      this.categoryId().length > 0 &&
      images.length <= MAX_PRODUCT_IMAGES &&
      (!needsImage || images.length > 0) &&
      !this.priceInvalid() &&
      !this.missingApproval()
    );
  });

  readonly sections = computed<readonly AdminErpTab[]>(() => {
    const tabs: AdminErpTab[] = [
      { key: 'info', label: 'Thông tin' },
      { key: 'variants', label: this.isCreate() ? 'Ma trận biến thể' : 'Biến thể', count: this.isCreate() ? this.matrix().length : this.variants().length },
      { key: 'content', label: 'Nội dung & SEO' },
      { key: 'gallery', label: 'Ảnh', count: this.images().length },
    ];
    if (!this.isCreate() && this.current()?.is_combo) {
      tabs.push({ key: 'combo', label: 'Thành phần combo', count: this.comboItems().length });
    }
    return tabs;
  });

  readonly variantColumns: readonly AdminTableColumn[] = [
    {
      key: 'variant',
      label: 'Biến thể',
      value: (row) => {
        const variant = row as AdminProductVariant;
        return [variant.color, variant.size].filter(Boolean).join(' · ') || '—';
      },
    },
    { key: 'sku', label: 'SKU', value: (row) => (row as AdminProductVariant).sku || '—', mono: true },
    {
      key: 'stock',
      label: 'Còn',
      align: 'right',
      mono: true,
      value: (row) => String((row as AdminProductVariant).stock_quantity ?? 0),
    },
    {
      key: 'reserved',
      label: 'Giữ',
      align: 'right',
      mono: true,
      value: (row) => String((row as AdminProductVariant).reserved_quantity ?? 0),
    },
    {
      key: 'threshold',
      label: 'Ngưỡng',
      align: 'right',
      mono: true,
      value: (row) => String((row as AdminProductVariant).low_stock_threshold ?? 0),
    },
  ];

  constructor() {
    effect(() => {
      const product = this.product();
      if (product === undefined) {
        return;
      }
      this.loadForm(product);
    });
  }

  /**
   * Closes the modal without writing.
   */
  dismiss(): void {
    if (this.saving()) {
      return;
    }
    this.cancelled.emit();
  }

  /**
   * Regenerates the SKU matrix from the color and size lists.
   */
  regenerateMatrix(): void {
    const colors = parseListInput(this.colorsInput());
    const sizes = parseListInput(this.sizesInput()).map((size) => size.toUpperCase());
    if (!colors.length || !sizes.length) {
      this.error.set('Cần ít nhất một màu và một kích thước để tạo ma trận biến thể.');
      return;
    }
    if (this.sku().trim() && !SKU_PATTERN.test(this.sku().trim().toUpperCase())) {
      this.error.set(SKU_FORMAT_MESSAGE);
      return;
    }
    this.matrix.set(buildVariantMatrix(this.sku(), colors, sizes));
    this.error.set(null);
    this.scheduleSkuCheck();
  }

  /**
   * Clears every generated variant, falling back to the API default variant.
   */
  clearMatrix(): void {
    this.matrix.set([]);
  }

  /**
   * Removes one generated variant row.
   */
  removeMatrixRow(index: number): void {
    this.matrix.update((rows) => rows.filter((_, position) => position !== index));
    this.scheduleSkuCheck();
  }

  /**
   * Edits the opening stock of one generated variant.
   */
  setMatrixStock(index: number, event: Event): void {
    this.updateMatrixRow(index, { stockQuantity: Math.max(0, Math.trunc(Number((event.target as HTMLInputElement).value) || 0)) });
  }

  /**
   * Edits the low-stock threshold of one generated variant.
   */
  setMatrixThreshold(index: number, event: Event): void {
    this.updateMatrixRow(index, { lowStockThreshold: Math.max(0, Math.trunc(Number((event.target as HTMLInputElement).value) || 0)) });
  }

  /**
   * Edits one generated variant SKU, keeping it uppercase for the pattern check.
   */
  setMatrixSku(index: number, event: Event): void {
    this.updateMatrixRow(index, { sku: (event.target as HTMLInputElement).value.trim().toUpperCase() });
    this.scheduleSkuCheck();
  }

  /**
   * Fills a SKU automatically from the parent SKU, color and size.
   */
  autoFillMatrixSku(index: number): void {
    const row = this.matrix()[index];
    if (!row || !this.sku().trim()) {
      return;
    }
    this.updateMatrixRow(index, {
      sku: `${this.sku().trim().toUpperCase()}-${normalizeColorCode(row.color)}-${row.size}`,
    });
    this.scheduleSkuCheck();
  }

  /**
   * SKU of one matrix row: the operator's value, or the generated one from the parent SKU.
   */
  matrixRowSku(index: number): string {
    const row = this.matrix()[index];
    if (!row) {
      return '';
    }
    const typed = String(row.sku || '').trim();
    if (typed) {
      return typed;
    }
    const parent = this.sku().trim().toUpperCase();
    return parent ? `${parent}-${normalizeColorCode(row.color)}-${row.size}` : '';
  }

  /**
   * Switches between the featured and combo flags.
   */
  setFlag(flag: 'isFeatured' | 'isCombo', event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    if (flag === 'isFeatured') {
      this.isFeatured.set(checked);
    } else {
      this.isCombo.set(checked);
    }
  }

  /**
   * Chooses the catalog status of a new product.
   */
  setCreateStatus(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if ((CREATE_STATUSES as readonly string[]).includes(value)) {
      this.status.set(value as (typeof CREATE_STATUSES)[number]);
    }
  }

  /**
   * Chooses the skin-tone attribute.
   */
  setColorTone(event: Event): void {
    this.colorTone.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Chooses a category.
   */
  setCategory(event: Event): void {
    this.categoryId.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Chooses a combo component.
   */
  setComboComponent(event: Event): void {
    this.comboComponentId.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Sets a numeric form field from its name.
   */
  setNumber(field: 'basePrice' | 'salePrice' | 'newStock' | 'newThreshold' | 'initialStock' | 'initialThreshold' | 'comboQuantity', event: Event): void {
    const raw = Number((event.target as HTMLInputElement).value);
    const value = Number.isFinite(raw) ? Math.max(0, raw) : 0;
    if (field === 'basePrice') {
      this.basePrice.set(value);
    } else if (field === 'salePrice') {
      this.salePrice.set(value);
    } else if (field === 'newStock') {
      this.newStock.set(Math.trunc(value));
    } else if (field === 'newThreshold') {
      this.newThreshold.set(Math.trunc(value));
    } else if (field === 'initialStock') {
      this.initialStock.set(Math.trunc(value));
    } else if (field === 'initialThreshold') {
      this.initialThreshold.set(Math.trunc(value));
    } else {
      this.comboQuantity.set(Math.max(1, Math.trunc(value)));
    }
  }

  /**
   * Sets a free-text form field from its name.
   */
  setText(field: 'name' | 'sku' | 'slug' | 'brand' | 'collection' | 'description' | 'material' | 'seoTitle' | 'seoDescription' | 'colorsInput' | 'sizesInput' | 'customTag' | 'newColor' | 'newSize', event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    if (field === 'name') {
      this.onNameInput(event);
      return;
    }
    if (field === 'sku') {
      this.onSkuInput(event);
      return;
    }
    const target: Record<string, { set: (value: string) => void }> = {
      slug: this.slug,
      brand: this.brand,
      collection: this.collection,
      description: this.description,
      material: this.material,
      seoTitle: this.seoTitle,
      seoDescription: this.seoDescription,
      colorsInput: this.colorsInput,
      sizesInput: this.sizesInput,
      customTag: this.customTag,
      newColor: this.newColor,
      newSize: this.newSize,
    };
    target[field].set(value);
  }

  /**
   * Keeps the slug in step with the name until the operator edits it.
   */
  onNameInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    const previous = this.slug();
    this.name.set(value);
    if (this.isCreate() && (!previous || previous === slugifyProductText(this.name()))) {
      this.slug.set(slugifyProductText(value));
    }
  }

  /**
   * Normalizes the parent SKU and re-keys the generated matrix.
   */
  onSkuInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim().toUpperCase();
    const previous = this.sku();
    this.sku.set(value);
    if (this.matrix().length && previous) {
      this.matrix.update((rows) =>
        rows.map((row) => ({
          ...row,
          sku: (row.sku || '').startsWith(previous)
            ? `${value}${(row.sku || '').slice(previous.length)}`
            : row.sku,
        })),
      );
    }
    this.scheduleSkuCheck();
  }

  /**
   * Adds a color/size variant to an existing product.
   */
  addVariant(): void {
    const product = this.current();
    const color = this.newColor().trim();
    const size = this.newSize().trim().toUpperCase();
    if (!product || !color || !size) {
      this.variantMessage.set('Cần nhập màu và kích thước cho biến thể mới.');
      return;
    }
    this.variantSaving.set(true);
    this.variantMessage.set(null);
    this.api
      .createVariant(product.product_id, {
        color,
        colorHex: guessColorHex(color),
        size,
        stockQuantity: Math.max(0, Math.trunc(Number(this.newStock()) || 0)),
        lowStockThreshold: Math.max(0, Math.trunc(Number(this.newThreshold()) || 0)),
      })
      .subscribe({
        next: () => {
          this.variantSaving.set(false);
          this.newColor.set('');
          this.newSize.set('');
          this.newStock.set(0);
          this.newThreshold.set(5);
          this.variantMessage.set(`Đã thêm biến thể ${color} · ${size}.`);
          this.reloadVariants(product.product_id);
        },
        error: (error: unknown) => {
          this.variantSaving.set(false);
          this.variantMessage.set(adminErrorMessage(error, 'Không thêm được biến thể.'));
        },
      });
  }

  /**
   * Adds a component to a combo product.
   */
  addComboComponent(): void {
    const product = this.current();
    const componentProductId = this.comboComponentId();
    if (!product || !componentProductId) {
      return;
    }
    this.api
      .addComboItem(product.product_id, {
        componentProductId,
        quantity: Math.max(1, Math.trunc(Number(this.comboQuantity()) || 1)),
      })
      .subscribe({
        next: () => {
          this.comboComponentId.set('');
          this.comboQuantity.set(1);
          this.reloadCombo(product.product_id);
        },
        error: (error: unknown) => this.error.set(adminErrorMessage(error, 'Không thêm được thành phần combo.')),
      });
  }

  /**
   * Changes one combo quantity.
   */
  adjustCombo(item: AdminComboItemRow, delta: number): void {
    const product = this.current();
    const quantity = Math.max(1, Number(item.quantity || 1) + delta);
    if (!product || quantity === item.quantity) {
      return;
    }
    this.api.updateComboItem(product.product_id, item.combo_item_id, { quantity }).subscribe({
      next: () => this.reloadCombo(product.product_id),
      error: (error: unknown) => this.error.set(adminErrorMessage(error, 'Không cập nhật được thành phần combo.')),
    });
  }

  /**
   * Removes one combo component.
   */
  removeCombo(item: AdminComboItemRow): void {
    const product = this.current();
    if (!product) {
      return;
    }
    this.api.removeComboItem(product.product_id, item.combo_item_id).subscribe({
      next: () => this.reloadCombo(product.product_id),
      error: (error: unknown) => this.error.set(adminErrorMessage(error, 'Không xóa được thành phần combo.')),
    });
  }

  /**
   * Toggles a preset or learned style tag.
   */
  toggleStyleTag(tag: string): void {
    this.styleTags.update((list) => (list.includes(tag) ? list.filter((item) => item !== tag) : [...list, tag].slice(0, 30)));
  }

  /**
   * Commits a comma-separated list of custom tags.
   */
  addCustomTags(): void {
    const parts = parseListInput(this.customTag());
    if (!parts.length) {
      return;
    }
    this.styleTags.update((list) => [...new Set([...list, ...parts])].slice(0, 30));
    this.customTag.set('');
  }

  /**
   * Toggles an occasion or body-shape suggestion.
   */
  toggleIn(list: 'occasions' | 'bodyShapes', value: string): void {
    const source = list === 'occasions' ? this.occasions : this.bodyShapes;
    source.update((items) => (items.includes(value) ? items.filter((item) => item !== value) : [...items, value]));
  }

  /**
   * Asks the content model for description, SEO copy and PDP attributes, and stages them for review.
   */
  optimizeSeo(): void {
    if (this.aiSeoBusy()) {
      return;
    }
    const name = this.name().trim();
    if (name.length < 2) {
      this.aiSeoError.set('Nhập Tên sản phẩm trước khi tối ưu SEO bằng AI.');
      return;
    }
    this.aiSeoBusy.set(true);
    this.aiSeoError.set(null);
    this.aiSeoNote.set(null);
    const categoryName = this.categories().find((category) => category.category_id === this.categoryId())?.name;
    this.api
      .optimizeProductSeo({
        name,
        sku: this.sku(),
        categoryName,
        brand: this.brand(),
        collection: this.collection(),
        material: this.material(),
        description: this.description(),
        colors: this.variantColors().join(', '),
        sizes: [...new Set(this.matrix().map((row) => row.size).concat(this.variants().map((variant) => String(variant.size || ''))))].join(', '),
      })
      .subscribe({
        next: (result) => {
          this.aiSeoBusy.set(false);
          if (!result?.description) {
            this.aiSeoError.set('Chưa nhận được nội dung SEO. Hãy thử lại.');
            return;
          }
          this.aiSeo.set(result);
          this.applySeoResult(result);
          this.aiSeoNote.set(`Đã áp dụng bản nháp SEO (${result.seoScore}/100 · ${result.modelUsed}). Kiểm lại trước khi lưu.`);
        },
        error: (error: unknown) => {
          this.aiSeoBusy.set(false);
          this.aiSeoError.set(adminErrorMessage(error, 'Không tạo được nội dung SEO lúc này.'));
        },
      });
  }

  /**
   * Accepts one AI keyword list.
   */
  applySeoKeywords(): void {
    const result = this.aiSeo();
    if (!result) {
      return;
    }
    this.styleTags.set([...new Set([...this.styleTags(), ...(result.seoKeywords || []), ...result.styleTags])].slice(0, 30));
  }

  /**
   * Accepts one suggested SEO title.
   */
  useSeoTitle(title: string): void {
    this.seoTitle.set(title);
  }

  /**
   * Appends one content highlight to the description.
   */
  appendHighlight(highlight: string): void {
    const line = `• ${highlight.replace(/^[•\-*]\s*/, '').trim()}`;
    const current = this.description().trim();
    if (current.includes(line)) {
      return;
    }
    this.description.set(current ? `${current}\n${line}` : line);
  }

  /**
   * Validates locally, then creates the product or patches it with its fresh version.
   */
  submit(): void {
    if (!this.canSave() || this.saving()) {
      return;
    }
    this.error.set(null);
    const name = this.name().trim();
    const images = this.images();
    const imageColors = Object.fromEntries(
      Object.entries(this.imageColors()).filter(([url]) => images.includes(url)),
    );
    const colors = this.variantColors();
    const stale = Object.entries(imageColors).find(([, color]) => !colors.includes(color));
    if (stale) {
      this.error.set('Ảnh đang gán với màu không còn trong biến thể. Chọn lại màu hoặc để ảnh chung.');
      return;
    }
    const categoryId = this.categoryId();
    const description = this.descriptionWithMaterial();

    if (this.isCreate()) {
      const sku = this.sku().trim().toUpperCase();
      if (!SKU_PATTERN.test(sku)) {
        this.skuMessage.set(SKU_FORMAT_MESSAGE);
        this.error.set(SKU_FORMAT_MESSAGE);
        return;
      }
      if (this.skuMessage() || this.variantSkuMessage()) {
        this.error.set(this.skuMessage() || this.variantSkuMessage());
        return;
      }
      if (this.matrixComboClash()) {
        this.error.set('Mỗi tổ hợp màu và size chỉ được khai báo một lần.');
        return;
      }
      const payload: AdminProductCreateInput = {
        sku,
        name,
        slug: this.slug().trim() || slugifyProductText(name),
        categoryId,
        brand: this.brand().trim() || null,
        basePrice: Math.max(0, Number(this.basePrice())),
        salePrice: Math.max(0, Number(this.salePrice() || this.basePrice())),
        status: this.status(),
        collection: this.collection().trim() || null,
        description,
        seoTitle: this.seoTitle().trim() || null,
        seoDescription: this.seoDescription().trim() || null,
        colorTone: this.colorTone(),
        styleTags: this.styleTags(),
        occasions: this.occasions(),
        suitableBodyShapes: this.bodyShapes(),
        isFeatured: this.isFeatured(),
        isCombo: this.isCombo(),
        images,
        imageColors,
        variants: this.matrix().length ? this.matrix() : undefined,
        initialStock: this.matrix().length ? this.matrixStock() : Math.max(0, Math.trunc(Number(this.initialStock()) || 0)),
        lowStockThreshold: Math.max(0, Math.trunc(Number(this.initialThreshold()) || 0)),
        material: this.material().trim() || null,
        expectedVersion: 0,
      };
      this.saving.set(true);
      this.api.createProduct(payload).subscribe({
        next: (created) => this.finish(created),
        error: (error: unknown) => {
          this.saving.set(false);
          const message = adminErrorMessage(error);
          if (message === SKU_DUPLICATE_MESSAGE) {
            this.skuMessage.set(message);
          }
          this.error.set(message);
        },
      });
      return;
    }

    const product = this.current();
    if (!product || product.version == null) {
      this.error.set('Thiếu phiên bản sản phẩm để cập nhật.');
      return;
    }
    if (this.priceChanged() && !this.canChangePrice()) {
      this.error.set('Bạn không có quyền điều chỉnh giá. Hãy lưu thông tin khác rồi nhờ bộ phận giá cập nhật.');
      return;
    }
    if (this.priceChanged() && this.approvals().length) {
      this.error.set('Lưu điều chỉnh giá trước, rồi mở lại sản phẩm để phê duyệt ảnh theo phiên bản mới.');
      return;
    }
    const details: AdminProductUpdateInput = {
      name,
      categoryId,
      brand: this.brand().trim() || null,
      collection: this.collection().trim() || null,
      description,
      seoTitle: this.seoTitle().trim() || null,
      seoDescription: this.seoDescription().trim() || null,
      colorTone: this.colorTone(),
      styleTags: this.styleTags(),
      occasions: this.occasions(),
      suitableBodyShapes: this.bodyShapes(),
      isFeatured: this.isFeatured(),
      images,
      imageColors,
      expectedVersion: product.version,
    };
    this.saving.set(true);
    if (this.priceChanged()) {
      this.api
        .changePrice(product.product_id, {
          newBasePrice: Number(this.basePrice()),
          newSalePrice: Number(this.salePrice()) || null,
          reason: 'Cập nhật giá từ biểu mẫu sản phẩm',
          expectedVersion: product.version,
        })
        .subscribe({
          next: (priced) => {
            if (priced.version == null) {
              this.saving.set(false);
              this.error.set('Giá đã lưu nhưng phản hồi thiếu phiên bản. Mở lại sản phẩm trước khi lưu thông tin.');
              this.conflict.emit();
              return;
            }
            this.api.updateProduct(product.product_id, { ...details, expectedVersion: priced.version }).subscribe({
              next: (updated) => this.finish(updated),
              error: (error: unknown) => this.fail(error),
            });
          },
          error: (error: unknown) => this.fail(error),
        });
      return;
    }
    this.api.updateProduct(product.product_id, details).subscribe({
      next: (updated) => this.finish(updated),
      error: (error: unknown) => this.fail(error),
    });
  }

  /**
   * Shows one form section.
   */
  chooseSection(key: string): void {
    if (['info', 'variants', 'content', 'gallery', 'combo'].includes(key)) {
      this.section.set(key as EditorSection);
    }
  }

  /**
   * Locale money label.
   */
  money(value: number | null | undefined): string {
    return adminMoney(value);
  }

  /**
   * Line total of a combo component.
   */
  itemTotal(item: AdminComboItemRow): number {
    const unit = Number(item.product?.sale_price || item.product?.base_price || 0);
    return unit * Number(item.quantity || 1);
  }

  /** Vietnamese catalog status label, exposed for the modal header. */
  readonly statusLabel = productStatusLabel;

  /**
   * Moves every field the model returned into the form; nothing is written until the operator saves.
   */
  private applySeoResult(result: AdminProductFashionSeoResult): void {
    this.description.set(result.description);
    this.seoTitle.set(result.seoTitle || '');
    this.seoDescription.set(result.seoDescription || '');
    if (result.collection) {
      this.collection.set(result.collection);
    }
    if (result.material) {
      this.material.set(result.material);
    }
    if (result.colorTone) {
      this.colorTone.set(result.colorTone);
    }
    if (result.styleTags?.length) {
      this.styleTags.set(result.styleTags.slice(0, 30));
    }
    if (result.occasions?.length) {
      this.occasions.set(result.occasions);
    }
    if (result.suitableBodyShapes?.length) {
      this.bodyShapes.set(result.suitableBodyShapes);
    }
  }

  private updateMatrixRow(index: number, patch: Partial<AdminProductVariantInput>): void {
    this.matrix.update((rows) => rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  }

  private finish(product: AdminProductRow): void {
    this.saving.set(false);
    this.saved.emit(product);
  }

  private fail(error: unknown): void {
    this.saving.set(false);
    const message = adminErrorMessage(error);
    this.error.set(message);
    if (message.toUpperCase().includes('VERSION') || message.includes('tải lại')) {
      this.conflict.emit();
    }
  }

  private loadForm(product: AdminProductRow | null): void {
    this.error.set(null);
    this.skuMessage.set(null);
    this.variantSkuConflicts.set([]);
    this.approvals.set([]);
    this.aiSeo.set(null);
    this.aiSeoNote.set(null);
    this.aiSeoError.set(null);
    this.variantMessage.set(null);
    this.comboItems.set([]);
    this.matrix.set([]);
    this.newColor.set('');
    this.newSize.set('');
    this.newStock.set(0);
    this.newThreshold.set(5);
    if (!product) {
      this.name.set('');
      this.sku.set('VL-DAM001');
      this.slug.set('');
      this.categoryId.set('');
      this.basePrice.set(0);
      this.salePrice.set(0);
      this.status.set('on_sale');
      this.isFeatured.set(false);
      this.isCombo.set(false);
      this.description.set('');
      this.material.set('Lụa & Sợi tự nhiên cao cấp');
      this.seoTitle.set('');
      this.seoDescription.set('');
      this.colorTone.set('Neutral');
      this.styleTags.set(['Elegant', 'Smart Casual']);
      this.occasions.set(['Office', 'Casual']);
      this.bodyShapes.set(['Hourglass', 'Rectangle']);
      this.images.set([]);
      this.imageColors.set({});
      this.variants.set([]);
      this.colorsInput.set('Đen, Đỏ Ruby');
      this.sizesInput.set('S, M, L');
      this.initialStock.set(10);
      this.initialThreshold.set(5);
      this.regenerateMatrix();
      this.scheduleSkuCheck();
      return;
    }
    this.name.set(product.name);
    this.sku.set(product.sku || '');
    this.slug.set(product.slug || '');
    this.categoryId.set(product.category_id || '');
    this.brand.set(product.brand || 'Velura');
    this.collection.set(product.collection || 'Velura Atelier');
    this.basePrice.set(Number(product.base_price || 0));
    this.salePrice.set(Number(product.sale_price ?? product.base_price ?? 0));
    this.isFeatured.set(Boolean(product.is_featured));
    this.isCombo.set(Boolean(product.is_combo));
    this.description.set(product.description || '');
    this.material.set(MATERIAL_LINE.exec(product.description || '')?.[1]?.trim() || 'Lụa & Sợi tự nhiên cao cấp');
    this.seoTitle.set(product.seo_title || '');
    this.seoDescription.set(product.seo_description || '');
    this.colorTone.set(product.color_tone || 'Neutral');
    this.styleTags.set(product.style_tags?.length ? [...product.style_tags] : []);
    this.occasions.set(product.occasions?.length ? [...product.occasions] : []);
    this.bodyShapes.set(product.suitable_body_shapes?.length ? [...product.suitable_body_shapes] : []);
    this.images.set([...(product.images || [])]);
    this.imageColors.set({ ...(product.image_colors || {}) });
    this.variants.set(product.variants ? [...product.variants] : []);
    this.scheduleSkuCheck(product.product_id);
    if (product.is_combo) {
      this.reloadCombo(product.product_id);
    }
    if (!product.variants?.length) {
      this.reloadVariants(product.product_id);
    }
  }

  private reloadVariants(productId: string): void {
    forkJoin({
      variants: this.api.listVariants(productId).pipe(catchError(() => of({ rows: [] as AdminProductVariant[] }))),
      product: this.api.getProduct(productId).pipe(catchError(() => of(null))),
    }).subscribe(({ variants, product }) => {
      const rows = adminListRows(variants);
      this.variants.set(rows);
      if (this.current()?.product_id === productId) {
        this.refreshMatrixColors(rows);
      }
      if (product?.version != null) {
        this.basePrice.set(Number(product.base_price || 0));
        this.salePrice.set(Number(product.sale_price ?? product.base_price ?? 0));
      }
    });
  }

  private refreshMatrixColors(variants: readonly AdminProductVariant[]): void {
    const colors = [...new Set(variants.map((variant) => String(variant.color || '').trim()).filter(Boolean))];
    if (colors.length) {
      this.colorsInput.set(colors.join(', '));
    }
    const sizes = [...new Set(variants.map((variant) => String(variant.size || '').trim()).filter(Boolean))];
    if (sizes.length) {
      this.sizesInput.set(sizes.join(', '));
    }
  }

  private reloadCombo(productId: string): void {
    this.api.listComboItems(productId).subscribe({
      next: (payload) => this.comboItems.set(adminListRows(payload)),
      error: () => this.comboItems.set([]),
    });
  }

  private descriptionWithMaterial(): string {
    const description = this.description().trim();
    const material = this.material().trim();
    if (!material || description.includes(material)) {
      return description;
    }
    return description ? `${description}\nChất liệu: ${material}` : `Chất liệu: ${material}`;
  }

  /**
   * Debounced uniqueness check for the parent SKU and every generated variant SKU.
   */
  private scheduleSkuCheck(excludeProductId = ''): void {
    if (this.skuTimer !== null) {
      window.clearTimeout(this.skuTimer);
    }
    this.skuTimer = window.setTimeout(() => {
      this.skuTimer = null;
      this.verifySkus(excludeProductId);
    }, 300);
  }

  /**
   * Checks the parent SKU and every generated variant SKU against the whole catalog.
   */
  verifySkus(excludeProductId = ''): void {
    const revision = ++this.skuRevision;
    const sku = this.sku().trim().toUpperCase();
    if (!sku) {
      this.skuMessage.set(null);
      this.variantSkuConflicts.set([]);
      return;
    }
    if (!SKU_PATTERN.test(sku)) {
      this.skuMessage.set(SKU_FORMAT_MESSAGE);
      return;
    }
    const variantSkus = this.matrix()
      .map((row) => String(row.sku || '').trim().toUpperCase())
      .filter((value) => value && SKU_PATTERN.test(value));
    const candidates = [...new Set([sku, ...variantSkus])];
    forkJoin(
      candidates.map((candidate) =>
        this.api.checkProductSku(candidate, excludeProductId).pipe(catchError(() => of<AdminSkuCheck | null>(null))),
      ),
    ).subscribe({
      next: (results) => {
        if (revision !== this.skuRevision) {
          return;
        }
        const taken = new Set(
          candidates.filter((_, index) => results[index] !== null && results[index]!.available === false),
        );
        this.skuMessage.set(taken.has(sku) ? SKU_DUPLICATE_MESSAGE : null);
        this.variantSkuConflicts.set(variantSkus.filter((value) => taken.has(value) && value !== sku));
      },
      error: () => {
        if (revision === this.skuRevision) {
          this.skuMessage.set(null);
          this.variantSkuConflicts.set([]);
        }
      },
    });
  }
}
