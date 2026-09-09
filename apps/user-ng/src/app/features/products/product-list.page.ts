import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, finalize, of } from 'rxjs';
import { ProductSummary } from '../../core/models/product.interface';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { CatalogService } from '../../core/services/catalog.service';
import { formatVnd } from '../../core/utils/money';
import { showToast } from '../../core/utils/toast';
import { ProductCard } from '../../shared/product-card/product-card';

const ITEMS_PER_PAGE = 12;
const SUGGESTIONS_KEY = 'velura_suggestions_enabled';
const CATALOG_CATEGORIES = [
  { slug: 'ao', name: 'Áo' },
  { slug: 'quan', name: 'Quần' },
  { slug: 'dam-vay', name: 'Đầm & Váy' },
  { slug: 'ao-khoac', name: 'Áo khoác' },
  { slug: 'set-do', name: 'Set đồ' },
  { slug: 'phu-kien', name: 'Phụ kiện' },
  { slug: 'giay-dep', name: 'Giày dép' },
];
const CATEGORY_QUERY_MAP: Record<string, string> = {
  top: 'ao',
  pants: 'quan',
  dress: 'dam-vay',
  jacket: 'ao-khoac',
  set: 'set-do',
  accessories: 'phu-kien',
  shoes: 'giay-dep',
};
const CLOTHING_SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const SHOE_SIZES = ['35', '36', '37', '38', '39', '40', '41'];
const COLOR_MAP: Record<string, string[]> = {
  đen: ['black', 'onyx', 'charcoal', 'slate', 'midnight', 'đầm đen', 'đen', 'grey', 'gray'],
  trắng: ['white', 'ivory', 'cream', 'champagne', 'sakura white', 'off-white', 'trắng'],
  terracotta: ['terracotta', 'cinnamon', 'red', 'burgundy', 'đỏ', 'hồng đỏ', 'pink', 'rose', 'glitter silver', 'silver', 'gold'],
  kem: ['cream', 'beige', 'buttercream', 'sand', 'oat', 'kem', 'brown', 'caramel', 'camel', 'cocoa', 'sand shell', 'grey', 'gray'],
  'xanh rêu': ['green', 'sage', 'mint', 'emerald', 'rêu', 'xanh lá', 'olive', 'teal', 'khaki'],
  'xanh lam': ['blue', 'sapphire', 'xanh dương', 'xanh lam', 'slate blue', 'navy', 'ice blue', 'baby blue', 'dusty blue', 'tweed blue'],
};

const BODY_SHAPES = [
  { value: 'Hourglass', label: 'Đồng hồ cát' },
  { value: 'Pear', label: 'Dáng quả lê' },
  { value: 'Apple', label: 'Dáng quả táo' },
  { value: 'Rectangle', label: 'Dáng chữ nhật' },
  { value: 'Inverted Triangle', label: 'Dáng tam giác ngược' },
];

const BODY_SHAPE_LABELS: Record<string, string> = {
  hourglass: 'Đồng hồ cát',
  pear: 'Quả lê',
  apple: 'Quả táo',
  rectangle: 'Chữ nhật',
  'inverted triangle': 'Tam giác ngược',
};

const QUIZ_COLOR_MAP: Record<string, string> = {
  đen: 'Đen', black: 'Đen', charcoal: 'Đen', slate: 'Đen', midnight: 'Đen', onyx: 'Đen',
  trắng: 'Trắng', white: 'Trắng', ivory: 'Trắng', champagne: 'Trắng',
  terracotta: 'Terracotta', cinnamon: 'Terracotta', red: 'Terracotta', burgundy: 'Terracotta', đỏ: 'Terracotta',
  kem: 'Kem', cream: 'Kem', beige: 'Kem', buttercream: 'Kem', sand: 'Kem', oat: 'Kem', brown: 'Kem',
  'xanh rêu': 'Xanh rêu', green: 'Xanh rêu', sage: 'Xanh rêu', mint: 'Xanh rêu',
  'xanh lam': 'Xanh lam', blue: 'Xanh lam', navy: 'Xanh lam', sapphire: 'Xanh lam',
};

