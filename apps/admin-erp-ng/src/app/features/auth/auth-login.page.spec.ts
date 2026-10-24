import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AdminErpApiService } from '../../core/admin-erp-api.service';
import { AdminAuthMe } from '../../core/admin-erp-session.service';
import { AuthLoginPage, formatCountdown } from './auth-login.page';

const adminMe: AdminAuthMe = {
  role: 'super_admin',
  roleName: 'Admin quản trị',
  isAdmin: true,
  allowedPages: ['dashboard', 'products'],
  allowedModules: ['*'],
  capabilities: { '*': ['read', 'update', 'create', 'delete', 'approve'] },
  user: { id: 'root', email: 'root@velura.test' },
  profile: { user_id: 'root', email: 'root@velura.test', full_name: 'Root Admin', is_active: true },
};

describe('AuthLoginPage', () => {
  async function boot() {
    sessionStorage.clear();
    localStorage.clear();
    TestBed.resetTestingModule();
    const api = {
      signIn: () => of({ token: 'erp-token' }),
      me: () => of(adminMe),
      requestPasswordReset: () => of({}),
    };
    await TestBed.configureTestingModule({
      imports: [AuthLoginPage],
      providers: [provideRouter([]), { provide: AdminErpApiService, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(AuthLoginPage);
    fixture.detectChanges();
    return fixture;
  }

  it('rejects an empty form before calling the API', async () => {
    const fixture = await boot();
    const page = fixture.componentInstance;

    page.submit();

    expect(page.errorMessage()).toContain('email và mật khẩu');
    expect(page.submitting()).toBe(false);
  });

  it('stores the ERP token and lands on the first allowed workspace', async () => {
    const fixture = await boot();
    const page = fixture.componentInstance;
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

    page.form.setValue({ email: 'root@velura.test', password: 'secret' });
    page.submit();

    expect(sessionStorage.getItem('velura_admin_erp_access_token')).toBe('erp-token');
    expect(navigate).toHaveBeenCalledWith('/dashboard', { replaceUrl: true });
  });

  it('formats lockout countdown as mm:ss', () => {
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(65_000)).toBe('01:05');
  });
});
