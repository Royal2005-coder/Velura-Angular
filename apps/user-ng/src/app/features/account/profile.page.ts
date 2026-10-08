import { afterNextRender, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
import { OffersService } from '../../core/services/offers.service';
import type { OfferVoucher } from '../../core/models/offer.interface';
import { AuthService } from '../../core/services/auth.service';
import { ApiService } from '../../core/services/api.service';
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

@Component({
  selector: 'app-account-profile-page',
  imports: [RouterLink, AddressSelector, PersonalColorComponent, LoyaltyWalletComponent],
  host: { class: 'page-profile', style: 'display:block' },
  templateUrl: './profile.page.html',
})
export class AccountProfilePage {
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly tab = signal('profile');
  readonly displayName = signal(this.auth.session()?.fullName || 'Tên khách hàng');
  readonly addressModalOpen = signal(false);
  readonly addressGeography = signal<AddressGeographySelection>({ province: '', district: '', ward: '', mode: 'current', valid: false });
  /** Saved address fields render as Angular text bindings, never interpreted HTML. */
  readonly savedAddresses = signal<NonNullable<MemberProfile['saved_addresses']>>([]);
  private readonly offers = inject(OffersService);

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
