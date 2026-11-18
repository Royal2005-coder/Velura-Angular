/**
 * Workspace IA for the ERP admin. This registry is the single frontend source for
 * sidebar labels, route titles, page keys, semantic topic icons and capability requirements.
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
  | 'content'
  | 'accounts'
  | 'members'
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

/**
 * Deep sub-queue shortcut surfaced in the `⌘K` Command Palette so operators can jump straight to a
 * specific tab or filtered queue (e.g. "Đơn lỗi thanh toán", "Quản lý Banner") in one keystroke.
 */
export interface AdminErpQuickAction {
  readonly id: string;
  readonly navKey: AdminErpNavKey;
  readonly label: string;
  readonly subtitle: string;
  readonly keywords: string;
  readonly icon: string;
  readonly path: string;
  readonly queryParams?: Record<string, string>;
}

export const ADMIN_ERP_NAV_GROUPS: readonly AdminErpNavGroup[] = [
  { key: 'overview', label: 'Tổng quan', items: ['dashboard'] },
  { key: 'selling', label: 'Bán hàng', items: ['orders', 'returns'] },
  { key: 'catalog', label: 'Danh mục', items: ['products', 'pricing'] },
  { key: 'marketing', label: 'Marketing', items: ['promotions', 'reviews', 'content'] },
  { key: 'people', label: 'Khách hàng & nhân sự', items: ['accounts', 'members'] },
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
    icon: 'shopping-bag',
    group: 'selling',
    path: '/orders',
    pageKeys: ['orders'],
    capability: 'orders.read',
    status: 'ready',
  },
  returns: {
    key: 'returns',
    label: 'Đổi trả & CSKH',
    title: 'Đổi trả & CSKH',
    description: 'Phiếu đổi trả, ticket hỗ trợ và hội thoại khách hàng trong cùng một workspace.',
    icon: 'return',
    group: 'selling',
    path: '/returns',
    pageKeys: ['returns-cskh'],
    capability: 'returns.read',
    status: 'ready',
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
    status: 'ready',
  },
  pricing: {
    key: 'pricing',
    label: 'Giá bán',
    title: 'Giá bán & lịch sử giá',
    description: 'Giá niêm yết, giá khuyến mãi và lịch sử thay đổi tách khỏi catalog.',
    icon: 'coins',
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
    icon: 'ticket',
    group: 'marketing',
    path: '/promotions',
    pageKeys: ['promotions'],
    capability: 'promotions.read',
    status: 'ready',
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
  content: {
    key: 'content',
    label: 'Nội dung',
    title: 'CMS nội dung',
    description: 'Bài viết, banner trang sản phẩm, bộ sưu tập & lookbook, và danh sách nhận tin.',
    icon: 'layers',
    group: 'marketing',
    path: '/content',
    pageKeys: ['content'],
    capability: 'content.read',
    status: 'ready',
  },
  accounts: {
    key: 'accounts',
    label: 'Tài khoản',
    title: 'Tài khoản & phân quyền',
    description: 'Tài khoản khách hàng, nhân sự vận hành và yêu cầu nâng quyền.',
    icon: 'shield-user',
    group: 'people',
    path: '/accounts',
    pageKeys: ['accounts'],
    capability: 'accounts.read',
    status: 'ready',
  },
  members: {
    key: 'members',
    label: 'Thành viên & điểm',
    title: 'Thành viên & điểm',
    description: 'Ví điểm, dấu vết bút toán, giới thiệu và ưu đãi; khoá/mở tích luỹ có lý do và audit.',
    icon: 'award',
    group: 'people',
    path: '/members',
    pageKeys: ['members'],
    capability: 'members.read',
    status: 'ready',
  },
  logs: {
    key: 'logs',
    label: 'Nhật ký',
    title: 'Nhật ký hệ thống',
    description: 'Tra cứu audit theo module, người thao tác, thời gian và kết quả.',
    icon: 'activity',
    group: 'system',
    path: '/logs',
    pageKeys: ['logs'],
    capability: 'audit_logs.read',
    status: 'ready',
  },
};

