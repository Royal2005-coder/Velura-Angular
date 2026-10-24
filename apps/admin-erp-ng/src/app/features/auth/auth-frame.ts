import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Shared split-screen frame for all ERP auth states.
 */
@Component({
  selector: 'app-auth-frame',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="auth-frame">
      <section class="auth-frame__brand" aria-hidden="true">
        <a class="auth-brand" routerLink="/login" tabindex="-1">
          <img src="/admin-assets/images/logo.png" alt="" />
          <span>
            <strong>Velura</strong>
            <small>ERP Workspace</small>
          </span>
        </a>
        <div class="auth-frame__pitch">
          <span class="auth-frame__eyebrow">Store operations</span>
          <h1>Vận hành cửa hàng trong một workspace.</h1>
          <p>Danh mục, đơn hàng, kho vận, CSKH và phân quyền cùng một nhịp — dữ liệu thật từ API Velura.</p>
        </div>
        <ul class="auth-frame__points">
          <li><span>01</span>Workspace theo vai trò vận hành</li>
          <li><span>02</span>Danh sách dày thông tin, thao tác có kiểm soát</li>
          <li><span>03</span>Audit và trạng thái nghiệp vụ thống nhất</li>
        </ul>
      </section>
      <section class="auth-frame__panel">
        <div class="auth-frame__card">
          <ng-content />
        </div>
        <p class="auth-frame__foot">Velura ERP · Cổng quản trị vận hành</p>
      </section>
    </main>
  `,
  styles: [
    `
      .auth-frame {
        display: grid;
        grid-template-columns: minmax(0, 1.05fr) minmax(420px, 0.95fr);
        min-height: 100vh;
        background: var(--erp-bg);
      }
      .auth-frame__brand {
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 40px;
        padding: clamp(28px, 5vw, 64px);
        background:
          radial-gradient(circle at 18% 16%, rgba(201, 123, 99, 0.28), transparent 38%),
          linear-gradient(150deg, #211d1a 0%, #2b2521 62%, #3a2c25 100%);
        color: var(--erp-sidebar-text);
      }
      .auth-brand {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .auth-brand img {
        width: 42px;
        height: 42px;
        border-radius: 10px;
        object-fit: contain;
        background: var(--erp-surface);
      }
      .auth-brand span {
        display: grid;
        line-height: 1.15;
      }
      .auth-brand strong {
        font-family: var(--erp-display);
        font-size: 22px;
      }
      .auth-brand small {
        color: var(--erp-sidebar-muted);
        font-size: 10px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
      }
      .auth-frame__eyebrow {
        color: var(--erp-accent);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.16em;
        text-transform: uppercase;
      }
      .auth-frame__pitch {
        display: grid;
        gap: 16px;
        max-width: 34ch;
      }
      .auth-frame__pitch h1 {
        font-family: var(--erp-display);
        font-size: clamp(32px, 4vw, 48px);
        font-weight: 600;
        line-height: 1.08;
      }
      .auth-frame__pitch p {
        color: #c9bdb2;
        font-size: 14px;
        line-height: 1.65;
      }
      .auth-frame__points {
        display: grid;
        gap: 10px;
        margin: 0;
        padding: 0;
        list-style: none;
        color: #c9bdb2;
        font-size: 12.5px;
      }
      .auth-frame__points li {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .auth-frame__points span {
        color: var(--erp-accent);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
      }
      .auth-frame__panel {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 18px;
        padding: clamp(24px, 4vw, 52px);
      }
      .auth-frame__card {
        width: min(100%, 430px);
        padding: clamp(24px, 3vw, 34px);
        border: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-lg);
        background: var(--erp-surface);
        box-shadow: var(--erp-shadow-md);
      }
      .auth-frame__foot {
        color: var(--erp-soft);
        font-size: 11px;
      }
      @media (max-width: 900px) {
        .auth-frame {
          grid-template-columns: minmax(0, 1fr);
        }
        .auth-frame__brand {
          gap: 22px;
          padding: 26px 22px;
        }
        .auth-frame__pitch h1 {
          font-size: 30px;
        }
        .auth-frame__points {
          display: none;
        }
        .auth-frame__panel {
          padding: 24px 16px 36px;
        }
        .auth-frame__card {
          box-shadow: none;
        }
      }
    `,
  ],
  host: { class: 'erp-auth-host' },
})
export class AuthFrame {}
