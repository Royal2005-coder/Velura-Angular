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
          radial-gradient(circle at 18% 16%, rgba(244, 63, 94, 0.22), transparent 42%),
          radial-gradient(circle at 82% 84%, rgba(190, 24, 93, 0.2), transparent 45%),
          linear-gradient(150deg, #16070E 0%, #1F0A14 55%, #2B0D1C 100%);
        color: #FFFFFF;
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
        font-family: var(--erp-font);
        font-size: 20px;
        font-weight: 700;
        color: #FFFFFF;
      }
      .auth-brand small {
        color: #FB7185;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .auth-frame__eyebrow {
        color: #FB7185;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .auth-frame__pitch {
        display: grid;
        gap: 16px;
        max-width: 34ch;
      }
      .auth-frame__pitch h1 {
        font-family: var(--erp-font);
        font-size: clamp(28px, 3.4vw, 40px);
        font-weight: 700;
        letter-spacing: -0.03em;
        line-height: 1.15;
        color: #FFFFFF;
      }
      .auth-frame__pitch p {
        color: #E2E8F0;
        font-size: 14px;
        line-height: 1.6;
      }
      .auth-frame__points {
        display: grid;
        gap: 10px;
        margin: 0;
        padding: 0;
        list-style: none;
        color: #CBD5E1;
        font-size: 12.5px;
      }
      .auth-frame__points li {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .auth-frame__points span {
        color: #FB7185;
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
