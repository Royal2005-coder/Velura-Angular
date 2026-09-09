import { afterNextRender, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
import { HOT_BANNERS } from '../../core/models/hot-banner';
import { AuthService } from '../../core/services/auth.service';
import { ApiService } from '../../core/services/api.service';
import { useBodyClass } from '../../core/utils/body-class';
import { showToast } from '../../core/utils/toast';

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
  imports: [RouterLink],
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
  private savedAddresses: NonNullable<MemberProfile['saved_addresses']> = [];

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
    this.renderOffers();
    this.syncTab();
  }

  private bindStaticActions(): void {
    const form = document.querySelector('.profile-form');
    form?.addEventListener('submit', (event) => this.saveProfile(event));
    document.querySelector('.js-btn-save-settings')?.addEventListener('click', () => {
      showToast('Đã lưu các cài đặt thành công!');
    });
    document.querySelector('.js-btn-add-address')?.addEventListener('click', () => this.openAddressModal());
  }

  /**
   * Opens the original add-address modal.
   */
  openAddressModal(): void {
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
    const province = (document.getElementById('address-province') as HTMLInputElement | null)?.value.trim() || '';
    const district = (document.getElementById('address-district') as HTMLInputElement | null)?.value.trim() || '';
    const ward = (document.getElementById('address-ward') as HTMLInputElement | null)?.value.trim() || '';
    const street = (document.getElementById('address-detail') as HTMLInputElement | null)?.value.trim() || '';
    const isDefault = Boolean((document.getElementById('address-is-default') as HTMLInputElement | null)?.checked);
    if (!name || !phone || !street) {
      showToast('Vui lòng nhập họ tên, số điện thoại và địa chỉ chi tiết.');
      return;
    }
    const detail = [street, ward, district, province].filter(Boolean).join(', ');
    const next = this.savedAddresses.map((addr) => ({ ...addr, is_default: isDefault ? false : addr.is_default }));
    next.push({
      id: crypto.randomUUID(),
      name,
      phone,
      detail,
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
    this.savedAddresses = addresses;
    const list = document.querySelector('.address-list');
    if (!list) {
      return;
    }
    if (!addresses.length) {
      list.innerHTML = '<p style="color:var(--soft);font-size:0.875rem;padding:16px 0;">Bạn chưa lưu địa chỉ nào.</p>';
      return;
    }
    list.innerHTML = addresses
      .map(
        (addr) => `
        <div class="address-card ${addr.is_default ? 'address-card--default' : ''}" data-id="${addr.id || ''}">
          <div class="address-card__content">
            <div class="address-card__header">
              <span class="address-card__name">${addr.name || ''}</span>
              <span class="address-card__separator">·</span>
              <span class="address-card__phone">${addr.phone || ''}</span>
              ${addr.is_default ? '<span class="badge badge--default">Mặc định</span>' : ''}
            </div>
            <p class="address-card__detail">${addr.detail || addr.address || ''}</p>
          </div>
        </div>`,
      )
      .join('');
  }

  private renderOffers(): void {
    const list = document.querySelector('.js-offers-list');
    if (!list) {
      return;
    }
    list.innerHTML = HOT_BANNERS.map(
      (banner) => `
      <article class="offer-card">
        <img src="${banner.imageSrc}" alt="${banner.imageAlt}" />
        <div>
          <small>${banner.eyebrow}</small>
          <h3>${banner.title}</h3>
          <p>${banner.benefit}</p>
          <p>${banner.condition}</p>
        </div>
      </article>`,
    ).join('');
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
