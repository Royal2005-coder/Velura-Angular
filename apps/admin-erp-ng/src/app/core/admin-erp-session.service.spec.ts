import { TestBed } from '@angular/core/testing';
import { AdminAuthMe, AdminErpSessionService } from './admin-erp-session.service';

const superAdmin: AdminAuthMe = {
  role: 'super_admin',
  roleName: 'Admin quản trị',
  isAdmin: true,
  allowedPages: ['dashboard', 'products', 'orders'],
  allowedModules: ['*'],
  capabilities: { '*': ['read', 'create', 'update', 'delete', 'approve'] },
  user: { id: 'root', email: 'root@velura.test' },
  profile: { user_id: 'root', email: 'root@velura.test', full_name: 'Root Admin', is_active: true },
};

const productOperator: AdminAuthMe = {
  role: 'admin_operator_sanpham',
  roleName: 'Admin sản phẩm',
  isAdmin: true,
  allowedPages: ['products'],
  allowedModules: ['products', 'categories', 'inventory'],
  capabilities: { products: ['read', 'create', 'update'] },
  user: { id: 'sp', email: 'sp@velura.test' },
  profile: { user_id: 'sp', email: 'sp@velura.test', full_name: 'Sản phẩm', is_active: true },
};

describe('AdminErpSessionService capabilities', () => {
  let service: AdminErpSessionService;

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    TestBed.resetTestingModule();
    service = TestBed.inject(AdminErpSessionService);
    service.clear();
  });

  it('grants every declared action through the wildcard capability', () => {
    service.applyAuthContext(superAdmin);
    expect(service.can('read', 'products')).toBe(true);
    expect(service.can('approve', 'accounts')).toBe(true);
  });

  it('keeps product writes on the product module only', () => {
    service.applyAuthContext(productOperator);
    expect(service.can('update', 'products')).toBe(true);
    expect(service.can('update', 'orders')).toBe(false);
    expect(service.can('read', 'inventory')).toBe(true);
  });

  it('allows reads from allowedModules but fails writes closed without capabilities', () => {
    service.applyAuthContext({
      ...productOperator,
      capabilities: undefined,
    });
    expect(service.can('read', 'products')).toBe(true);
    expect(service.can('update', 'products')).toBe(false);
  });

  it('lands a product operator on the products workspace, not dashboard', () => {
    service.applyAuthContext(productOperator);
    expect(service.firstRoute()).toBe('/products');
  });

  it('uses ERP-specific storage keys', () => {
    service.applyAuthContext(superAdmin, 'token-123');
    expect(sessionStorage.getItem('velura_admin_erp_access_token')).toBe('token-123');
    expect(sessionStorage.getItem('velura_admin_access_token')).toBeNull();
  });
});
