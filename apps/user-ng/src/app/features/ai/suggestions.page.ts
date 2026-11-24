import { Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Subscription, throwError, timeout } from 'rxjs';
import { ProductSummary } from '../../core/models/product.interface';
import { AuthService } from '../../core/services/auth.service';
import { StyleProfileService } from '../../core/services/style-profile.service';
import type { OutfitCombo, RecommendationCategory, StyleQuizRecord } from '../../core/models/style-profile.interface';
import { CartStore } from '../../core/services/cart.store';
import { formatVnd, toPublicAsset } from '../../core/utils/money';
import { showToast } from '../../core/utils/toast';
import { useBodyClass } from '../../core/utils/body-class';
import { ProductCard } from '../../shared/product-card/product-card';

const BODY_SHAPE_MAP: Record<string, string> = {
  Hourglass: 'Đồng hồ cát',
  Pear: 'Quả lê',
  Apple: 'Quả táo',
  Rectangle: 'Chữ nhật',
  'Inverted Triangle': 'Tam giác ngược',
};

const STYLE_TAG_MAP: Record<string, string> = {
  Minimalist: 'Tối giản',
  Classic: 'Cổ điển',
  Romantic: 'Lãng mạn',
  Elegant: 'Thanh lịch',
  Boho: 'Phóng khoáng',
  Street: 'Đường phố',
  Sporty: 'Thể thao',
  'Smart Casual': 'Lịch sự năng động',
};

@Component({
  selector: 'app-ai-suggestions-page',
  imports: [RouterLink, ProductCard],
  host: { class: 'page-ai' },
  templateUrl: './suggestions.page.html',
})
export class AiSuggestionsPage {
  private readonly profile = inject(StyleProfileService);
  private readonly destroyRef = inject(DestroyRef);
  private request?: Subscription;
  private requestVersion = 0;
  private readonly auth = inject(AuthService);
  private readonly cart = inject(CartStore);
  private readonly comboTrack = viewChild<ElementRef<HTMLElement>>('comboTrack');
  private readonly profileTrack = viewChild<ElementRef<HTMLElement>>('profileTrack');

  readonly loading = signal(true);
  readonly loadError = signal('');
  readonly hasQuiz = signal(false);
  readonly styleLabel = signal('Chưa chọn phong cách');
  readonly bodyShapeLabel = signal('Chưa khai báo');
  readonly combos = signal<OutfitCombo[]>([]);
  readonly categories = signal<RecommendationCategory[]>([]);
  readonly activeCategoryId = signal<string | null>('all');
  readonly selectedCombo = signal<OutfitCombo | null>(null);
  readonly pageSize = signal(8);
  readonly currentPage = signal(1);
  readonly totalPages = computed(() => {
    const total = this.profileProducts().length;
    return Math.max(1, Math.ceil(total / this.pageSize()));
  });
  readonly paginatedProducts = computed(() => {
    const list = this.profileProducts();
    const page = this.currentPage();
    const size = this.pageSize();
    const start = (page - 1) * size;
    return list.slice(start, start + size);
  });
  readonly pageNumbers = computed(() => {
    const total = this.totalPages();
    return Array.from({ length: total }, (_, i) => i + 1);
  });
  /**
   * Compact pagination items with ellipsis for AI suggestions.
   */
  readonly pageItems = computed<Array<{ kind: 'page' | 'dots'; value: number }>>(() => {
    const total = this.totalPages();
    const current = Math.min(Math.max(1, this.currentPage()), total);
    const items: Array<{ kind: 'page' | 'dots'; value: number }> = [];

    if (total <= 7) {
      for (let p = 1; p <= total; p++) {
        items.push({ kind: 'page', value: p });
      }
      return items;
    }

    if (current <= 4) {
      for (let p = 1; p <= 5; p++) {
        items.push({ kind: 'page', value: p });
      }
      items.push({ kind: 'dots', value: -1 });
      items.push({ kind: 'page', value: total });
    } else if (current >= total - 3) {
      items.push({ kind: 'page', value: 1 });
      items.push({ kind: 'dots', value: -1 });
      for (let p = total - 4; p <= total; p++) {
        items.push({ kind: 'page', value: p });
      }
    } else {
      items.push({ kind: 'page', value: 1 });
      items.push({ kind: 'dots', value: -1 });
      items.push({ kind: 'page', value: current - 1 });
      items.push({ kind: 'page', value: current });
      items.push({ kind: 'page', value: current + 1 });
      items.push({ kind: 'dots', value: -2 });
      items.push({ kind: 'page', value: total });
    }

    return items;
  });
  readonly displayName = computed(() => {
    if (this.auth.isLoggedIn()) {
      return this.auth.session()?.fullName || 'Thành viên Velura';
    }
    return 'Khách hàng (Guest)';
  });
  readonly avatarInitials = computed(() => {
    const parts = this.displayName().split(' ').filter(Boolean);
    return parts.map((word) => word[0]).join('').slice(0, 2).toUpperCase();
  });
  readonly styleSubtitle = computed(() => `Dựa trên phong cách ${this.styleLabel()} của bạn`);
  readonly profileSummary = computed(
    () => `Dáng người: ${this.bodyShapeLabel()} • Phong cách: ${this.styleLabel()}`,
  );
  readonly allProducts = computed(() => {
    const list: ProductSummary[] = [];
    const seen = new Set<string>();
    for (const cat of this.categories()) {
      for (const p of cat.products || []) {
        if (!seen.has(p.product_id)) {
          seen.add(p.product_id);
          list.push(p);
        }
      }
    }
    return list;
  });
  readonly allProductsCount = computed(() => this.allProducts().length);
  readonly activeCategory = computed(() => {
    const activeId = this.activeCategoryId();
    if (activeId === 'all') {
      return null;
    }
    return this.categories().find((row) => row.category_id === activeId) || null;
  });
  readonly profileProducts = computed(() => {
    const activeId = this.activeCategoryId();
    if (activeId === 'all' || !activeId) {
      return this.allProducts();
    }
    return this.activeCategory()?.products || [];
  });

