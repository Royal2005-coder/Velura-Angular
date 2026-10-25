import { Routes } from '@angular/router';
import {
  adminErpAuthGuard,
  adminErpGuestGuard,
  adminErpHomeRedirectGuard,
  adminErpSessionGuard,
  adminErpShellGuard,
  adminErpWelcomeGuard,
} from './core/admin-erp-auth.guard';
import { AdminErpHomeRedirectPage } from './core/admin-erp-home-redirect';
import { AdminErpShell } from './layout/admin-erp-shell';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/auth/auth-login.page').then((m) => m.AuthLoginPage),
    canActivate: [adminErpGuestGuard],
  },
  {
    path: 'auth/callback',
    loadComponent: () => import('./features/auth/auth-callback.page').then((m) => m.AuthCallbackPage),
  },
  {
    path: 'register',
    loadComponent: () => import('./features/auth/auth-register.page').then((m) => m.AuthRegisterPage),
  },
  {
    path: 'welcome',
    loadComponent: () => import('./features/auth/auth-welcome.page').then((m) => m.AuthWelcomePage),
    canActivate: [adminErpWelcomeGuard],
  },
  {
    path: 'change-password',
    loadComponent: () => import('./features/auth/auth-change-password.page').then((m) => m.AuthChangePasswordPage),
    canActivate: [adminErpSessionGuard],
  },
  {
    path: '',
    component: AdminErpShell,
    canActivate: [adminErpShellGuard],
    children: [
      { path: '', pathMatch: 'full', canActivate: [adminErpHomeRedirectGuard], component: AdminErpHomeRedirectPage },
      {
        path: 'forbidden',
        loadComponent: () => import('./features/auth/auth-forbidden.page').then((m) => m.AuthForbiddenPage),
        canActivate: [adminErpSessionGuard],
      },
      {
        path: 'dashboard',
        loadComponent: () => import('./features/dashboard/admin-erp-dashboard.page').then((m) => m.AdminErpDashboardPage),
        canActivate: [adminErpAuthGuard],
        data: { page: 'dashboard', navKey: 'dashboard' },
      },
      {
        path: 'orders',
        loadComponent: () => import('./features/orders/admin-erp-orders.page').then((m) => m.AdminErpOrdersPage),
        canActivate: [adminErpAuthGuard],
        data: { page: 'orders', navKey: 'orders' },
      },
      {
        path: 'returns',
        loadComponent: () => import('./features/returns/admin-erp-returns.page').then((m) => m.AdminErpReturnsPage),
        canActivate: [adminErpAuthGuard],
        data: { page: 'returns-cskh', alternativePages: ['orders'], navKey: 'returns' },
      },
      {
        path: 'products',
        loadComponent: () => import('./features/products/admin-erp-products.page').then((m) => m.AdminErpProductsPage),
        canActivate: [adminErpAuthGuard],
        data: { page: 'products', alternativePages: ['pricing'], navKey: 'products' },
      },
      {
        path: 'pricing',
        loadComponent: () => import('./features/pricing/admin-erp-pricing.page').then((m) => m.AdminErpPricingPage),
        canActivate: [adminErpAuthGuard],
        data: { page: 'pricing', navKey: 'pricing' },
      },
      {
        path: 'promotions',
        loadComponent: () => import('./features/promotions/admin-erp-promotions.page').then((m) => m.AdminErpPromotionsPage),
        canActivate: [adminErpAuthGuard],
        data: { page: 'promotions', navKey: 'promotions' },
      },
      {
        path: 'reviews',
        loadComponent: () => import('./features/reviews/admin-erp-reviews.page').then((m) => m.AdminErpReviewsPage),
        canActivate: [adminErpAuthGuard],
        data: { page: 'reviews', navKey: 'reviews' },
      },
      {
        path: 'content',
        loadComponent: () => import('./features/content/admin-erp-content.page').then((m) => m.AdminErpContentPage),
        canActivate: [adminErpAuthGuard],
        data: { page: 'content', alternativePages: ['promotions'], navKey: 'content' },
      },
      {
        path: 'accounts',
        loadComponent: () => import('./features/accounts/admin-erp-accounts.page').then((m) => m.AdminErpAccountsPage),
        canActivate: [adminErpAuthGuard],
        data: { page: 'accounts', navKey: 'accounts' },
      },
      {
        path: 'members',
        loadComponent: () => import('./features/members/admin-erp-members.page').then((m) => m.AdminErpMembersPage),
        canActivate: [adminErpAuthGuard],
        data: { page: 'members', navKey: 'members' },
      },
      {
        path: 'logs',
        loadComponent: () => import('./features/logs/admin-erp-logs.page').then((m) => m.AdminErpLogsPage),
        canActivate: [adminErpAuthGuard],
        data: { page: 'logs', navKey: 'logs' },
      },
    ],
  },
  { path: '**', redirectTo: 'login' },
];
