import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { createStorefrontPage } from '../../../testing/storefront-testing';
import { SiteHeader } from './site-header';

describe('SiteHeader', () => {
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
