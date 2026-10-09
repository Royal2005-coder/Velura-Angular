import { DecimalPipe } from '@angular/common';
import { afterNextRender, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
import { OffersService } from '../../core/services/offers.service';
import type { OfferVoucher } from '../../core/models/offer.interface';
import { AuthService } from '../../core/services/auth.service';
import { ApiService } from '../../core/services/api.service';
import { CatalogService } from '../../core/services/catalog.service';
import { CartStore } from '../../core/services/cart.store';
import type { ProductSummary } from '../../core/models/product.interface';
import { useBodyClass } from '../../core/utils/body-class';
import { showToast } from '../../core/utils/toast';
import { AddressSelector } from '../../shared/address-selector/address-selector';
import type { AddressGeographySelection } from '../../core/models/address-geography';
import { PersonalColorComponent } from '../ai/personal-color.component';
import { LoyaltyWalletComponent } from './loyalty-wallet.component';
interface MemberProfile {
  full_name?: string;
  email?: string;
  phone?: string;
  date_of_birth?: string;
  gender?: string;
  saved_addresses?: Array<{
    id?: string;
    name?: string;
    phone?: string;
    detail?: string;
    province?: string;
    district?: string;
    ward?: string;
    address?: string;
    is_default?: boolean;
  }>;
}

interface StyleQuiz {
  body_shape?: string;
  style_tags?: string[] | string;
  height_cm?: number;
  weight_kg?: number;
  chest_cm?: number;
  waist_cm?: number;
  hip_cm?: number;
  skin_tone?: string;
  budget_range?: string;
  age_group?: string;
}
interface MemberOrderItem {
  product_name?: string;
  product_image?: string;
  slug?: string;
  product_id?: string;
  variant_id?: string;
  price?: number;
  unit_price?: number;
  quantity?: number;
  color?: string;
  size?: string;
  category_name?: string;
  is_combo?: boolean;
}

interface MemberOrder {
  order_id: string;
  order_code?: string;
  status?: string;
  status_label?: string;
  created_at?: string;
  total_amount?: number;
  item_count?: number;
  items?: MemberOrderItem[];
}

@Component({
  selector: 'app-account-profile-page',
  imports: [RouterLink, DecimalPipe, AddressSelector, PersonalColorComponent, LoyaltyWalletComponent],
  host: { class: 'page-profile', style: 'display:block' },
  templateUrl: './profile.page.html',
})
export class AccountProfilePage {
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly cart = inject(CartStore);
  private readonly catalog = inject(CatalogService);
  private readonly offers = inject(OffersService);
  readonly tab = signal('profile');
  readonly displayName = signal(this.auth.session()?.fullName || 'Tên khách hàng');
  readonly addressModalOpen = signal(false);
  readonly addressGeography = signal<AddressGeographySelection>({ province: '', district: '', ward: '', mode: 'current', valid: false });
  readonly savedAddresses = signal<NonNullable<MemberProfile['saved_addresses']>>([]);

  // Analytics & Orders
  readonly orders = signal<MemberOrder[]>([]);
  readonly allProducts = signal<ProductSummary[]>([]);
  readonly analyticsLoading = signal(true);
  /**
   * Ưu đãi của tôi. Trước đây là sáu banner viết cứng ghi bằng `innerHTML`, không liên
   * quan gì tới mã khách thật sự dùng được. Giờ là ví mã của chính tài khoản này.
   */
  readonly myVouchers = signal<OfferVoucher[]>([]);
  readonly offersLoading = signal(true);
  readonly offerFilter = signal<'ALL' | 'AVAILABLE' | 'LOCKED'>('ALL');
  readonly filteredVouchers = computed(() => {
    const filter = this.offerFilter();
    return this.myVouchers().filter((voucher) =>
      filter === 'ALL' ? true : filter === 'AVAILABLE' ? voucher.usable : !voucher.usable,
    );
  });

  constructor() {
    useBodyClass('page-profile');
    const requested = this.route.snapshot.queryParamMap.get('tab');
    if (requested) {
      this.tab.set(requested);
    }
    afterNextRender(() => {
      this.syncTab();
      this.bindStaticActions();
    });
    this.api
      .get<MemberProfile>('/api/user/profile')
      .pipe(catchError(() => of(null)))
      .subscribe((profile) => this.bindProfile(profile));
    this.api
      .get<{ success?: boolean; quiz?: StyleQuiz }>('/api/user/style-quiz')
      .pipe(catchError(() => of({ quiz: undefined })))
      .subscribe((res) => this.bindStyleProfile(res.quiz));
    this.api
      .get<{ orders?: MemberOrder[] }>('/api/user/orders')
      .pipe(catchError(() => of({ orders: [] as MemberOrder[] })))
      .subscribe((data) => {
        this.orders.set(data.orders || []);
        this.analyticsLoading.set(false);
      });
    this.catalog
      .getProducts()
      .pipe(catchError(() => of([] as ProductSummary[])))
      .subscribe((prods) => {
        this.allProducts.set(prods || []);
      });
  }

  // Analytics Computeds
  readonly completedOrders = computed(() =>
    this.orders().filter((o) =>
      ['delivered', 'confirmed', 'shipping', 'processing', 'completed'].includes(o.status || '')
    )
  );

  readonly totalSpent = computed(() =>
    this.completedOrders().reduce((sum, o) => sum + Number(o.total_amount || 0), 0)
  );

  readonly averageOrderValue = computed(() => {
    const count = this.completedOrders().length;
    return count ? Math.round(this.totalSpent() / count) : 0;
  });

  readonly totalItemsPurchased = computed(() =>
    this.completedOrders().reduce(
      (sum, o) => sum + (o.items?.reduce((s, it) => s + (it.quantity || 1), 0) || o.item_count || 1),
      0
    )
  );

  readonly totalSaved = computed(() => Math.round(this.totalSpent() * 0.12));

  readonly membershipTier = computed(() => {
    const spent = this.totalSpent();
    if (spent >= 7000000) {
      return {
        name: 'Kim Cương (Diamond VIP)',
        badge: 'DIAMOND',
        rate: 'Tích 5% điểm thưởng',
        privilege: 'Freeship 2h · Stylist 1-1 riêng biệt · Quà sinh nhật 200.000đ',
        progress: 100,
        nextTier: null,
        remaining: 0,
      };
    }
    if (spent >= 3000000) {
      const progress = Math.min(100, Math.round(((spent - 3000000) / 4000000) * 100));
      return {
        name: 'Hạng Vàng (Gold)',
        badge: 'GOLD',
        rate: 'Tích 3% điểm thưởng',
        privilege: 'Freeship mọi đơn hàng · Quà sinh nhật 100.000đ',
        progress,
        nextTier: 'Kim Cương (VIP)',
        remaining: 7000000 - spent,
      };
    }
    if (spent >= 1000000) {
      const progress = Math.min(100, Math.round(((spent - 1000000) / 2000000) * 100));
      return {
        name: 'Hạng Bạc (Silver)',
        badge: 'SILVER',
        rate: 'Tích 2% điểm thưởng',
        privilege: 'Freeship đơn từ 300.000đ · Quà sinh nhật 50.000đ',
        progress,
        nextTier: 'Hạng Vàng (Gold)',
        remaining: 3000000 - spent,
      };
    }
    const progress = Math.min(100, Math.round((spent / 1000000) * 100));
    return {
      name: 'Thành viên Mới',
      badge: 'MEMBER',
      rate: 'Tích 1% điểm thưởng',
      privilege: 'Voucher chào mừng 10% · Đổi trả miễn phí 30 ngày',
      progress,
      nextTier: 'Hạng Bạc (Silver)',
      remaining: 1000000 - spent,
    };
  });

  readonly categorySpending = computed(() => {
    const orders = this.completedOrders();
    const map = new Map<string, { name: string; amount: number; count: number }>();
    for (const o of orders) {
      for (const it of o.items || []) {
        const cat = it.category_name || (it.is_combo ? 'Set đồ & Combo' : 'Thời trang nữ');
        const current = map.get(cat) || { name: cat, amount: 0, count: 0 };
        const price = Number(it.unit_price ?? it.price ?? 0);
        current.amount += price * (it.quantity || 1);
        current.count += (it.quantity || 1);
        map.set(cat, current);
      }
    }
    const total = Array.from(map.values()).reduce((sum, c) => sum + c.amount, 0) || 1;
    return Array.from(map.values())
      .map((c) => ({ ...c, percent: Math.max(1, Math.round((c.amount / total) * 100)) }))
      .sort((a, b) => b.amount - a.amount);
  });

  readonly purchasedProducts = computed(() => {
    const orders = this.completedOrders();
    const map = new Map<string, { product_id: string; name: string; image: string; price: number; slug?: string; order_date?: string; is_combo?: boolean }>();
    for (const o of orders) {
      for (const it of o.items || []) {
        const key = it.product_name || it.product_id || '';
        if (key && !map.has(key)) {
          const price = Number(it.unit_price ?? it.price ?? 0);
          map.set(key, {
            product_id: it.product_id || '',
            name: it.product_name || '',
            image: it.product_image || '',
            price,
            slug: it.slug || '',
            order_date: o.created_at,
            is_combo: it.is_combo,
          });
        }
      }
    }
    return Array.from(map.values()).filter((p) => p.name && !p.name.toLowerCase().includes('uat'));
  });

  readonly validCatalogProducts = computed(() =>
    this.allProducts().filter((p) => {
      const name = (p.name || '').toLowerCase();
      return (
        !name.includes('test') &&
        !name.includes('validation') &&
        !name.includes('commit') &&
        !name.includes('gà rán') &&
        !name.includes('ga ran') &&
        !name.includes('prd02') &&
        !name.includes('demo')
      );
    })
  );

  readonly deepDiscountProducts = computed(() =>
    this.validCatalogProducts()
      .filter((p) => p.sale_price && p.base_price && p.base_price > p.sale_price)
      .map((p) => ({
        ...p,
        discountPercent: Math.round(((p.base_price! - p.sale_price!) / p.base_price!) * 100),
      }))
      .sort((a, b) => b.discountPercent - a.discountPercent)
      .slice(0, 4)
  );

  readonly newArrivalProducts = computed(() =>
    [...this.validCatalogProducts()]
      .sort((a, b) => new Date(b.created_at || '').getTime() - new Date(a.created_at || '').getTime())
      .slice(0, 4)
  );
  readonly recommendedVouchers = computed(() => this.myVouchers().slice(0, 3));

  reorderProduct(item: { name: string; image: string; price: number; product_id?: string; is_combo?: boolean }): void {
    this.cart.addItem({
      variant_id: item.product_id || `reorder-${Date.now()}`,
      product_id: item.product_id || '',
      product_name: item.name,
      product_image: item.image,
      quantity: 1,
      unit_price: item.price,
      is_combo: item.is_combo,
    });
    showToast(`Đã thêm ${item.name} vào giỏ hàng!`);
  }

  copyVoucher(code: string): void {
    void navigator.clipboard?.writeText(code);
    showToast(`Đã sao chép mã ưu đãi ${code}!`);
  }

  /**
   * Switches original account sidebar tabs.
   */
  onNavClick(event: Event): void {
    const link = (event.target as HTMLElement).closest<HTMLElement>('[data-tab]');
    const tab = link?.getAttribute('data-tab');
    if (!tab) {
      return;
    }
    event.preventDefault();
    if (tab === 'orders') {
      void this.router.navigateByUrl('/account/orders');
      return;
    }
    if (tab === 'wishlist') {
      void this.router.navigateByUrl('/wishlist');
      return;
    }
    this.tab.set(tab);
    this.syncTab();
  }

  /**
   * Saves the original profile form through PATCH /api/user/profile.
   */
  saveProfile(event: Event): void {
    event.preventDefault();
    const name = (document.getElementById('profile-name') as HTMLInputElement | null)?.value.trim() || '';
    const phone = (document.getElementById('profile-phone') as HTMLInputElement | null)?.value.trim() || '';
    const email = (document.getElementById('profile-email') as HTMLInputElement | null)?.value.trim() || '';
    const dob = (document.getElementById('profile-dob') as HTMLInputElement | null)?.value.trim() || '';
    const gender = (document.querySelector('input[name="gender"]:checked') as HTMLInputElement | null)?.value;
    this.api.patch<unknown>('/api/user/profile', { full_name: name, phone, email, date_of_birth: dob, gender }).subscribe({
      next: () => {
        this.displayName.set(name || this.displayName());
        this.syncTab();
        showToast('Đã cập nhật hồ sơ thành công.');
      },
      error: (error: Error) => showToast(error.message || 'Không cập nhật được hồ sơ.'),
    });
  }

  private syncTab(): void {
    const current = this.tab();
    document.querySelectorAll<HTMLElement>('.account-sidebar__link').forEach((node) => {
      node.classList.toggle('is-active', node.getAttribute('data-tab') === current);
    });
    document.querySelectorAll<HTMLElement>('.account-tab-content').forEach((panel) => {
      panel.classList.toggle('is-active', panel.id === `tab-${current}`);
    });
    document.querySelectorAll('.account-sidebar__name, .profile-avatar-name').forEach((node) => {
      node.textContent = this.displayName();
    });
  }

  private bindProfile(profile: MemberProfile | null): void {
    if (profile?.full_name) {
      this.displayName.set(profile.full_name);
    }
    const name = document.getElementById('profile-name') as HTMLInputElement | null;
    const email = document.getElementById('profile-email') as HTMLInputElement | null;
    const phone = document.getElementById('profile-phone') as HTMLInputElement | null;
    const dob = document.getElementById('profile-dob') as HTMLInputElement | null;
    if (name && profile?.full_name) {
      name.value = profile.full_name;
    }
    if (email && profile?.email) {
      email.value = profile.email;
    }
    if (phone && profile?.phone) {
      phone.value = profile.phone;
    }
    if (dob && profile?.date_of_birth) {
      dob.value = String(profile.date_of_birth).slice(0, 10);
    }
    if (profile?.gender) {
      const radio = document.querySelector<HTMLInputElement>(`input[name="gender"][value="${profile.gender}"]`);
      if (radio) {
        radio.checked = true;
      }
    }
    this.renderAddresses(profile?.saved_addresses || []);
    this.loadOffers();
    this.syncTab();
  }

  private bindStaticActions(): void {
    const form = document.querySelector('.profile-form');
    form?.addEventListener('submit', (event) => this.saveProfile(event));
    document.querySelector('.js-btn-save-settings')?.addEventListener('click', () => {
      showToast('Đã lưu các cài đặt thành công!');
    });
  }

  /**
   * Opens the original add-address modal.
   */
  openAddressModal(): void {
    document.querySelector<HTMLFormElement>('#address-modal form')?.reset();
    this.addressGeography.set({ province: '', district: '', ward: '', mode: 'current', valid: false });
    this.addressModalOpen.set(true);
  }

  /**
   * Closes the original add-address modal.
   */
  closeAddressModal(): void {
    this.addressModalOpen.set(false);
  }

  /**
   * Saves a new address through PATCH /api/user/addresses.
   */
  saveAddress(event: Event): void {
    event.preventDefault();
    const name = (document.getElementById('address-fullname') as HTMLInputElement | null)?.value.trim() || '';
    const phone = (document.getElementById('address-phone') as HTMLInputElement | null)?.value.trim() || '';
    const { province, district, ward, valid } = this.addressGeography();
    const street = (document.getElementById('address-detail') as HTMLInputElement | null)?.value.trim() || '';
    const isDefault = Boolean((document.getElementById('address-is-default') as HTMLInputElement | null)?.checked);
    if (name.length < 2 || !/^0\d{9}$/.test(phone) || !street || !valid) {
      showToast('Vui lòng nhập họ tên, số điện thoại và địa chỉ chi tiết.');
      return;
    }
    const detail = [street, ward, district, province].filter(Boolean).join(', ');
    const next = this.savedAddresses().map((addr) => ({ ...addr, is_default: isDefault ? false : addr.is_default }));
    next.push({
      id: crypto.randomUUID(),
      name,
      phone,
      province,
      district,
      ward,
      detail: street,
      address: detail,
      is_default: isDefault || next.length === 0,
    });
    this.api.patch<{ success?: boolean }>('/api/user/addresses', { addresses: next }).subscribe({
      next: () => {
        this.renderAddresses(next);
        this.closeAddressModal();
        showToast('Đã lưu địa chỉ giao hàng.');
      },
      error: (error: Error) => showToast(error.message || 'Không lưu được địa chỉ. Hãy đăng nhập rồi thử lại.'),
    });
  }

  private renderAddresses(addresses: NonNullable<MemberProfile['saved_addresses']>): void {
    this.savedAddresses.set(addresses);
  }

  setOfferFilter(filter: 'ALL' | 'AVAILABLE' | 'LOCKED'): void {
    this.offerFilter.set(filter);
  }

  expiryLabel(value: string | null): string {
    if (!value) return 'Không giới hạn';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('vi-VN');
  }

  private loadOffers(): void {
    // Bộ nhớ đệm có thể còn từ lúc chưa đăng nhập; mã dành riêng cho thành viên chỉ hiện
    // sau khi đọc lại bằng phiên hiện tại.
    this.offers.invalidate();
    this.offersLoading.set(true);
    this.offers.load().subscribe((response) => {
      this.myVouchers.set(response.vouchers ?? []);
      this.offersLoading.set(false);
    });
  }

  private bindStyleProfile(quiz: StyleQuiz | undefined): void {
    const empty = document.getElementById('js-style-profile-empty');
    const filled = document.getElementById('js-style-profile-filled');
    if (!empty || !filled) {
      return;
    }
    const hasQuiz = Boolean(quiz && (quiz.body_shape || quiz.style_tags));
    empty.style.display = hasQuiz ? 'none' : '';
    filled.style.display = hasQuiz ? '' : 'none';
    if (!hasQuiz || !quiz) {
      return;
    }
    const tags = Array.isArray(quiz.style_tags) ? quiz.style_tags.join(', ') : String(quiz.style_tags || '');
    const setText = (id: string, value: string) => {
      const node = document.getElementById(id);
      if (node) {
        node.textContent = value;
      }
    };
    setText('js-sp-heading', tags || quiz.body_shape || 'Phong cách của bạn');
    setText('js-sp-shape', quiz.body_shape || '—');
    setText('js-sp-height', quiz.height_cm ? `${quiz.height_cm} cm` : '—');
    setText('js-sp-weight', quiz.weight_kg ? `${quiz.weight_kg} kg` : '—');
    setText('js-sp-chest', quiz.chest_cm ? `${quiz.chest_cm} cm` : '—');
    setText('js-sp-waist', quiz.waist_cm ? `${quiz.waist_cm} cm` : '—');
    setText('js-sp-hip', quiz.hip_cm ? `${quiz.hip_cm} cm` : '—');
    setText('js-sp-tone', quiz.skin_tone || '—');
    setText('js-sp-age', quiz.age_group ? `Nhóm tuổi ${quiz.age_group}` : '—');
    setText('js-sp-budget', quiz.budget_range || '—');
  }
}
