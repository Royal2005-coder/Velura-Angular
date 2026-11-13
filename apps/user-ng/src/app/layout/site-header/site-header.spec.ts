import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of } from 'rxjs';
import { createStorefrontPage, lastStorefrontFixture, sampleProduct, TestRouteTarget } from '../../../testing/storefront-testing';
import { CatalogService } from '../../core/services/catalog.service';
import { SiteHeader } from './site-header';

describe('SiteHeader', () => {
  it('refreshes suggestions when search reopens without fetching on every keystroke', async () => {
    const header = await createStorefrontPage(SiteHeader);
    const catalog = TestBed.inject(CatalogService);
    const renamed = { ...sampleProduct, name: 'UAT-Khai Áo Thun Premium Cotton 100%' };
    const getProducts = vi.spyOn(catalog, 'getProducts').mockReturnValue(of([renamed]));
    header.onSearchFocus();
    header.searchQuery.set('Premium Cotton 100%');
    expect(header.instantSuggestions()[0].name).toBe(renamed.name);
    const input = document.createElement('input');
    input.value = 'Premium Cotton';
    header.onSearchInput({ target: input } as unknown as Event);
    expect(getProducts).toHaveBeenCalledTimes(1);
    header.closeSearch();
    header.onSearchFocus();
    expect(getProducts).toHaveBeenCalledTimes(2);
  });
  it('clears the member session and returns to home after logout', async () => {
    const header = await createStorefrontPage(SiteHeader);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    localStorage.setItem('velura_token', 'token');
    localStorage.setItem('velura_user', JSON.stringify({ user_id: 'member-1' }));

    header.logout();

    expect(localStorage.getItem('velura_token')).toBeNull();
    expect(localStorage.getItem('velura_user')).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('renders a full backdrop overlay on search focus and closes when clicked', async () => {
    const header = await createStorefrontPage(SiteHeader);
    const fixture = lastStorefrontFixture();

    expect(header.searchOpen()).toBe(false);
    expect(fixture.nativeElement.querySelector('.search-backdrop')).toBeNull();

    header.onSearchFocus();
    fixture.detectChanges();

    expect(header.searchOpen()).toBe(true);
    const backdrop = fixture.nativeElement.querySelector('.search-backdrop') as HTMLElement | null;
    expect(backdrop).not.toBeNull();

    backdrop?.click();
    fixture.detectChanges();

    expect(header.searchOpen()).toBe(false);
    expect(fixture.nativeElement.querySelector('.search-backdrop')).toBeNull();
  });

  it('offers semantic AI search only when the server reports the worker text task ready', async () => {
    const header = await createStorefrontPage(SiteHeader);
    const fixture = lastStorefrontFixture();
    header.onSearchFocus();
    header.searchQuery.set('Đầm đỏ dáng xòe');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.search-dd__ai-btn')).toBeNull();

    header.aiTextSearchReady.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.search-dd__ai-btn')).not.toBeNull();
  });

  describe('committed search state', () => {
    const routes = [
      { path: 'products', component: TestRouteTarget },
      { path: 'products/:id', component: TestRouteTarget },
      { path: 'about', component: TestRouteTarget },
      { path: '', component: TestRouteTarget },
    ];

    it('mirrors the trimmed q of a committed results URL', async () => {
      const header = await createStorefrontPage(SiteHeader, {}, { routes });
      const router = TestBed.inject(Router);

      await router.navigateByUrl('/products?q=%20peplum%20');

      expect(header.searchQuery()).toBe('peplum');
    });

    it('clears the query when navigation commits outside product results', async () => {
      const header = await createStorefrontPage(SiteHeader, {}, { routes });
      const router = TestBed.inject(Router);

      await router.navigateByUrl('/products?q=peplum');
      expect(header.searchQuery()).toBe('peplum');

      await router.navigateByUrl('/products/ao-linen');
      expect(header.searchQuery()).toBe('');
      expect(header.searchOpen()).toBe(false);

      await router.navigateByUrl('/products?q=peplum');
      await router.navigateByUrl('/about');
      expect(header.searchQuery()).toBe('');
    });

    it('restores the query from browser history and direct results links', async () => {
      const header = await createStorefrontPage(SiteHeader, {}, { routes });
      const router = TestBed.inject(Router);

      await router.navigateByUrl('/products?q=peplum');
      await router.navigateByUrl('/products/ao-linen');
      expect(header.searchQuery()).toBe('');

      await router.navigateByUrl('/products?q=peplum');
      expect(header.searchQuery()).toBe('peplum');
    });

    it('does not clear the query when navigation is cancelled', async () => {
      const header = await createStorefrontPage(SiteHeader, {}, {
        routes: [...routes, { path: 'blocked', component: TestRouteTarget, canActivate: [() => false] }],
      });
      const router = TestBed.inject(Router);

      await router.navigateByUrl('/products?q=peplum');
      expect(header.searchQuery()).toBe('peplum');

      await router.navigateByUrl('/blocked');

      expect(router.url).toBe('/products?q=peplum');
      expect(header.searchQuery()).toBe('peplum');
    });

    it('closes suggestions after a committed navigation', async () => {
      const header = await createStorefrontPage(SiteHeader, {}, { routes });
      const router = TestBed.inject(Router);

      header.onSearchFocus();
      expect(header.searchOpen()).toBe(true);

      await router.navigateByUrl('/products?q=peplum');

      expect(header.searchOpen()).toBe(false);
    });

    it('collapses the mobile navigation drawer when navigation commits', async () => {
      const header = await createStorefrontPage(SiteHeader, {}, { routes });
      const router = TestBed.inject(Router);

      header.navOpen.set(true);
      expect(header.navOpen()).toBe(true);

      await router.navigateByUrl('/about');

      expect(header.navOpen()).toBe(false);
    });

    it('closes mobile navigation and search on Escape key', async () => {
      const header = await createStorefrontPage(SiteHeader, {}, { routes });

      header.navOpen.set(true);
      header.searchOpen.set(true);

      header.onEscape();

      expect(header.navOpen()).toBe(false);
      expect(header.searchOpen()).toBe(false);
    });

    it('synchronizes the native header search input element when query is cleared', async () => {
      const header = await createStorefrontPage(SiteHeader, {}, { routes });
      const router = TestBed.inject(Router);
      const fixture = lastStorefrontFixture();
      fixture.detectChanges();

      await router.navigateByUrl('/products?q=dam-da-tiec');
      fixture.detectChanges();

      const input = fixture.nativeElement.querySelector('.js-search-input') as HTMLInputElement | null;
      expect(header.searchQuery()).toBe('dam-da-tiec');
      if (input) expect(input.value).toBe('dam-da-tiec');

      await router.navigateByUrl('/about');
      fixture.detectChanges();

      expect(header.searchQuery()).toBe('');
      if (input) expect(input.value).toBe('');
    });

    it('clears search state and closes navigation when clicking navigation tabs', async () => {
      const header = await createStorefrontPage(SiteHeader, {}, { routes });
      header.searchQuery.set('dam-da-tiec');
      header.navOpen.set(true);

      header.onNavClick();

      expect(header.searchQuery()).toBe('');
      expect(header.navOpen()).toBe(false);
    });
  });
});
