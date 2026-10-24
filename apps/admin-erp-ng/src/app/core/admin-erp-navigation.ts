/**
 * Workspace IA for the ERP admin. This registry is the single frontend source for
 * sidebar labels, route titles, page keys and capability requirements.
 *
 * `status: 'planned'` items are visible so reviewers can inspect the target IA, but
 * they route to the shared "đang hoàn thiện" page until their real workspace ships.
 */
export type AdminErpNavKey =
  | 'dashboard'
  | 'orders'
  | 'returns'
  | 'products'
  | 'pricing'
  | 'promotions'
  | 'reviews'
  | 'accounts'
  | 'logs';

export type AdminErpNavGroupKey = 'overview' | 'selling' | 'catalog' | 'marketing' | 'people' | 'system';

export interface AdminErpNavItem {
  key: AdminErpNavKey;
  label: string;
  title: string;
  description: string;
  icon: string;
  group: AdminErpNavGroupKey;
  path: string;
  pageKeys: string[];
  queryParams?: Record<string, string>;
  capability: string;
  status: 'ready' | 'planned';
}

export interface AdminErpNavGroup {
  key: AdminErpNavGroupKey;
  label: string;
  items: AdminErpNavKey[];
}

export const ADMIN_ERP_NAV_GROUPS: readonly AdminErpNavGroup[] = [
  { key: 'overview', label: 'Tổng quan', items: ['dashboard'] },
  { key: 'selling', label: 'Bán hàng', items: ['orders', 'returns'] },
  { key: 'catalog', label: 'Danh mục', items: ['products', 'pricing'] },
  { key: 'marketing', label: 'Marketing', items: ['promotions', 'reviews'] },
  { key: 'people', label: 'Khách hàng & nhân sự', items: ['accounts'] },
  { key: 'system', label: 'Hệ thống', items: ['logs'] },
];

export const ADMIN_ERP_NAV_ITEMS: Readonly<Record<AdminErpNavKey, AdminErpNavItem>> = {
  dashboard: {
    key: 'dashboard',
    label: 'Tổng quan',
    title: 'Tổng quan vận hành',
    description: 'Nhịp đơn hàng, thanh toán, tồn kho và hàng đợi CSKH trong một màn hình.',
    icon: 'dashboard',
    group: 'overview',
    path: '/dashboard',
    pageKeys: ['dashboard'],
    capability: 'dashboard.read',
    status: 'ready',
  },
  orders: {
    key: 'orders',
    label: 'Đơn hàng',
    title: 'Đơn hàng',
    description: 'Hàng đợi xác nhận, thanh toán, đóng gói và giao vận theo máy trạng thái hiện có.',
    icon: 'cart',
    group: 'selling',
    path: '/orders',
    pageKeys: ['orders'],
    capability: 'orders.read',
    status: 'planned',
  },
  returns: {
    key: 'returns',
    label: 'Đổi trả & CSKH',
    title: 'Đổi trả & CSKH',
    description: 'Phiếu đổi trả, ticket hỗ trợ và hội thoại khách hàng trong cùng một workspace.',
    icon: 'support',
    group: 'selling',
    path: '/returns',
    pageKeys: ['returns-cskh'],
    capability: 'returns.read',
    status: 'planned',
  },
  products: {
    key: 'products',
    label: 'Sản phẩm',
    title: 'Danh mục sản phẩm',
    description: 'Catalog, biến thể, tồn kho, hình ảnh, nội dung và nhập CSV có kiểm duyệt.',
    icon: 'box',
    group: 'catalog',
    path: '/products',
    pageKeys: ['products'],
    capability: 'products.read',
    status: 'planned',
  },
  pricing: {
    key: 'pricing',
    label: 'Giá bán',
    title: 'Giá bán & lịch sử giá',
    description: 'Giá niêm yết, giá khuyến mãi và lịch sử thay đổi tách khỏi catalog.',
    icon: 'tag',
    group: 'catalog',
    path: '/pricing',
    pageKeys: ['pricing'],
    capability: 'pricing.read',
    status: 'ready',
  },
  promotions: {
    key: 'promotions',
    label: 'Khuyến mãi',
    title: 'Khuyến mãi & voucher',
    description: 'Chiến dịch, voucher, ngân sách và lịch chạy khuyến mãi.',
    icon: 'tag',
    group: 'marketing',
    path: '/promotions',
    pageKeys: ['promotions'],
    capability: 'promotions.read',
    status: 'planned',
  },
  reviews: {
    key: 'reviews',
    label: 'Đánh giá',
    title: 'Đánh giá khách hàng',
    description: 'Duyệt đánh giá, phản hồi và xử lý nội dung cần kiểm duyệt.',
    icon: 'star',
    group: 'marketing',
    path: '/reviews',
    pageKeys: ['reviews'],
    capability: 'reviews.read',
    status: 'ready',
  },
  accounts: {
    key: 'accounts',
    label: 'Tài khoản',
    title: 'Tài khoản & phân quyền',
    description: 'Tài khoản khách hàng, nhân sự vận hành và yêu cầu nâng quyền.',
    icon: 'users',
    group: 'people',
    path: '/accounts',
    pageKeys: ['accounts'],
    capability: 'accounts.read',
    status: 'ready',
  },
  logs: {
    key: 'logs',
    label: 'Nhật ký',
    title: 'Nhật ký hệ thống',
    description: 'Tra cứu audit theo module, người thao tác, thời gian và kết quả.',
    icon: 'log',
    group: 'system',
    path: '/logs',
    pageKeys: ['logs'],
    capability: 'audit_logs.read',
    status: 'ready',
  },
};

/**
 * Resolves a sidebar key to its registry entry.
 */
export function adminErpNavItem(key: AdminErpNavKey): AdminErpNavItem {
  return ADMIN_ERP_NAV_ITEMS[key];
}

/**
 * Finds the nav item that owns an `/api/auth/me` page key.
 */
export function adminErpNavItemForPage(page: string): AdminErpNavItem | null {
  const items = Object.values(ADMIN_ERP_NAV_ITEMS);
  return items.find((item) => item.pageKeys.includes(page)) || null;
}

/**
 * Finds the nav item for a route `data.navKey`.
 */
export function adminErpNavItemForNavKey(navKey: string): AdminErpNavItem | null {
  return navKey && navKey in ADMIN_ERP_NAV_ITEMS ? ADMIN_ERP_NAV_ITEMS[navKey as AdminErpNavKey] : null;
}

/**
 * Builds the router link for a nav item, including its deep-link query.
 */
export function adminErpNavLink(item: AdminErpNavItem): string {
  const query = item.queryParams ? new URLSearchParams(item.queryParams).toString() : '';
  return query ? `${item.path}?${query}` : item.path;
}
