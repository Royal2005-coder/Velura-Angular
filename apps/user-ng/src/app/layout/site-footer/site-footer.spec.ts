import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { createStorefrontPage } from '../../../testing/storefront-testing';
import { ApiService } from '../../core/services/api.service';
import { SiteFooter } from './site-footer';

describe('SiteFooter', () => {
  it('toggles payment method tooltip on mobile/tablet interaction', async () => {
    const footer = await createStorefrontPage(SiteFooter);
    expect(footer.activeTooltip()).toBeNull();

    footer.toggleTooltip('visa');
    expect(footer.activeTooltip()).toBe('visa');

    footer.toggleTooltip('visa');
    expect(footer.activeTooltip()).toBeNull();
  });

  it('updates email signal on user input and clears error message', async () => {
    const footer = await createStorefrontPage(SiteFooter);
    footer.errorMessage.set('Vui lòng nhập địa chỉ email hợp lệ.');

    const input = document.createElement('input');
    input.value = 'thao@example.com';
    footer.onEmailInput({ target: input } as unknown as Event);

    expect(footer.email()).toBe('thao@example.com');
    expect(footer.errorMessage()).toBeNull();
  });

  it('rejects invalid email formats without submitting to the API', async () => {
    const footer = await createStorefrontPage(SiteFooter);
    const api = TestBed.inject(ApiService);
    const postSpy = vi.spyOn(api, 'post');

    footer.email.set('invalid-email');
    const event = { preventDefault: vi.fn() } as unknown as Event;
    footer.submitNewsletter(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(footer.errorMessage()).toBe('Vui lòng nhập địa chỉ email hợp lệ.');
    expect(footer.statusMessage()).toBeNull();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('submits valid email, displays success modal with registered email, and clears input', async () => {
    const footer = await createStorefrontPage(SiteFooter);
    const api = TestBed.inject(ApiService);
    const postSpy = vi.spyOn(api, 'post').mockReturnValue(
      of({
        success: true,
        message: 'Đã ghi nhận! Vui lòng kiểm tra email của bạn để nhận mã giảm giá 10%.'
      })
    );

    footer.email.set('phuong.thao@gmail.com');
    const event = { preventDefault: vi.fn() } as unknown as Event;
    footer.submitNewsletter(event);

    expect(postSpy).toHaveBeenCalledWith('/api/user/newsletter/subscribe', {
      email: 'phuong.thao@gmail.com',
      source: 'storefront_footer',
      hp_website: ''
    });
    expect(footer.submitting()).toBe(false);
    expect(footer.successModalOpen()).toBe(true);
    expect(footer.registeredEmail()).toBe('phuong.thao@gmail.com');
    expect(footer.isGmail()).toBe(true);
    expect(footer.statusMessage()).toContain('Đã ghi nhận');
    expect(footer.email()).toBe('');

    footer.closeSuccessModal();
    expect(footer.successModalOpen()).toBe(false);
  });

  it('displays error message when the API request fails', async () => {
    const footer = await createStorefrontPage(SiteFooter);
    const api = TestBed.inject(ApiService);
    vi.spyOn(api, 'post').mockReturnValue(
      throwError(() => ({ message: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau giây lát.' }))
    );

    footer.email.set('test@example.com');
    const event = { preventDefault: vi.fn() } as unknown as Event;
    footer.submitNewsletter(event);

    expect(footer.submitting()).toBe(false);
    expect(footer.errorMessage()).toBe('Bạn thao tác quá nhanh. Vui lòng thử lại sau giây lát.');
    expect(footer.statusMessage()).toBeNull();
  });
});
