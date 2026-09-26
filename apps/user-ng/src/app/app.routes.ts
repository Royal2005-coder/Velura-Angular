import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { purchaseFlowGuard } from './core/guards/purchase-flow.guard';
import { SiteShell } from './layout/site-shell/site-shell';

export const routes: Routes = [
  {
    path: 'auth/signin',
    loadComponent: () => import('./features/auth/sign-in.page').then((m) => m.SignInPage),
    title: 'Đăng nhập - Velura',
  },
  {
    path: 'auth/signup',
    loadComponent: () => import('./features/auth/sign-up.page').then((m) => m.SignUpPage),
    title: 'Đăng ký tài khoản - Velura',
  },
  {
    path: 'auth/forgot-password',
    loadComponent: () => import('./features/auth/forgot-password.page').then((m) => m.ForgotPasswordPage),
    title: 'Quên mật khẩu - Velura',
  },
  {
    path: 'auth/reset-password',
    loadComponent: () => import('./features/auth/reset-password.page').then((m) => m.ResetPasswordPage),
    title: 'Velura — Đặt lại mật khẩu',
  },
  {
    path: 'auth/callback',
    loadComponent: () => import('./features/auth/auth-callback.page').then((m) => m.AuthCallbackPage),
    title: 'Xác thực Google - Velura',
  },
  {
    path: '',
    component: SiteShell,
    children: [
      {
        path: '',
        loadComponent: () => import('./features/home/home.page').then((m) => m.HomePage),
        title: 'Velura — Thời trang thông minh cho phái đẹp hiện đại',
      },
      {
        path: 'products',
        loadComponent: () => import('./features/products/product-list.page').then((m) => m.ProductListPage),
        title: 'Tất cả sản phẩm — Velura',
      },
      {
        path: 'products/:id',
        loadComponent: () => import('./features/products/product-detail.page').then((m) => m.ProductDetailPage),
        title: 'Chi tiết sản phẩm — Velura',
      },
      {
        path: 'collections',
        loadComponent: () => import('./features/collections/collections.page').then((m) => m.CollectionsPage),
        title: 'Bộ sưu tập thời trang - Velura Store',
      },
      {
        path: 'ai/suggestions',
        loadComponent: () => import('./features/ai/suggestions.page').then((m) => m.AiSuggestionsPage),
        title: 'Gợi ý AI - Velura',
      },
      {
        path: 'ai/style-quiz',
        loadComponent: () => import('./features/ai/style-quiz.page').then((m) => m.StyleQuizPage),
        title: 'Style Quiz - Khám phá phong cách cá nhân - Velura Store',
      },
      {
        path: 'chatbot',
        loadComponent: () => import('./features/content/chatbot.page').then((m) => m.ChatbotPage),
        title: 'AI Stylist Chatbot — Velura',
      },
      {
        path: 'blog',
        loadComponent: () => import('./features/content/blog.page').then((m) => m.BlogPage),
        title: 'Tạp chí phong cách - Velura Journal',
      },
      {
        path: 'blog/:slug',
        loadComponent: () => import('./features/content/blog-detail.page').then((m) => m.BlogDetailPage),
        title: 'Bài viết - Velura Journal',
      },
      {
        path: 'about',
        loadComponent: () => import('./features/content/about.page').then((m) => m.AboutPage),
        title: 'Về chúng tôi - Velura Store',
      },
      {
        path: 'contact',
        loadComponent: () => import('./features/content/contact.page').then((m) => m.ContactPage),
        title: 'Liên hệ với chúng tôi — Velura',
      },
      {
        path: 'offers',
        loadComponent: () => import('./features/content/offers.page').then((m) => m.OffersPage),
        title: 'Ưu đãi tháng này | Velura',
      },
      {
        path: 'policies',
        loadComponent: () => import('./features/content/policies.page').then((m) => m.PoliciesPage),
        title: 'Chính sách và Điều khoản thương hiệu - Velura',
      },
      {
        path: 'wishlist',
        loadComponent: () => import('./features/account/wishlist.page').then((m) => m.WishlistPage),
        title: 'Sản phẩm yêu thích - Velura Store',
      },
      {
        path: 'cart',
        loadComponent: () => import('./features/cart/cart.page').then((m) => m.CartPage),
        title: 'Giỏ hàng của bạn - Velura Store',
      },
      {
        path: 'account/profile',
        loadComponent: () => import('./features/account/profile.page').then((m) => m.AccountProfilePage),
        title: 'Tài khoản cá nhân - Velura Store',
      },
      {
        path: 'guest/orders',
        canActivate: [purchaseFlowGuard],
        data: { audience: 'guest', area: 'orders' },
        loadComponent: () => import('./features/account/order-flow.page').then((m) => m.OrderFlowPage),
        title: 'Tra cứu đơn hàng — Velura',
      },
      {
        path: 'guest/orders/:id',
        canActivate: [purchaseFlowGuard],
        data: { audience: 'guest', area: 'orders' },
        loadComponent: () => import('./features/account/order-flow.page').then((m) => m.OrderFlowPage),
        title: 'Chi tiết đơn hàng khách — Velura',
      },
      {
        path: 'guest/returns',
        canActivate: [purchaseFlowGuard],
        data: { audience: 'guest', area: 'orders' },
        loadComponent: () => import('./features/account/order-flow.page').then((m) => m.OrderFlowPage),
        title: 'Tra cứu đổi trả — Velura',
      },
      {
        path: 'account/track',
        canActivate: [purchaseFlowGuard],
        data: { audience: 'entry', area: 'orders' },
        loadComponent: () => import('./features/account/order-flow.page').then((m) => m.OrderFlowPage),
        title: 'Theo dõi đơn hàng - Velura Store',
      },
      {
        path: 'account/orders',
        canActivate: [purchaseFlowGuard],
        data: { audience: 'user', area: 'orders' },
        loadComponent: () => import('./features/account/order-flow.page').then((m) => m.OrderFlowPage),
        title: 'Đơn hàng của tôi - Velura Store',
      },
      {
        path: 'account/orders/:id',
        canActivate: [purchaseFlowGuard],
        data: { audience: 'user', area: 'orders' },
        loadComponent: () => import('./features/account/order-flow.page').then((m) => m.OrderFlowPage),
        title: 'Chi tiết đơn hàng - Velura Store',
      },
      {
        path: 'account/returns',
        canActivate: [purchaseFlowGuard],
        data: { audience: 'user', area: 'orders' },
        loadComponent: () => import('./features/account/order-flow.page').then((m) => m.OrderFlowPage),
        title: 'Yêu cầu đổi trả - Velura',
      },
      {
        path: 'account/reviews',
        canActivate: [authGuard],
        loadComponent: () => import('./features/account/reviews.page').then((m) => m.AccountReviewsPage),
        title: 'Đánh giá sản phẩm - Velura Store',
      },
      {
        path: 'account/vouchers',
        canActivate: [authGuard],
        loadComponent: () => import('./features/account/vouchers.page').then((m) => m.AccountVouchersPage),
        title: 'Ví Voucher - Velura Store',
      },
      {
        path: 'checkout/guest',
        canActivate: [purchaseFlowGuard],
        data: { audience: 'guest', area: 'checkout' },
        loadComponent: () => import('./features/checkout/purchase-flow.page').then((m) => m.PurchaseFlowPage),
        title: 'Thanh toán khách — Velura',
      },
      {
        path: 'checkout/user',
        canActivate: [purchaseFlowGuard],
        data: { audience: 'user', area: 'checkout' },
        loadComponent: () => import('./features/checkout/purchase-flow.page').then((m) => m.PurchaseFlowPage),
        title: 'Thanh toán thành viên — Velura',
      },
      {
        path: 'checkout/shipping',
        pathMatch: 'full',
        redirectTo: '/checkout/guest',
      },
      {
        path: 'checkout/payment',
        pathMatch: 'full',
        redirectTo: '/checkout/shipping',
      },
      {
        path: 'checkout/otp',
        loadComponent: () => import('./features/checkout/otp.page').then((m) => m.CheckoutOtpPage),
        title: 'Xác nhận OTP',
      },
      {
        path: 'checkout/confirm',
        loadComponent: () => import('./features/checkout/checkout-confirm.page').then((m) => m.CheckoutConfirmPage),
        title: 'Đặt hàng thành công',
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
