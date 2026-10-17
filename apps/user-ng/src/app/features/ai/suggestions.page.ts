import { Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import type { Subscription } from 'rxjs';
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
  readonly activeCategoryId = signal<string | null>(null);
  readonly selectedCombo = signal<OutfitCombo | null>(null);
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
  readonly activeCategory = computed(
    () => this.categories().find((row) => row.category_id === this.activeCategoryId()) || this.categories()[0] || null,
  );
  readonly profileProducts = computed(() => this.activeCategory()?.products || []);

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
    this.request = this.profile.loadRecommendations().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (response) => {
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
        this.activeCategoryId.set(categories[0]?.category_id || null);
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
