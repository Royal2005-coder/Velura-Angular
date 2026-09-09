import { Routes } from '@angular/router';
import { adminAuthGuard, adminGuestGuard, adminSessionGuard, adminWelcomeGuard } from './core/admin-auth.guard';
import { AdminAccountsPage } from './features/accounts/admin-accounts.page';
import { AdminProductsPage } from './features/catalog/admin-products.page';
import { AdminDashboardPage } from './features/dashboard/admin-dashboard.page';
import { AdminAuthCallbackPage } from './features/login/admin-auth-callback.page';
import { AdminLoginPage } from './features/login/admin-login.page';
import { AdminRegisterPage } from './features/login/admin-register.page';
import { AdminChangePasswordPage } from './features/login/admin-change-password.page';
import { AdminWelcomePage } from './features/login/admin-welcome.page';
import { AdminLogsPage } from './features/logs/admin-logs.page';
import { AdminOrdersPage } from './features/orders/admin-orders.page';
import { AdminPricingPage } from './features/pricing/admin-pricing.page';
import { AdminPromotionsPage } from './features/promotions/admin-promotions.page';
import { AdminReturnsPage } from './features/returns/admin-returns.page';
import { AdminReviewsPage } from './features/reviews/admin-reviews.page';
import { AdminShell } from './layout/admin-shell';

export const routes: Routes = [
  { path: 'login', component: AdminLoginPage, canActivate: [adminGuestGuard], title: 'Đăng nhập quản trị — Velura' },
  { path: 'auth/callback', component: AdminAuthCallbackPage, title: 'Đang xác thực — Velura' },
  { path: 'register', component: AdminRegisterPage, title: 'Đăng ký quản trị' },
  { path: 'welcome', component: AdminWelcomePage, canActivate: [adminWelcomeGuard], title: 'Velura - Chờ cấp quyền admin' },
  { path: 'change-password', component: AdminChangePasswordPage, canActivate: [adminSessionGuard], title: 'Đổi mật khẩu' },
  {
    path: '',
    component: AdminShell,
    canActivate: [adminAuthGuard],
    data: { page: 'dashboard' },
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      { path: 'dashboard', component: AdminDashboardPage, canActivate: [adminAuthGuard], data: { title: 'Dashboard', page: 'dashboard' }, title: 'Dashboard quản trị — Velura' },
      { path: 'accounts', component: AdminAccountsPage, canActivate: [adminAuthGuard], data: { title: 'Quản lý tài khoản', page: 'accounts' }, title: 'Quản lý tài khoản' },
      { path: 'products', component: AdminProductsPage, canActivate: [adminAuthGuard], data: { title: 'Quản lý sản phẩm', page: 'products' }, title: 'Quản lý sản phẩm' },
      { path: 'orders', component: AdminOrdersPage, canActivate: [adminAuthGuard], data: { title: 'Quản lý đơn hàng', page: 'orders' }, title: 'Quản lý đơn hàng' },
      { path: 'reviews', component: AdminReviewsPage, canActivate: [adminAuthGuard], data: { title: 'Quản lý đánh giá', page: 'reviews' }, title: 'Quản lý đánh giá' },
      { path: 'returns', component: AdminReturnsPage, canActivate: [adminAuthGuard], data: { title: 'Đổi trả & CSKH', page: 'returns-cskh' }, title: 'Đổi trả & CSKH' },
      { path: 'pricing', component: AdminPricingPage, canActivate: [adminAuthGuard], data: { title: 'Quản lý giá', page: 'pricing' }, title: 'Quản lý giá' },
      { path: 'promotions', component: AdminPromotionsPage, canActivate: [adminAuthGuard], data: { title: 'Quản lý khuyến mãi', page: 'promotions' }, title: 'Quản lý khuyến mãi' },
      { path: 'logs', component: AdminLogsPage, canActivate: [adminAuthGuard], data: { title: 'Nhật ký hệ thống', page: 'logs' }, title: 'Nhật ký hệ thống' },
    ],
  },
  { path: '**', redirectTo: 'login' },
];