export const ADMIN_ERP_QUICK_ACTIONS: readonly AdminErpQuickAction[] = [
  {
    id: 'orders-attention',
    navKey: 'orders',
    label: 'Đơn hàng cần xử lý',
    subtitle: 'Bán hàng · Hàng đợi xác nhận & đóng gói',
    keywords: 'don can xu ly cho xac nhan cod',
    icon: 'clock',
    path: '/orders',
    queryParams: { tab: 'attention' },
  },
  {
    id: 'orders-payment',
    navKey: 'orders',
    label: 'Đơn lỗi thanh toán',
    subtitle: 'Bán hàng · Đối soát cổng thanh toán',
    keywords: 'loi thanh toan payment discrepancy',
    icon: 'credit-card',
    path: '/orders',
    queryParams: { tab: 'payment' },
  },
  {
    id: 'returns-tickets',
    navKey: 'returns',
    label: 'Phiếu hỗ trợ CSKH',
    subtitle: 'Đổi trả & CSKH · Ticket khiếu nại khách hàng',
    keywords: 'phieu ho tro ticket khieu nai cskh',
    icon: 'support',
    path: '/returns',
    queryParams: { tab: 'tickets' },
  },
  {
    id: 'returns-chat',
    navKey: 'returns',
    label: 'Hội thoại trực tiếp (Live Chat)',
    subtitle: 'Đổi trả & CSKH · Bàn trực chat khách hàng',
    keywords: 'hoi thoai live chat tin nhan',
    icon: 'chat',
    path: '/returns',
    queryParams: { tab: 'chat' },
  },
  {
    id: 'products-stock',
    navKey: 'products',
    label: 'Biến thể sắp hết hàng',
    subtitle: 'Sản phẩm · Cảnh báo tồn kho dưới ngưỡng',
    keywords: 'ton kho sap het hang low stock nhap kho',
    icon: 'trending-down',
    path: '/products',
    queryParams: { tab: 'stock' },
  },
  {
    id: 'products-import',
    navKey: 'products',
    label: 'Nhập sản phẩm bằng CSV',
    subtitle: 'Sản phẩm · Tải hàng loạt có kiểm duyệt',
    keywords: 'nhap csv import excel bulk upload',
    icon: 'file-spreadsheet',
    path: '/products',
    queryParams: { tab: 'import' },
  },
  {
    id: 'pricing-history',
    navKey: 'pricing',
    label: 'Lịch sử thay đổi giá',
    subtitle: 'Giá bán · Dấu vết điều chỉnh giá gốc & khuyến mãi',
    keywords: 'lich su gia doi gia bien do',
    icon: 'coins',
    path: '/pricing',
    queryParams: { tab: 'history' },
  },
  {
    id: 'promotions-vouchers',
    navKey: 'promotions',
    label: 'Danh sách mã Voucher',
    subtitle: 'Khuyến mãi · Quản lý mã giảm giá & lượt dùng',
    keywords: 'voucher ma giam gia coupon',
    icon: 'ticket',
    path: '/promotions',
    queryParams: { tab: 'vouchers' },
  },
  {
    id: 'reviews-urgent',
    navKey: 'reviews',
    label: 'Đánh giá cần xử lý gấp',
    subtitle: 'Đánh giá · Phản hồi ≤2 sao hoặc gắn cờ',
    keywords: 'danh gia gap 1 sao 2 sao khieu nai',
    icon: 'alert',
    path: '/reviews',
    queryParams: { tab: 'urgent' },
  },
  {
    id: 'content-banners',
    navKey: 'content',
    label: 'Quản lý Banner trang sản phẩm',
    subtitle: 'CMS nội dung · Ảnh/video hero & căn chỉnh tiêu điểm',
    keywords: 'banner video anh hero san pham',
    icon: 'image',
    path: '/content',
    queryParams: { tab: 'banners' },
  },
  {
    id: 'content-collections',
    navKey: 'content',
    label: 'Bộ sưu tập & Lookbook Runway',
    subtitle: 'CMS nội dung · Ảnh bìa, 5 người mẫu & trang chủ',
    keywords: 'bo suu tap lookbook nguoi mau trang chu',
    icon: 'sparkles',
    path: '/content',
    queryParams: { tab: 'collections' },
  },
  {
    id: 'accounts-promotions',
    navKey: 'accounts',
    label: 'Yêu cầu nâng quyền quản trị',
    subtitle: 'Tài khoản · Phê duyệt cấp quyền vận hành',
    keywords: 'nang quyen phan quyen rbac duyet admin',
    icon: 'shield-check',
    path: '/accounts',
    queryParams: { tab: 'promotions' },
  },
  {
    id: 'logs-ai',
    navKey: 'logs',
    label: 'Nhật ký tác vụ AI',
    subtitle: 'Nhật ký hệ thống · VTO, phân tích màu & tìm kiếm ảnh',
    keywords: 'nhat ky ai vto thu do mau ca nhan',
    icon: 'sparkles',
    path: '/logs',
    queryParams: { tab: 'ai' },
  },
];

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
 * Matches the command palette query against one nav item.
 *
 * Operators type "don hang" far more often than "Đơn hàng", so the comparison ignores case,
 * Vietnamese diacritics and separators: the folded or separator-free form of the label, group
 * and page title must contain the same form of the query.
 */
export function adminErpNavMatchesSearch(item: AdminErpNavItem, groupLabel: string, query: string): boolean {
  return matchesFoldedFields([item.label, groupLabel, item.title, item.description], query);
}

/**
 * Matches the command palette query against a deep sub-queue shortcut.
 */
export function adminErpQuickActionMatchesSearch(action: AdminErpQuickAction, query: string): boolean {
  return matchesFoldedFields([action.label, action.subtitle, action.keywords], query);
}

function matchesFoldedFields(fields: readonly string[], query: string): boolean {
  const needle = foldNavText(query);
  if (!needle) {
    return true;
  }
  const compactNeedle = compactNavText(needle);
  const foldedList = fields.map((value) => foldNavText(value));
  if (
    foldedList.some(
      (folded) => folded.includes(needle) || (!!compactNeedle && compactNavText(folded).includes(compactNeedle)),
    )
  ) {
    return true;
  }
  const tokens = needle.split(' ').filter(Boolean);
  if (tokens.length > 1) {
    const combined = foldedList.join(' ');
    return tokens.every((token) => combined.includes(token));
  }
  return false;
}

function foldNavText(value: string | null | undefined): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function compactNavText(value: string): string {
  return value.replace(/[^a-z0-9]+/g, '');
}

/**
 * Builds the router link for a nav item or quick action, including its deep-link query.
 */
export function adminErpNavLink(item: { path: string; queryParams?: Record<string, string> }): string {
  const query = item.queryParams ? new URLSearchParams(item.queryParams).toString() : '';
  return query ? `${item.path}?${query}` : item.path;
}
