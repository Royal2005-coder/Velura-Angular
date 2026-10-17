import { createStorefrontPage } from '../../../testing/storefront-testing';
import { of } from 'rxjs';
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
});
