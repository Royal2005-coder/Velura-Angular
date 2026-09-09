import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { catchError, of, switchMap } from 'rxjs';
import { ProductSummary } from '../../core/models/product.interface';
import { AuthService } from '../../core/services/auth.service';
import { ApiService } from '../../core/services/api.service';
import { CartStore } from '../../core/services/cart.store';
import { formatVnd, toPublicAsset } from '../../core/utils/money';
import { showToast } from '../../core/utils/toast';
import { useBodyClass } from '../../core/utils/body-class';
import { ProductCard } from '../../shared/product-card/product-card';

interface StyleQuizRecord {
  body_shape?: string;
  style_tags?: string[] | string;
}

interface OutfitCombo {
  name: string;
  reason?: string;
  description?: string;
  sale_price?: number;
  base_price?: number;
  images?: string[];
  products: ProductSummary[];
}

interface RecommendationCategory {
  category_id: string;
  category_name: string;
  products: ProductSummary[];
}

interface StyleProfileRecommendations {
  quiz?: StyleQuizRecord | null;
  combos?: OutfitCombo[];
  categories?: RecommendationCategory[];
}

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
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly cart = inject(CartStore);
  private readonly comboTrack = viewChild<ElementRef<HTMLElement>>('comboTrack');
  private readonly profileTrack = viewChild<ElementRef<HTMLElement>>('profileTrack');

  readonly loading = signal(true);
  readonly hasQuiz = signal(false);
  readonly styleLabel = signal('Tối giản');
  readonly bodyShapeLabel = signal('Cân đối');
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
    this.loadRecommendations();
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

  private loadRecommendations(): void {
    this.loading.set(true);
    this.api
      .get<StyleProfileRecommendations>('/api/user/recommendations/style-profile')
      .pipe(
        catchError(() => of<StyleProfileRecommendations>({ quiz: null, combos: [], categories: [] })),
        switchMap((response) => {
          const quiz = this.normalizeQuiz(response.quiz);
          if (quiz && (quiz.body_shape || quiz.style_tags)) {
            return of({ ...response, quiz });
          }
          const localQuiz = this.readGuestQuiz();
          if (!localQuiz || this.auth.isLoggedIn()) {
            return of({ ...response, quiz: null });
          }
          return this.api.post<unknown>('/api/user/style-quiz', localQuiz).pipe(
            switchMap(() =>
              this.api.get<StyleProfileRecommendations>('/api/user/recommendations/style-profile').pipe(
                catchError(() => of<StyleProfileRecommendations>({ quiz: localQuiz, combos: [], categories: [] })),
              ),
            ),
            catchError(() => of<StyleProfileRecommendations>({ quiz: null, combos: [], categories: [] })),
          );
        }),
      )
      .subscribe((response) => {
        const quiz = this.normalizeQuiz(response.quiz);
        const hasQuiz = Boolean(quiz && (quiz.body_shape || quiz.style_tags));
        this.hasQuiz.set(hasQuiz);
        if (hasQuiz && quiz) {
          const tags = Array.isArray(quiz.style_tags) ? quiz.style_tags : [];
          this.styleLabel.set(STYLE_TAG_MAP[tags[0] || ''] || tags[0] || 'Tối giản');
          this.bodyShapeLabel.set(BODY_SHAPE_MAP[quiz.body_shape || ''] || quiz.body_shape || 'Cân đối');
        }
        this.combos.set(response.combos || []);
        const categories = response.categories || [];
        this.categories.set(categories);
        this.activeCategoryId.set(categories[0]?.category_id || null);
        this.loading.set(false);
      });
  }

  private normalizeQuiz(quiz: StyleQuizRecord | null | undefined): StyleQuizRecord | null {
    if (!quiz) {
      return null;
    }
    const tags = quiz.style_tags;
    if (typeof tags === 'string') {
      quiz.style_tags = this.parsePgArray(tags);
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

  private readGuestQuiz(): Record<string, unknown> | null {
    try {
      const raw = localStorage.getItem('velura_guest_quiz_data');
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}
