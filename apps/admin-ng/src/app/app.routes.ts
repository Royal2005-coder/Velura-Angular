import { Routes } from '@angular/router';
import {
  adminAuthGuard,
  adminGuestGuard,
  adminHomeRedirectGuard,
  adminSessionGuard,
  adminShellGuard,
  adminWelcomeGuard,
} from './core/admin-auth.guard';
import { AdminHomeRedirectPage } from './core/admin-home-redirect';
import { AdminShell } from './layout/admin-shell';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/login/admin-login.page').then((m) => m.AdminLoginPage),
    canActivate: [adminGuestGuard],
    title: 'Đăng nhập quản trị — Velura',
  },
  {
    path: 'auth/callback',
    loadComponent: () => import('./features/login/admin-auth-callback.page').then((m) => m.AdminAuthCallbackPage),
    title: 'Đang xác thực — Velura',
  },
  {
    path: 'register',
    loadComponent: () => import('./features/login/admin-register.page').then((m) => m.AdminRegisterPage),
    title: 'Đăng ký quản trị',
  },
  {
    path: 'welcome',
    loadComponent: () => import('./features/login/admin-welcome.page').then((m) => m.AdminWelcomePage),
    canActivate: [adminWelcomeGuard],
    title: 'Velura - Chờ cấp quyền admin',
  },
  {
    path: 'change-password',
    loadComponent: () => import('./features/login/admin-change-password.page').then((m) => m.AdminChangePasswordPage),
    canActivate: [adminSessionGuard],
    title: 'Đổi mật khẩu',
  },
  {
    path: '',
    component: AdminShell,
    canActivate: [adminShellGuard],
    children: [
      { path: '', pathMatch: 'full', canActivate: [adminHomeRedirectGuard], component: AdminHomeRedirectPage },
      {
        path: 'forbidden',
        loadComponent: () => import('./features/login/admin-forbidden.page').then((m) => m.AdminForbiddenPage),
        canActivate: [adminSessionGuard],
        data: { title: 'Không có quyền truy cập' },
        title: 'Không có quyền truy cập',
      },
      {
        path: 'dashboard',
        loadComponent: () => import('./features/dashboard/admin-dashboard.page').then((m) => m.AdminDashboardPage),
        canActivate: [adminAuthGuard],
        data: { title: 'Dashboard', page: 'dashboard' },
        title: 'Dashboard quản trị — Velura',
      },
      {
        path: 'accounts',
        loadComponent: () => import('./features/accounts/admin-accounts.page').then((m) => m.AdminAccountsPage),
        canActivate: [adminAuthGuard],
        data: { title: 'Quản lý tài khoản', page: 'accounts' },
        title: 'Quản lý tài khoản',
      },
      {
        path: 'products',
        loadComponent: () => import('./features/catalog/admin-products.page').then((m) => m.AdminProductsPage),
        canActivate: [adminAuthGuard],
        data: { title: 'Quản lý sản phẩm', page: 'products' },
        title: 'Quản lý sản phẩm',
      },
      {
        path: 'orders',
        loadComponent: () => import('./features/orders/admin-orders.page').then((m) => m.AdminOrdersPage),
        canActivate: [adminAuthGuard],
        data: { title: 'Quản lý đơn hàng', page: 'orders' },
        title: 'Quản lý đơn hàng',
      },
      {
        path: 'reviews',
        loadComponent: () => import('./features/reviews/admin-reviews.page').then((m) => m.AdminReviewsPage),
        canActivate: [adminAuthGuard],
        data: { title: 'Quản lý đánh giá', page: 'reviews' },
        title: 'Quản lý đánh giá',
      },
      {
        path: 'returns',
        loadComponent: () => import('./features/returns/admin-returns.page').then((m) => m.AdminReturnsPage),
        canActivate: [adminAuthGuard],
        data: { title: 'Đổi trả & CSKH', page: 'returns-cskh' },
        title: 'Đổi trả & CSKH',
      },
      {
        path: 'pricing',
        loadComponent: () => import('./features/pricing/admin-pricing.page').then((m) => m.AdminPricingPage),
        canActivate: [adminAuthGuard],
        data: { title: 'Quản lý giá', page: 'pricing' },
        title: 'Quản lý giá',
      },
      {
        path: 'promotions',
        loadComponent: () => import('./features/promotions/admin-promotions.page').then((m) => m.AdminPromotionsPage),
        canActivate: [adminAuthGuard],
        data: { title: 'Quản lý khuyến mãi', page: 'promotions' },
        title: 'Quản lý khuyến mãi',
      },
      {
        path: 'logs',
        loadComponent: () => import('./features/logs/admin-logs.page').then((m) => m.AdminLogsPage),
        canActivate: [adminAuthGuard],
        data: { title: 'Nhật ký hệ thống', page: 'logs' },
        title: 'Nhật ký hệ thống',
      },
    ],
  },
  { path: '**', redirectTo: 'login' },
];
