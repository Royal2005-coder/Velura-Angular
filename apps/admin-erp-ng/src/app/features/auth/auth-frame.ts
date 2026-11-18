import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AdminErpIcon } from '../../shared/ui/admin-erp-icon';

/**
 * Shared split-screen frame for all ERP auth states, styled with WCAG AA+ luxury editorial contrast.
 */
@Component({
  selector: 'app-auth-frame',
  imports: [RouterLink, AdminErpIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="auth-frame">
      <section class="auth-frame__brand" aria-hidden="true">
        <a class="auth-brand" routerLink="/login" tabindex="-1">
          <img src="/admin-assets/images/logo.png" alt="" />
          <span>
            <strong>Velura</strong>
            <small>Enterprise ERP</small>
          </span>
        </a>
        <div class="auth-frame__pitch">
          <span class="auth-frame__eyebrow">Hệ điều hành vận hành thương mại</span>
          <h1>Quản trị tinh gọn trong một không gian hợp nhất.</h1>
          <p>Danh mục, đơn hàng, kho vận, CSKH, nội dung Lookbook và phân quyền đồng bộ tức thì với dữ liệu thật từ API Velura.</p>
        </div>
        <ul class="auth-frame__points">
          <li>
            <span class="auth-frame__point-icon"><app-erp-icon name="shield-user" [size]="'16'" /></span>
            <span>Không gian làm việc phân quyền chặt chẽ theo vai trò</span>
          </li>
          <li>
            <span class="auth-frame__point-icon"><app-erp-icon name="layers" [size]="'16'" /></span>
            <span>Bảng dữ liệu mật độ cao, chống tràn &amp; thao tác nhanh 1 chạm</span>
          </li>
          <li>
            <span class="auth-frame__point-icon"><app-erp-icon name="activity" [size]="'16'" /></span>
            <span>Đối soát phiên bản (Optimistic Lock) &amp; nhật ký kiểm toán đầy đủ</span>
          </li>
        </ul>
      </section>
      <section class="auth-frame__panel">
        <div class="auth-frame__card">
          <ng-content />
        </div>
        <p class="auth-frame__foot">Velura ERP · Cổng quản trị vận hành nội bộ</p>
      </section>
    </main>
  `,
  styles: [
    `
      .auth-frame {
        display: grid;
        grid-template-columns: minmax(0, 1.05fr) minmax(min(100%, 420px), 0.95fr);
        min-height: 100dvh;
        background: var(--erp-bg);
      }
      .auth-frame__brand {
        position: relative;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 40px;
        padding: clamp(28px, 5vw, 60px);
        background:
          radial-gradient(circle at 86% 16%, rgba(190, 24, 93, 0.10), transparent 45%),
          radial-gradient(circle at 12% 88%, rgba(157, 23, 77, 0.08), transparent 48%),
          linear-gradient(160deg, #FFF9FB 0%, #FFF1F5 55%, #FCE7EF 100%);
        border-right: 1px solid var(--erp-accent-border);
        color: var(--erp-ink);
      }
      .auth-brand {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .auth-brand img {
        width: 44px;
        height: 44px;
        padding: 4px;
        border-radius: 10px;
        object-fit: contain;
        background: #ffffff;
        border: 1px solid var(--erp-accent-border);
        box-shadow: var(--erp-shadow-sm);
      }
      .auth-brand span {
        display: grid;
        line-height: 1.08;
      }
      .auth-brand strong {
        font-family: var(--erp-brand);
        font-size: 28px;
        font-weight: 700;
        color: var(--erp-ink);
      }
      .auth-brand small {
        color: var(--erp-accent-strong);
        font-size: 10.5px;
        font-weight: 700;
        letter-spacing: 0.16em;
        text-transform: uppercase;
      }
      .auth-frame__eyebrow {
        display: inline-flex;
        width: fit-content;
        padding: 4px 10px;
        border-radius: 999px;
        background: #ffffff;
        border: 1px solid var(--erp-accent-border);
        color: var(--erp-accent-strong);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .auth-frame__pitch {
        display: grid;
        gap: 16px;
        max-width: 38ch;
      }
      .auth-frame__pitch h1 {
        font-family: var(--erp-font);
        font-size: clamp(26px, 3vw, 36px);
        font-weight: 700;
        letter-spacing: -0.025em;
        line-height: 1.18;
        color: var(--erp-ink);
      }
      .auth-frame__pitch p {
        color: #475569;
        font-size: 14.5px;
        line-height: 1.62;
      }
      .auth-frame__points {
        display: grid;
        gap: 12px;
        margin: 0;
        padding: 0;
        list-style: none;
        color: #1E293B;
        font-size: 13.5px;
        font-weight: 500;
      }
      .auth-frame__points li {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .auth-frame__point-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        flex-shrink: 0;
        border-radius: 8px;
        background: #ffffff;
        border: 1px solid var(--erp-accent-border);
        color: var(--erp-accent);
        box-shadow: 0 1px 2px rgba(157, 23, 77, 0.06);
      }
      .auth-frame__panel {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 18px;
        padding: clamp(20px, 4vw, 52px);
      }
      .auth-frame__card {
        width: min(100%, 430px);
        padding: clamp(22px, 3vw, 34px);
        border: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-xl);
        background: var(--erp-surface);
        box-shadow: var(--erp-shadow-md);
      }
      .auth-frame__foot {
        color: var(--erp-muted);
        font-size: 12px;
      }
      @media (max-width: 900px) {
        .auth-frame {
          grid-template-columns: minmax(0, 1fr);
        }
        .auth-frame__brand {
          display: none;
        }
      }
    `,
  ],
})
export class AuthFrame {}