  constructor() {
    useBodyClass('page-ai');
    effect(() => {
      this.auth.session();
      this.profile.revision();
      untracked(() => this.loadRecommendations());
    });
    this.destroyRef.onDestroy(() => document.body.classList.remove('modal-open'));
  }

  /**
   * Selects a Style Profile category pill.
   */
  selectCategory(categoryId: string): void {
    this.activeCategoryId.set(categoryId);
    this.currentPage.set(1);
  }

  /**
   * Navigates to a specific page number in the Style Profile product grid.
   */
  goToPage(page: number): void {
    if (page < 1 || page > this.totalPages() || page === this.currentPage()) {
      return;
    }
    this.currentPage.set(page);
    const container = document.getElementById('profile-categories-container');
    if (container && typeof container.scrollIntoView === 'function') {
      container.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /**
   * Navigates to the next page of Style Profile suggestions.
   */
  nextPage(): void {
    if (this.currentPage() < this.totalPages()) {
      this.goToPage(this.currentPage() + 1);
    }
  }

  /**
   * Navigates to the previous page of Style Profile suggestions.
   */
  prevPage(): void {
    if (this.currentPage() > 1) {
      this.goToPage(this.currentPage() - 1);
    }
  }

  /**
   * Scrolls the original combo carousel.
   */
  scrollCombos(direction: -1 | 1): void {
    this.comboTrack()?.nativeElement.scrollBy({ left: direction * 300, behavior: 'smooth' });
  }

  /**
   * Scrolls the original Style Profile product slider.
   */
  scrollProfile(direction: -1 | 1): void {
    this.profileTrack()?.nativeElement.scrollBy({ left: direction * 320, behavior: 'smooth' });
  }

  /**
   * Opens the original combo detail modal.
   */
  openCombo(combo: OutfitCombo): void {
    this.selectedCombo.set(combo);
    document.body.classList.add('modal-open');
  }

  /**
   * Closes the original combo detail modal.
   */
  closeCombo(): void {
    this.selectedCombo.set(null);
    document.body.classList.remove('modal-open');
  }

  /**
   * Adds every product in an AI combo using the original cart payload.
   */
  addComboToCart(combo: OutfitCombo, event?: Event): void {
    event?.stopPropagation();
    const comboId = `combo-${combo.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const lines = combo.products.map((product) => {
      const variant = product.variants?.[0];
      return {
        variant_id: variant?.variant_id || `mock-var-${product.product_id}`,
        product_id: product.product_id,
        product_name: product.name,
        product_image: this.imageUrl(product),
        quantity: 1,
        unit_price: Number(product.sale_price || product.base_price || 0),
        color: variant?.color || 'Mặc định',
        size: variant?.size || 'Free Size',
        combo_id: comboId,
        combo_name: combo.name,
        combo_price: Number(combo.sale_price || combo.base_price || 0),
      };
    });
    this.cart.addCombo(lines, `Đã thêm set đồ ${combo.name} vào giỏ hàng!`);
  }

  /**
   * Public image helper for suggestion cards.
   */
  imageUrl(product: ProductSummary | undefined, fallback = '/assets/images/product-silk-blazer.png'): string {
    return toPublicAsset(product?.images?.[0] || product?.thumbnail_url, fallback);
  }

  /**
   * Public price helper for combo cards.
   */
  comboPriceLabel(combo: OutfitCombo): string {
    return formatVnd(combo.sale_price || combo.base_price);
  }

  /**
   * Public price helper for a single suggested product.
   */
  productPriceLabel(product: ProductSummary): string {
    return formatVnd(product.sale_price || product.base_price);
  }

  /**
   * First three products shown on an AI combo card.
   */
  comboThumbs(combo: OutfitCombo): ProductSummary[] {
    return (combo.products || []).slice(0, 3);
  }

  /**
   * Stylist reason copy for a combo card.
   */
  comboReason(combo: OutfitCombo): string {
    return combo.reason || combo.description || '';
  }

  /**
   * Category badge shown on a combo thumbnail.
   */
  comboThumbLabel(product: ProductSummary, index: number): string {
    if (product.category_name) {
      return product.category_name;
    }
    return index === 0 ? 'Áo' : index === 1 ? 'Quần' : 'Phụ kiện';
  }

  /** Reload the current user's recommendations with a recoverable error, without inventing profile data. */
  loadRecommendations(): void {
    this.request?.unsubscribe();
    const version = ++this.requestVersion;
    const session = this.auth.session();
    this.loading.set(true);
    this.loadError.set('');
    this.hasQuiz.set(false);
    this.combos.set([]);
    this.categories.set([]);
    this.closeCombo();
    this.request = this.profile.loadRecommendations().pipe(
      timeout({ each: 15000, with: () => throwError(() => new Error('Máy chủ phản hồi chậm. Vui lòng thử lại.')) }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({ next: (response) => {
        if (version !== this.requestVersion || session !== this.auth.session()) return;
        const quiz = this.normalizeQuiz(response.quiz);
        const hasQuiz = Boolean(quiz);
        this.hasQuiz.set(hasQuiz);
        if (hasQuiz && quiz) {
          const tags = Array.isArray(quiz.style_tags) ? quiz.style_tags : [];
          this.styleLabel.set(STYLE_TAG_MAP[tags[0] || ''] || tags[0] || 'Chưa chọn phong cách');
          this.bodyShapeLabel.set(BODY_SHAPE_MAP[quiz.body_shape || ''] || quiz.body_shape || 'Chưa khai báo');
        }
        this.combos.set(response.combos || []);
        const categories = response.categories || [];
        this.categories.set(categories);
        this.activeCategoryId.set('all');
        this.currentPage.set(1);
        this.loading.set(false);
      }, error: (error: Error) => {
        if (version !== this.requestVersion || session !== this.auth.session()) return;
        this.loading.set(false);
        this.loadError.set(error.message || 'Chưa tải được gợi ý phong cách. Vui lòng thử lại.');
      } });
  }

  private normalizeQuiz(quiz: StyleQuizRecord | null | undefined): StyleQuizRecord | null {
    if (!quiz) {
      return null;
    }
    const tags = quiz.style_tags;
    if (typeof tags === 'string') {
      return { ...quiz, style_tags: this.parsePgArray(tags) };
    }
    return quiz;
  }

  private parsePgArray(value: string): string[] {
    if (!value.startsWith('{')) {
      return value ? [value] : [];
    }
    return value
      .replace(/^{|}$/g, '')
      .split(',')
      .map((item) => item.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
  }

}
