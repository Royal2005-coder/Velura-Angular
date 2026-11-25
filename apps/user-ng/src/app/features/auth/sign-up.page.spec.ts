import { TestBed } from '@angular/core/testing';
import { Router, convertToParamMap } from '@angular/router';
import { of, throwError } from 'rxjs';
import { StyleProfileService } from '../../core/services/style-profile.service';
import { createStorefrontPage, lastStorefrontFixture } from '../../../testing/storefront-testing';
import { SignUpPage } from './sign-up.page';

describe('SignUpPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(SignUpPage);
    expect(page).toBeTruthy();
  });

  it('checks email and phone as one pair and marks each duplicate field', async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const page = await createStorefrontPage(SignUpPage, {
      post: (path: string, body: unknown) => {
        requests.push({ path, body });
        return of({ emailExists: true, phoneExists: true, pairExists: true });
      },
    });

    page.form.controls.email.setValue('member@velura.test');
    page.form.controls.phone.setValue('0912345678');
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(requests).toEqual([{
      path: '/api/user/auth/signup-availability',
      body: { email: 'member@velura.test', phone: '0912345678' },
    }]);
    expect(page.duplicateEmail()).toBe(true);
    expect(page.duplicatePhone()).toBe(true);
  });

  it('allows signup validation with a required phone and no email', async () => {
    const page = await createStorefrontPage(SignUpPage, {
      post: () => of({ emailExists: false, phoneExists: false, pairExists: false }),
    });

    page.form.patchValue({
      fullname: 'Nguyễn Văn A',
      phone: '0855808336',
      email: '',
      password: 'Password1',
      password_confirm: 'Password1',
    });
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(page.form.controls.email.valid).toBe(true);
    expect(page.form.valid).toBe(true);
  });

  it('opens OTP reliably for phone-only signup and exposes the development code', async () => {
    const page = await createStorefrontPage(SignUpPage, {
      post: (path: string) => path === '/api/user/auth/signup-availability'
        ? of({ emailExists: false, phoneExists: false, pairExists: false })
        : of({ otp_required: true, development_otp: '123456' }),
    });

    page.form.patchValue({
      fullname: 'Nguyễn Văn A',
      phone: '0855808333',
      email: '',
      password: 'Password1',
      password_confirm: 'Password1',
    });
    await new Promise((resolve) => setTimeout(resolve, 500));

    page.submit();

    expect(page.errorMessage()).toBeNull();
    expect(page.otpIdentity()).toBe('0855808333');
    expect(page.otpDevelopmentCode()).toBe('123456');
    expect(page.otpOpen()).toBe(true);
  });

  it('redirects back to sanitized returnUrl after signup and keeps priority over /ai/style-quiz if claimGuestDraft fails', async () => {
    const routes = [{ path: 'products/:id', component: class {} }, { path: 'auth/signin', component: class {} }];
    const returnUrl = '/products/ao-so-mi?variant=v1&vto=1';
    const page = await createStorefrontPage(
      SignUpPage,
      { post: () => of({ token: 'jwt-new', user: { user_id: 'u2' } }) },
      { routes, queryParamMap: of(convertToParamMap({ returnUrl })), queryParams: { returnUrl } },
    );
    const navSpy = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const styleProfile = TestBed.inject(StyleProfileService);
    vi.spyOn(styleProfile, 'claimGuestDraft').mockReturnValueOnce(throwError(() => new Error('network')));

    page.onOtpVerified({ token: 'jwt-new', user: { user_id: 'u2' }, otpCode: '123456' });
    expect(navSpy).toHaveBeenCalledWith(returnUrl);

    const signinLink = lastStorefrontFixture().nativeElement.querySelector('a[href*="/auth/signin"]') as HTMLAnchorElement | null;
    expect(signinLink?.getAttribute('href')).toContain(encodeURIComponent(returnUrl));
  });
});