const BUDGET_LABELS: Record<string, string> = {
  under_300k: 'Dưới 300k',
  '300k_700k': '300k – 700k',
  '700k_1.5m': '700k – 1.5M',
  'above_1.5m': 'Trên 1.5M',
};

interface StyleQuiz {
  body_shape?: string;
  style_tags?: string[] | string;
  preferred_occasions?: string[] | string;
  favorite_colors?: string[] | string;
  budget_range?: string;
  chest_cm?: number;
  waist_cm?: number;
  hip_cm?: number;
  skin_tone?: string;
}

type PageItem = { kind: 'page'; value: number } | { kind: 'dots'; value: number };
type CatalogView = 'grid' | 'large' | 'list';

@Component({
  selector: 'app-product-list-page',
  imports: [ProductCard, RouterLink],
  host: { style: 'display:block' },
  templateUrl: './product-list.page.html',
})
export class ProductListPage {
  private readonly catalog = inject(CatalogService);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly allProducts = signal<ProductSummary[]>([]);
  readonly categories = CATALOG_CATEGORIES;
  readonly selectedSlugs = signal<string[]>([]);
  readonly searchQuery = signal('');
  readonly sort = signal('newest');
  readonly sidebarOpen = signal(false);
  readonly minPrice = signal(0);
  readonly maxPrice = signal(5_000_000);
  readonly catalogMaxPrice = signal(5_000_000);
  readonly selectedColor = signal('');
  readonly selectedSize = signal('');
  readonly specials = signal<string[]>([]);
  readonly selectedShapes = signal<string[]>([]);
  readonly currentPage = signal(1);
  readonly viewMode = signal<CatalogView>('grid');
  readonly quiz = signal<StyleQuiz | null>(null);
  readonly suggestionsEnabled = signal(localStorage.getItem(SUGGESTIONS_KEY) !== 'false');
  readonly featuredFallback = computed(() => this.allProducts().filter((item) => item.is_featured).slice(0, 4));
  readonly colorSwatches = [
    { title: 'Đen', hex: '#2A2522' },
    { title: 'Trắng', hex: '#FFFFFF' },
    { title: 'Terracotta', hex: '#C97B63' },
    { title: 'Kem', hex: '#E8DFD6' },
    { title: 'Xanh rêu', hex: '#89A894' },
    { title: 'Xanh lam', hex: '#8AACF5' },
  ];
  readonly sizeOptions = computed(() => {
    const slugs = this.selectedSlugs();
    const shoesOnly = slugs.length === 1 && slugs[0] === 'giay-dep';
    return shoesOnly ? SHOE_SIZES : CLOTHING_SIZES;
  });
  readonly bodyShapes = BODY_SHAPES;
  readonly isLoggedIn = this.auth.isLoggedIn;
  readonly hasStyleProfile = computed(() => Boolean(this.quiz()?.body_shape || this.quiz()?.style_tags));
  readonly bodyShapeUnlocked = computed(() => this.hasStyleProfile());
  readonly bodyShapeLabel = computed(() => {
    const shape = (this.quiz()?.body_shape || '').toLowerCase();
    return BODY_SHAPE_LABELS[shape] || this.quiz()?.body_shape || '';
  });
  readonly profileTags = computed(() => this.buildProfileTags(this.quiz()).slice(0, 6));
  readonly fitHelperState = computed(() => {
    if (this.hasStyleProfile()) {
      return this.suggestionsEnabled() ? 'active' : 'paused';
    }
    return this.isLoggedIn() ? 'empty' : 'guest';
  });

