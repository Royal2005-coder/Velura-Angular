import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AdminErpApiService } from '../core/admin-erp-api.service';
import { AdminErpSessionService } from '../core/admin-erp-session.service';
import { AdminErpShell, SIDEBAR_COLLAPSED_STORAGE_KEY } from './admin-erp-shell';

describe('AdminErpShell sidebar collapse', () => {
  function stubViewport(mobile: boolean): void {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: mobile,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
  }

  async function boot(mobile = false) {
    stubViewport(mobile);
    TestBed.resetTestingModule();
    const session = {
      session: signal(null),
      initials: signal('QT'),
      displayName: signal('Quản trị viên'),
      roleLabel: signal('Velura ERP'),
      avatarUrl: signal(''),
      canOpenAny: () => true,
    };
    await TestBed.configureTestingModule({
      imports: [AdminErpShell],
      providers: [
        provideRouter([]),
        { provide: AdminErpApiService, useValue: { signOut: () => of({ success: true }) } },
        { provide: AdminErpSessionService, useValue: session },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(AdminErpShell);
    fixture.detectChanges();
    return fixture;
  }

  function clickToggle(fixture: ComponentFixture<AdminErpShell>): void {
    const toggle = fixture.nativeElement.querySelector('.topbar__menu') as HTMLButtonElement;
    toggle.click();
    fixture.detectChanges();
  }

  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('renders exactly one sidebar toggle', async () => {
    const fixture = await boot();

    expect(fixture.nativeElement.querySelectorAll('[aria-controls="erp-sidebar"]').length).toBe(1);
    expect(fixture.nativeElement.querySelector('.rail-toggle')).toBeNull();
  });

  it('restores the collapsed rail from localStorage', async () => {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, 'true');

    const fixture = await boot();

    expect(fixture.componentInstance.sidebarCollapsed()).toBe(true);
    expect(fixture.nativeElement.querySelector('.shell').classList).toContain('is-collapsed');
  });

  it('starts expanded when nothing is stored', async () => {
    const fixture = await boot();

    expect(fixture.componentInstance.sidebarCollapsed()).toBe(false);
  });

  it('writes the rail state on every desktop toggle', async () => {
    const fixture = await boot();

    clickToggle(fixture);
    expect(fixture.componentInstance.sidebarCollapsed()).toBe(true);
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('true');

    clickToggle(fixture);
    expect(fixture.componentInstance.sidebarCollapsed()).toBe(false);
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('false');
  });

  it('still toggles when storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    const fixture = await boot();
    expect(fixture.componentInstance.sidebarCollapsed()).toBe(false);

    clickToggle(fixture);
    expect(fixture.componentInstance.sidebarCollapsed()).toBe(true);
  });

  it('opens the mobile drawer without touching the stored rail state', async () => {
    const fixture = await boot(true);

    clickToggle(fixture);

    expect(fixture.componentInstance.mobileNavOpen()).toBe(true);
    expect(fixture.componentInstance.sidebarCollapsed()).toBe(false);
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBeNull();
  });
});
