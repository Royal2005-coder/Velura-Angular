/**
 * Shows the original Velura cart/account toast used by vanilla JS.
 */
export function showToast(message: string): void {
  let container = document.querySelector('.velura-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'velura-toast-container';
    container.setAttribute(
      'style',
      'position:fixed;bottom:24px;right:24px;z-index:10000;display:flex;flex-direction:column;gap:10px;pointer-events:none;',
    );
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.setAttribute(
    'style',
    "background:rgba(45,39,34,0.95);backdrop-filter:blur(8px);color:#fff;padding:16px 24px;border-radius:8px;font-family:'DM Sans',sans-serif;font-size:0.875rem;font-weight:500;box-shadow:0 8px 30px rgba(0,0,0,0.15);border:1px solid rgba(255,255,255,0.1);transform:translateY(20px);opacity:0;transition:all 0.3s cubic-bezier(0.16,1,0.3,1);pointer-events:auto;",
  );
  toast.textContent = message;
  container.appendChild(toast);
  toast.offsetHeight;
  toast.style.transform = 'translateY(0)';
  toast.style.opacity = '1';
  window.setTimeout(() => {
    toast.style.transform = 'translateY(-10px)';
    toast.style.opacity = '0';
    window.setTimeout(() => toast.remove(), 300);
  }, 3000);
}
