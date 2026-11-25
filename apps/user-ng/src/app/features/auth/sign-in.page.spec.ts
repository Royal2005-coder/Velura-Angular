import { TestBed } from '@angular/core/testing';
import { Router, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { createStorefrontPage, lastStorefrontFixture } from '../../../testing/storefront-testing';
import { SignInPage } from './sign-in.page';

describe('SignInPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(SignInPage);
    expect(page).toBeTruthy();
  });

  it('keeps method and error on signals; invalid submit does not call HTTP', async () => {
    const page = await createStorefrontPage(SignInPage);
    expect(page.method()).toBe('phone');
    page.setMethod('email');
    expect(page.method()).toBe('email');
    expect(page.errorMessage()).toBeNull();
  });

  it('navigates back to sanitized returnUrl after password or OTP login and clears stale OAuth returnUrl', async () => {
    localStorage.setItem('velura-user-oauth-return-url', JSON.stringify({ url: '/products/old', expiresAt: Date.now() + 60000 }));
    const routes = [{ path: 'products/:id', component: class {} }, { path: 'auth/signup', component: class {} }];
    const returnUrl = '/products/ao-so-mi?variant=v2&vto=1';
    const page = await createStorefrontPage(
      SignInPage,
      { post: () => of({ token: 'jwt-1', user: { user_id: 'u1' } }) },
      { routes, queryParamMap: of(convertToParamMap({ returnUrl })), queryParams: { returnUrl } },
    );
    const router = TestBed.inject(Router);
    const navSpy = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

    page.form.patchValue({ phone: '0901234567', password: 'Password1' });
    page.submit();
    expect(navSpy).toHaveBeenCalledWith(returnUrl);
    expect(localStorage.getItem('velura-user-oauth-return-url')).toBeNull();

    const signupLink = lastStorefrontFixture().nativeElement.querySelector('a[href*="/auth/signup"]') as HTMLAnchorElement | null;
    expect(signupLink?.getAttribute('href')).toContain(encodeURIComponent(returnUrl));
  });

  it('ignores unsafe returnUrl and falls back to homepage', async () => {
    const routes = [{ path: 'auth/signup', component: class {} }];
    const page = await createStorefrontPage(
      SignInPage,
      { post: () => of({ otp_required: true }) },
      { routes, queryParams: { returnUrl: 'https://evil.test/phish' } },
    );
    const navSpy = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    page.onOtpVerified({ token: 'jwt-2', user: { user_id: 'u1' }, otpCode: '123456' });
    expect(page.safeReturnUrl()).toBeNull();
    expect(navSpy).toHaveBeenCalledWith('/');
  });
});
