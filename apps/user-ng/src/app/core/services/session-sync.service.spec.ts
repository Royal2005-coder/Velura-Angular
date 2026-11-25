import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationRef, DestroyRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { authInterceptor } from '../interceptors/auth.interceptor';
import { AuthService } from './auth.service';
import { SessionSyncService } from './session-sync.service';

describe('SessionSyncService & live 423 lock eviction', () => {
  let httpMock: HttpTestingController;
  let auth: AuthService;
  let sync: SessionSyncService;
  let router: Router;
  let destroyRef: DestroyRef;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
    sync = TestBed.inject(SessionSyncService);
    router = TestBed.inject(Router);
    destroyRef = TestBed.inject(ApplicationRef).injector.get(DestroyRef);
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.clear();
    sessionStorage.clear();
    TestBed.resetTestingModule();
  });

  it('evicts an active member immediately when /api/auth/me returns 423 ACCOUNT_LOCKED', async () => {
    auth.applySession('member-jwt', { user_id: 'm1', role: 'member' });
    const navSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    const check = sync.syncNow(true);
    const req = httpMock.expectOne('/api/auth/me');
    expect(req.request.headers.get('Authorization')).toBe('Bearer member-jwt');
    req.flush(
      { error: { code: 'ACCOUNT_LOCKED', message: 'Tài khoản đã bị quản trị viên tạm khóa. Lý do: Spam' } },
      { status: 423, statusText: 'Locked' },
    );

    expect(await check).toBe(false);
    expect(auth.isLoggedIn()).toBe(false);
    expect(auth.consumeLockNotice()).toContain('Spam');
    expect(navSpy).toHaveBeenCalledWith(['/auth/signin'], { queryParams: { locked: '1' }, replaceUrl: true });
  });

  it('signs out without retrying as guest when /api/auth/me returns 401', async () => {
    auth.applySession('stale-jwt', { user_id: 'm1', role: 'member' });
    const navSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    const check = sync.syncNow(true);
    const req = httpMock.expectOne('/api/auth/me');
    req.flush({ error: { code: 'UNAUTHORIZED' } }, { status: 401, statusText: 'Unauthorized' });

    expect(await check).toBe(false);
    expect(auth.isLoggedIn()).toBe(false);
    expect(navSpy).toHaveBeenCalledWith(['/auth/signin'], { replaceUrl: true });
  });

  it('revalidates on browser popstate back navigation and evicts locked accounts', async () => {
    auth.applySession('member-jwt', { user_id: 'm1', role: 'member' });
    const navSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    sync.start(destroyRef);

    window.dispatchEvent(new PopStateEvent('popstate'));
    const req = httpMock.expectOne('/api/auth/me');
    req.flush({
      user: { id: 'm1' },
      profile: { user_id: 'm1', is_active: false, lock_type: 'permanent', lock_reason: 'Vi phạm' },
      role: 'member',
    });

    await vi.waitFor(() => expect(auth.isLoggedIn()).toBe(false));
    expect(auth.consumeLockNotice()).toContain('vĩnh viễn');
    expect(navSpy).toHaveBeenCalledWith(['/auth/signin'], { queryParams: { locked: '1' }, replaceUrl: true });
  });
});
