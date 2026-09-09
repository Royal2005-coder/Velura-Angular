import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { SignInPage } from './features/auth/sign-in.page';
import { SignUpPage } from './features/auth/sign-up.page';
import { ForgotPasswordPage } from './features/auth/forgot-password.page';
import { ResetPasswordPage } from './features/auth/reset-password.page';
import { CartPage } from './features/cart/cart.page';
import { CheckoutConfirmPage } from './features/checkout/checkout-confirm.page';
import { CheckoutShippingPage } from './features/checkout/checkout-shipping.page';
import { CheckoutOtpPage } from './features/checkout/otp.page';
import { AboutPage } from './features/content/about.page';
import { BlogDetailPage } from './features/content/blog-detail.page';
import { BlogPage } from './features/content/blog.page';
import { ChatbotPage } from './features/content/chatbot.page';
import { ContactPage } from './features/content/contact.page';
import { OffersPage } from './features/content/offers.page';
import { PoliciesPage } from './features/content/policies.page';
import { CollectionsPage } from './features/collections/collections.page';
import { HomePage } from './features/home/home.page';
import { ProductDetailPage } from './features/products/product-detail.page';
import { ProductListPage } from './features/products/product-list.page';
import { AiSuggestionsPage } from './features/ai/suggestions.page';
import { StyleQuizPage } from './features/ai/style-quiz.page';
import { WishlistPage } from './features/account/wishlist.page';
import { AccountProfilePage } from './features/account/profile.page';
import { AccountOrdersPage } from './features/account/orders.page';
import { AccountOrderDetailPage } from './features/account/order-detail.page';
import { AccountTrackPage } from './features/account/track.page';
import { AccountReturnsPage } from './features/account/returns.page';
import { AccountReviewsPage } from './features/account/reviews.page';
import { SiteShell } from './layout/site-shell/site-shell';

export const routes: Routes = [
  {
    path: 'auth/signin',
    component: SignInPage,
    title: 'Đăng nhập - Velura',
  },
  {
    path: 'auth/signup',
    component: SignUpPage,
    title: 'Đăng ký tài khoản - Velura',
  },
  {
    path: 'auth/forgot-password',
    component: ForgotPasswordPage,
    title: 'Quên mật khẩu - Velura',
  },
  {
    path: 'auth/reset-password',
    component: ResetPasswordPage,
    title: 'Velura — Đặt lại mật khẩu',
  },
  {
    path: '',
    component: SiteShell,
    children: [
      { path: '', component: HomePage, title: 'Velura — Thời trang thông minh cho phái đẹp hiện đại' },
      { path: 'products', component: ProductListPage, title: 'Tất cả sản phẩm — Velura' },
      { path: 'products/:id', component: ProductDetailPage, title: 'Chi tiết sản phẩm — Velura' },
      { path: 'collections', component: CollectionsPage, title: 'Bộ sưu tập thời trang - Velura Store' },
      { path: 'ai/suggestions', component: AiSuggestionsPage, title: 'Gợi ý AI - Velura' },
      { path: 'ai/style-quiz', component: StyleQuizPage, title: 'Style Quiz - Khám phá phong cách cá nhân - Velura Store' },
      { path: 'chatbot', component: ChatbotPage, title: 'AI Stylist Chatbot — Velura' },
      { path: 'blog', component: BlogPage, title: 'Tạp chí phong cách - Velura Journal' },
      { path: 'blog/:slug', component: BlogDetailPage, title: 'Bài viết - Velura Journal' },
      { path: 'about', component: AboutPage, title: 'Về chúng tôi - Velura Store' },
      { path: 'contact', component: ContactPage, title: 'Liên hệ với chúng tôi — Velura' },
      { path: 'offers', component: OffersPage, title: 'Ưu đãi tháng này | Velura' },
      { path: 'policies', component: PoliciesPage, title: 'Chính sách và Điều khoản thương hiệu - Velura' },
      { path: 'wishlist', component: WishlistPage, title: 'Sản phẩm yêu thích - Velura Store' },
      { path: 'cart', component: CartPage, title: 'Giỏ hàng của bạn - Velura Store' },
      { path: 'account/profile', component: AccountProfilePage, title: 'Tài khoản cá nhân - Velura Store' },
      { path: 'account/track', component: AccountTrackPage, title: 'Theo dõi đơn hàng - Velura Store' },
      {
        path: 'account/orders',
        canActivate: [authGuard],
        component: AccountOrdersPage,
        title: 'Đơn hàng của tôi - Velura Store',
      },
      {
        path: 'account/orders/:id',
        canActivate: [authGuard],
        component: AccountOrderDetailPage,
        title: 'Chi tiết đơn hàng - Velura Store',
      },
      {
        path: 'account/returns',
        canActivate: [authGuard],
        component: AccountReturnsPage,
        title: 'Yêu cầu đổi trả - Velura',
      },
      {
        path: 'account/reviews',
        canActivate: [authGuard],
        component: AccountReviewsPage,
        title: 'Đánh giá sản phẩm - Velura Store',
      },
      { path: 'checkout/shipping', component: CheckoutShippingPage, title: 'Vận chuyển & Thanh toán' },
      { path: 'checkout/payment', component: CheckoutOtpPage, title: 'Xác nhận OTP' },
      { path: 'checkout/otp', component: CheckoutOtpPage, title: 'Xác nhận OTP' },
      { path: 'checkout/confirm', component: CheckoutConfirmPage, title: 'Đặt hàng thành công' },
    ],
  },
  { path: '**', redirectTo: '' },
];
