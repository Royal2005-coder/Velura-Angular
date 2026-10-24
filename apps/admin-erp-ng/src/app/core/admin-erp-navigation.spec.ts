import {
  ADMIN_ERP_NAV_GROUPS,
  ADMIN_ERP_NAV_ITEMS,
  adminErpNavItemForPage,
  adminErpNavLink,
} from './admin-erp-navigation';

describe('ERP admin navigation registry', () => {
  it('declares every workspace exactly once', () => {
    const keys = Object.values(ADMIN_ERP_NAV_ITEMS).map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
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

  it('marks shipped workspaces ready and the remaining workspaces planned', () => {
    const ready = new Set(['dashboard', 'logs', 'accounts', 'reviews', 'pricing']);
    for (const item of Object.values(ADMIN_ERP_NAV_ITEMS)) {
      expect(item.status).toBe(ready.has(item.key) ? 'ready' : 'planned');
    }
  });
});