  readonly filteredProducts = computed(() => {
    const slugs = this.selectedSlugs();
    const query = this.searchQuery().toLowerCase().trim();
    const minPrice = this.minPrice();
    const maxPrice = this.maxPrice();
    const color = this.selectedColor().toLowerCase();
    const size = this.selectedSize().toLowerCase();
    const specials = this.specials();
    const shapes = this.selectedShapes().map((shape) => shape.toLowerCase());
    const sort = this.sort();
    const tokens = query.split(/\s+/).filter((token) => token.length > 0);

    const scored = this.allProducts().map((product) => {
      let score = 0;
      if (query) {
        if ((product.name || '').toLowerCase().includes(query)) {
          score += 100;
        }
        for (const token of tokens) {
          if ((product.name || '').toLowerCase().includes(token)) {
            score += 15;
          }
          if ((product.description || '').toLowerCase().includes(token)) {
            score += 2;
          }
          if ((product.brand || '').toLowerCase().includes(token)) {
            score += 5;
          }
          if ((product.category_name || '').toLowerCase().includes(token)) {
            score += 8;
          }
          if ((product.category_slug || '').toLowerCase().includes(token)) {
            score += 8;
          }
        }
      }
      return { product, score };
    });

    let rows = scored.filter(({ product, score }) => {
      if (query && score <= 0) {
        return false;
      }
      if (slugs.length && !this.matchesCategory(product, slugs)) {
        return false;
      }
      if (specials.length && !this.matchesSpecial(product, specials)) {
        return false;
      }
      const price = product.sale_price || product.base_price || 0;
      if (price < minPrice || price > maxPrice) {
        return false;
      }
      if (color) {
        const allowed = COLOR_MAP[color] || [color];
        const hasColor = product.variants?.some((variant) =>
          allowed.some((token) => (variant.color || '').toLowerCase().includes(token)),
        );
        if (!hasColor) {
          return false;
        }
      }
      if (size) {
        const hasSize = product.variants?.some((variant) => (variant.size || '').toLowerCase() === size);
        if (!hasSize) {
          return false;
        }
      }
      if (shapes.length) {
        const suitable = (product.suitable_body_shapes || []).map((shape) => (shape || '').toLowerCase());
        if (!shapes.some((shape) => suitable.includes(shape))) {
          return false;
        }
      }
      return true;
    });

    rows = [...rows].sort((a, b) => {
      const productA = a.product;
      const productB = b.product;
      const priceA = productA.sale_price || productA.base_price || 0;
      const priceB = productB.sale_price || productB.base_price || 0;
      if (query && sort === 'newest' && b.score !== a.score) {
        return b.score - a.score;
      }
      if (sort === 'price-asc') {
        return priceA - priceB;
      }
      if (sort === 'price-desc') {
        return priceB - priceA;
      }
      if (sort === 'popular') {
        return (productB.sold_count || 0) - (productA.sold_count || 0);
      }
      return new Date(productB.updated_at || productB.created_at || 0).getTime()
        - new Date(productA.updated_at || productA.created_at || 0).getTime();
    });

    return rows.map((row) => row.product);
  });
  readonly productCount = computed(() => this.filteredProducts().length);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.productCount() / ITEMS_PER_PAGE)));
  readonly pagedProducts = computed(() => {
    const page = Math.min(this.currentPage(), this.totalPages());
    const start = (page - 1) * ITEMS_PER_PAGE;
    return this.filteredProducts().slice(start, start + ITEMS_PER_PAGE);
  });
  readonly pageItems = computed<PageItem[]>(() => {
    const total = this.totalPages();
    const current = Math.min(this.currentPage(), total);
    const items: PageItem[] = [];
    for (let page = 1; page <= total; page += 1) {
      if (page === 1 || page === total || (page >= current - 2 && page <= current + 2)) {
        items.push({ kind: 'page', value: page });
      } else if (page === current - 3 || page === current + 3) {
        items.push({ kind: 'dots', value: page });
      }
    }
    return items;
  });
  readonly showPagination = computed(() => this.productCount() > ITEMS_PER_PAGE);
  readonly activeCategoryLabel = computed(() => {
    if (this.searchQuery()) {
      return `Kết quả tìm kiếm cho: "${this.searchQuery()}"`;
    }
    const slugs = this.selectedSlugs();
    if (!slugs.length) {
      return 'Tất cả sản phẩm';
    }
    return slugs
      .map((slug) => this.categories.find((item) => item.slug === slug)?.name || slug)
      .join(', ');
  });
  readonly priceRangeLabel = computed(() => `${formatVnd(this.minPrice())} – ${formatVnd(this.maxPrice())}`);
  readonly gridClass = computed(() => {
    if (this.viewMode() === 'large') {
      return 'product-grid product-grid--large-view';
    }
    if (this.viewMode() === 'list') {
      return 'product-grid product-grid--list';
    }
    return 'product-grid';
  });

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const category = params.get('category') || '';
      const slug = CATEGORY_QUERY_MAP[category] || category;
      this.selectedSlugs.set(slug ? [slug] : []);
      this.searchQuery.set((params.get('q') || '').trim());
      this.currentPage.set(1);
    });
    this.catalog
      .getProducts()
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (rows) => {
          const catalog = rows.filter((item) => {
            const name = (item.name || '').toLowerCase();
            return !name.includes('test') && !name.includes('validation') && !name.includes('commit');
          });
          this.allProducts.set(catalog);
          const ceiling = Math.max(
            ...catalog.map((item) => item.sale_price || item.base_price || 0),
            5_000_000,
          );
          this.catalogMaxPrice.set(ceiling);
          if (!this.quiz() || !this.suggestionsEnabled()) {
            this.maxPrice.set(ceiling);
          }
        },
        error: (error: Error) => this.loadError.set(error.message),
      });
    this.api
      .get<{ quiz?: StyleQuiz }>('/api/user/style-quiz')
      .pipe(catchError(() => of({ quiz: undefined })))
      .subscribe({
        next: (data) => {
          const quiz = data.quiz ? this.normalizeQuiz(data.quiz) : null;
          this.quiz.set(quiz);
          if (quiz && localStorage.getItem(SUGGESTIONS_KEY) === null) {
            this.suggestionsEnabled.set(true);
            localStorage.setItem(SUGGESTIONS_KEY, 'true');
          }
          if (this.suggestionsEnabled() && quiz) {
            this.applyProfileFilters(true);
          }
        },
      });
  }

  /**
   * Toggles the mobile filter drawer.
   */
  toggleSidebar(): void {
    this.sidebarOpen.update((open) => !open);
  }

  /**
   * Clears every original catalog filter.
   */
  clearFilters(): void {
    this.selectedSlugs.set([]);
    this.minPrice.set(0);
    this.maxPrice.set(this.catalogMaxPrice());
    this.selectedColor.set('');
    this.selectedSize.set('');
    this.specials.set([]);
    this.selectedShapes.set([]);
    this.currentPage.set(1);
    if (this.hasStyleProfile()) {
      this.suggestionsEnabled.set(false);
      localStorage.setItem(SUGGESTIONS_KEY, 'false');
    }
    showToast('Đã xóa toàn bộ bộ lọc');
  }

  /**
   * Updates sort order from the original select control.
   */
  onSortChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.sort.set(select.value);
    this.currentPage.set(1);
  }

  /**
   * Selects a category checkbox using original Velura slugs.
   */
  onCategoryChange(slug: string, event: Event): void {
    const input = event.target as HTMLInputElement;
    const current = this.selectedSlugs();
    this.selectedSlugs.set(input.checked ? [...current.filter((item) => item !== slug), slug] : current.filter((item) => item !== slug));
    this.currentPage.set(1);
    if (!this.sizeOptions().includes(this.selectedSize())) {
      this.selectedSize.set('');
    }
  }

  /**
   * Updates the original min/max price inputs.
   */
  onPriceChange(bound: 'min' | 'max', event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (bound === 'min') {
      this.minPrice.set(Number.isFinite(value) ? Math.max(0, value) : 0);
    } else {
      this.maxPrice.set(Number.isFinite(value) && value > 0 ? value : this.catalogMaxPrice());
    }
    this.currentPage.set(1);
  }

  /**
   * Toggles a color swatch from the original palette.
   */
  selectColor(title: string): void {
    this.selectedColor.update((current) => (current === title ? '' : title));
    this.currentPage.set(1);
  }

  /**
   * Toggles a size chip from the original size selector.
   */
  selectSize(size: string): void {
    this.selectedSize.update((current) => (current === size ? '' : size));
    this.currentPage.set(1);
  }

  /**
   * Toggles featured / combo / on-sale filters.
   */
  onSpecialChange(value: string, event: Event): void {
    const input = event.target as HTMLInputElement;
    const current = this.specials();
    this.specials.set(input.checked ? [...current, value] : current.filter((item) => item !== value));
    this.currentPage.set(1);
  }

  /**
   * Toggles a body-shape checkbox from the original catalog sidebar.
   */
  onShapeChange(value: string, event: Event): void {
    if (!this.bodyShapeUnlocked()) {
      return;
    }
    const input = event.target as HTMLInputElement;
    const current = this.selectedShapes();
    this.selectedShapes.set(input.checked ? [...current.filter((item) => item !== value), value] : current.filter((item) => item !== value));
    this.currentPage.set(1);
  }

  /**
   * Turns Style Profile auto-filters on or off like vanilla `js-style-profile-switch`.
   */
  toggleSuggestions(event: Event): void {
    if (!this.hasStyleProfile()) {
      return;
    }
    const enabled = (event.target as HTMLInputElement).checked;
    this.suggestionsEnabled.set(enabled);
    localStorage.setItem(SUGGESTIONS_KEY, String(enabled));
    this.applyProfileFilters(enabled);
  }

  /**
   * Toggles Style Profile suggestions from the original fit-helper buttons.
   */
  setSuggestions(enabled: boolean): void {
    if (!this.hasStyleProfile()) {
      return;
    }
    this.suggestionsEnabled.set(enabled);
    localStorage.setItem(SUGGESTIONS_KEY, String(enabled));
    this.applyProfileFilters(enabled);
  }

  /**
   * Switches the original catalog grid / large / list view.
   */
  setView(mode: CatalogView): void {
    this.viewMode.set(mode);
  }

  /**
   * Moves to a catalog page and scrolls back to the grid like the original.
   */
  goToPage(page: number): void {
    const total = this.totalPages();
    const next = Math.min(Math.max(1, page), total);
    if (next === this.currentPage()) {
      return;
    }
    this.currentPage.set(next);
    document.querySelector('.product-list-layout')?.scrollIntoView({ behavior: 'smooth' });
  }

  /**
   * Goes to the previous catalog page.
   */
  prevPage(): void {
    this.goToPage(this.currentPage() - 1);
  }

  /**
   * Goes to the next catalog page.
   */
  nextPage(): void {
    this.goToPage(this.currentPage() + 1);
  }

  private applyProfileFilters(enable: boolean): void {
    const quiz = this.quiz();
    if (!quiz) {
      return;
    }
    if (!enable) {
      this.minPrice.set(0);
      this.maxPrice.set(this.catalogMaxPrice());
      this.selectedColor.set('');
      this.selectedSize.set('');
      this.selectedShapes.set([]);
      this.currentPage.set(1);
      return;
    }
    const budget = quiz.budget_range || '';
    if (budget === 'under_300k') {
      this.minPrice.set(0);
      this.maxPrice.set(300_000);
    } else if (budget === '300k_700k') {
      this.minPrice.set(300_000);
      this.maxPrice.set(700_000);
    } else if (budget === '700k_1.5m') {
      this.minPrice.set(700_000);
      this.maxPrice.set(1_500_000);
    } else if (budget === 'above_1.5m') {
      this.minPrice.set(1_500_000);
      this.maxPrice.set(5_000_000);
    }
    const colors = this.asArray(quiz.favorite_colors);
    let targetColor = '';
    for (const raw of colors) {
      const name = raw.split('|')[0].trim().toLowerCase();
      if (QUIZ_COLOR_MAP[name]) {
        targetColor = QUIZ_COLOR_MAP[name];
        break;
      }
    }
    if (!targetColor && quiz.skin_tone) {
      const tone = quiz.skin_tone.toLowerCase();
      const toneMap: Record<string, string> = { warm: 'Terracotta', cool: 'Trắng', neutral: 'Kem' };
      targetColor = toneMap[tone] || '';
    }
    this.selectedColor.set(targetColor);
    this.selectedSize.set(this.recommendedSize(quiz));
    this.selectedShapes.set(quiz.body_shape ? [quiz.body_shape] : []);
    this.currentPage.set(1);
  }

  private recommendedSize(quiz: StyleQuiz): string {
    if (!quiz.chest_cm && !quiz.waist_cm) {
      return '';
    }
    const chest = quiz.chest_cm || 0;
    const waist = quiz.waist_cm || 0;
    const hip = quiz.hip_cm || 0;
    if (chest <= 80 && waist <= 64 && hip <= 86) {
      return 'XS';
    }
    if (chest <= 84 && waist <= 68 && hip <= 90) {
      return 'S';
    }
    if (chest <= 88 && waist <= 72 && hip <= 94) {
      return 'M';
    }
    if (chest <= 92 && waist <= 76 && hip <= 98) {
      return 'L';
    }
    return 'XL';
  }

  private normalizeQuiz(quiz: StyleQuiz): StyleQuiz {
    return {
      ...quiz,
      style_tags: this.asArray(quiz.style_tags),
      preferred_occasions: this.asArray(quiz.preferred_occasions),
      favorite_colors: this.asArray(quiz.favorite_colors),
    };
  }

  private asArray(value: string[] | string | undefined): string[] {
    if (Array.isArray(value)) {
      return value;
    }
    if (typeof value === 'string' && value.startsWith('{')) {
      return value.replace(/^{|}$/g, '').split(',').map((item) => item.trim().replace(/^"|"$/g, '')).filter(Boolean);
    }
    return typeof value === 'string' && value ? [value] : [];
  }

  private buildProfileTags(quiz: StyleQuiz | null): string[] {
    if (!quiz) {
      return [];
    }
    const tags = [...this.asArray(quiz.style_tags), ...this.asArray(quiz.preferred_occasions)];
    for (const color of this.asArray(quiz.favorite_colors).slice(0, 2)) {
      tags.push(color.split('|')[0].trim());
    }
    if (quiz.budget_range) {
      tags.push(BUDGET_LABELS[quiz.budget_range] || quiz.budget_range);
    }
    return tags.filter(Boolean);
  }

  private matchesCategory(product: ProductSummary, slugs: string[]): boolean {
    if (slugs.includes(product.category_slug || '')) {
      return true;
    }
    if (slugs.includes('set-do') && (product.is_combo || /\bset\b/i.test(product.name || ''))) {
      return true;
    }
    return false;
  }

  private matchesSpecial(product: ProductSummary, specials: string[]): boolean {
    return specials.some((spec) => {
      if (spec === 'featured') {
        return product.is_featured === true;
      }
      if (spec === 'combo') {
        return product.is_combo === true;
      }
      if (spec === 'on_sale') {
        return Boolean(product.sale_price && product.base_price && product.base_price > product.sale_price);
      }
      return false;
    });
  }
}
