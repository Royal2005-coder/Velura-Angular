import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AdminApiService } from './admin-api.service';
import { adminAuthGuard, adminHomeRedirectGuard, adminShellGuard } from './admin-auth.guard';
import { AdminHomeRedirectPage } from './admin-home-redirect';
import { AdminSessionService } from './admin-session.service';

@Component({
  selector: 'app-guard-dummy',
  template: 'ok',
})
class GuardDummyPage {}

const productMe = {
  role: 'admin_operator_sanpham',
  roleName: 'Admin sản phẩm',
  isAdmin: true,
  allowedPages: ['products'],
  user: { id: 'p1', email: 'product@velura.vn' },
  profile: { user_id: 'p1', email: 'product@velura.vn', full_name: 'SP', is_active: true },
};

describe('admin operator shell routing', () => {
  async function boot(): Promise<Router> {
    TestBed.resetTestingModule();
    sessionStorage.clear();
    localStorage.clear();
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'login', component: GuardDummyPage },
          { path: 'welcome', component: GuardDummyPage },
          {
            path: '',
            canActivate: [adminShellGuard],
            children: [
              { path: '', pathMatch: 'full', canActivate: [adminHomeRedirectGuard], component: AdminHomeRedirectPage },
              { path: 'forbidden', component: GuardDummyPage },
              { path: 'products', canActivate: [adminAuthGuard], data: { page: 'products' }, component: GuardDummyPage },
              { path: 'dashboard', canActivate: [adminAuthGuard], data: { page: 'dashboard' }, component: GuardDummyPage },
              { path: 'accounts', canActivate: [adminAuthGuard], data: { page: 'accounts' }, component: GuardDummyPage },
            ],
          },
        ]),
        { provide: AdminApiService, useValue: { me: () => of(productMe) } },
      ],
    }).compileComponents();
    TestBed.inject(AdminSessionService).setToken('operator-token');
    return TestBed.inject(Router);
  }

  it('lets a product operator open /products without dashboard page rights', async () => {
    const router = await boot();
    await router.navigateByUrl('/products');
    expect(router.url).toBe('/products');
  });

  it('sends a product operator from /dashboard to /products', async () => {
    const router = await boot();
    await router.navigateByUrl('/dashboard');
    expect(router.url).toBe('/products');
  });

  it('lands / on the operator module instead of HQ dashboard', async () => {
    const router = await boot();
    await router.navigateByUrl('/');
    expect(router.url).toBe('/products');
  });

  it('forbids a product operator from /accounts', async () => {
    const router = await boot();
    await router.navigateByUrl('/accounts');
    expect(router.url).toContain('/forbidden');
  });
});
