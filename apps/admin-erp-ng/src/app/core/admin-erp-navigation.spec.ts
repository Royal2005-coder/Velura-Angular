import {
  ADMIN_ERP_NAV_GROUPS,
  ADMIN_ERP_NAV_ITEMS,
  ADMIN_ERP_QUICK_ACTIONS,
  adminErpNavItemForPage,
  adminErpNavLink,
  adminErpNavMatchesSearch,
  adminErpQuickActionMatchesSearch,
} from './admin-erp-navigation';

describe('ERP admin navigation registry', () => {
  it('declares every workspace with a distinct key and distinct topic icon', () => {
    const items = Object.values(ADMIN_ERP_NAV_ITEMS);
    const keys = items.map((item) => item.key);
    const icons = items.map((item) => item.icon);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('matches deep quick-actions in the command palette without Vietnamese diacritics', () => {
    const bannerAction = ADMIN_ERP_QUICK_ACTIONS.find((a) => a.id === 'content-banners')!;
    const lowStockAction = ADMIN_ERP_QUICK_ACTIONS.find((a) => a.id === 'products-stock')!;
    expect(adminErpQuickActionMatchesSearch(bannerAction, 'banner san pham')).toBe(true);
    expect(adminErpQuickActionMatchesSearch(lowStockAction, 'sap het hang')).toBe(true);
    expect(adminErpNavLink(bannerAction)).toBe('/content?tab=banners');
  });

  it('keeps every group item resolvable', () => {
    for (const group of ADMIN_ERP_NAV_GROUPS) {
      for (const key of group.items) {
        expect(ADMIN_ERP_NAV_ITEMS[key]).toBeDefined();
        expect(ADMIN_ERP_NAV_ITEMS[key].group).toBe(group.key);
      }
    }
  });

  it('maps pricing to its dedicated workspace', () => {
    expect(adminErpNavLink(ADMIN_ERP_NAV_ITEMS.pricing)).toBe('/pricing');
  });

  it('resolves page keys back to their workspace', () => {
    expect(adminErpNavItemForPage('returns-cskh')?.key).toBe('returns');
    expect(adminErpNavItemForPage('pricing')?.key).toBe('pricing');
    expect(adminErpNavItemForPage('unknown-page')).toBeNull();
  });

  it('finds a workspace typed without Vietnamese diacritics', () => {
    const selling = ADMIN_ERP_NAV_GROUPS.find((group) => group.key === 'selling')!.label;
    // "don hang" is what operators actually type; it must match "Đơn hàng".
    expect(adminErpNavMatchesSearch(ADMIN_ERP_NAV_ITEMS.orders, selling, 'don hang')).toBe(true);
    expect(adminErpNavMatchesSearch(ADMIN_ERP_NAV_ITEMS.orders, selling, 'DON-HANG')).toBe(true);
    expect(adminErpNavMatchesSearch(ADMIN_ERP_NAV_ITEMS.returns, selling, 'doi tra')).toBe(true);
    // The page title is searchable too, not only the sidebar label.
    expect(adminErpNavMatchesSearch(ADMIN_ERP_NAV_ITEMS.products, 'Danh mục', 'danh muc san pham')).toBe(true);
    expect(adminErpNavMatchesSearch(ADMIN_ERP_NAV_ITEMS.orders, selling, 'kho van')).toBe(false);
  });

  it('marks shipped workspaces ready and the remaining workspaces planned', () => {
    const ready = new Set(['dashboard', 'logs', 'accounts', 'members', 'reviews', 'pricing', 'orders', 'promotions', 'products', 'returns', 'content']);
    for (const item of Object.values(ADMIN_ERP_NAV_ITEMS)) {
      expect(item.status).toBe(ready.has(item.key) ? 'ready' : 'planned');
    }
  });
});
