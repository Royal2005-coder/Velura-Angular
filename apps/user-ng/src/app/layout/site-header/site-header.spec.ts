import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of } from 'rxjs';
import { createStorefrontPage, sampleProduct } from '../../../testing/storefront-testing';
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
});
