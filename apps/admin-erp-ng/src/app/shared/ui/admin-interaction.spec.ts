import { afterEach, describe, expect, it, vi } from 'vitest';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AdminErpConfirmService } from '../../core/admin-erp-confirm.service';
import { isTopOverlay, pushOverlay } from '../../core/overlay-stack';
import { AdminErpFilterBar } from './admin-filter-bar';
import { AdminErpModal } from './admin-modal';

@Component({
  imports: [AdminErpFilterBar],
  template: `
    <app-erp-filter-bar (apply)="applied = applied + 1">
      <input type="search" class="q" />
      <input type="text" class="actor" />
      <select class="status"><option value="">Tất cả</option><option value="pending">Chờ</option></select>
    </app-erp-filter-bar>
  `,
})
class FilterHost {
  applied = 0;
}

@Component({
  imports: [AdminErpModal],
  template: `<app-erp-modal [open]="true" title="Sửa" [dirty]="dirty()" (closed)="closed = closed + 1"><p>body</p></app-erp-modal>`,
})
class ModalHost {
  readonly dirty = signal(false);
  closed = 0;
}

describe('admin operator interaction contract', () => {
  afterEach(() => vi.useRealTimers());

  it('applies filters on Enter even with several fields, on select change, and once after a typing pause', async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({ imports: [FilterHost] }).compileComponents();
    const fixture = TestBed.createComponent(FilterHost);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(fixture.componentInstance.applied).toBe(1);

    const status = host.querySelector<HTMLSelectElement>('.status')!;
    status.value = 'pending';
    status.dispatchEvent(new Event('change', { bubbles: true }));
    expect(fixture.componentInstance.applied).toBe(2);

    const q = host.querySelector<HTMLInputElement>('.q')!;
    for (const value of ['á', 'áo', 'áo l']) {
      q.value = value;
      q.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // A text field's own change event (blur) must not trigger an extra request.
    q.dispatchEvent(new Event('change', { bubbles: true }));
    expect(fixture.componentInstance.applied).toBe(2);
    vi.advanceTimersByTime(450);
    expect(fixture.componentInstance.applied).toBe(3);
  });

  it('lets only the most recently opened overlay react to Escape', () => {
    const drawer = {};
    const confirm = {};
    const releaseDrawer = pushOverlay(drawer);
    const releaseConfirm = pushOverlay(confirm);
    expect(isTopOverlay(confirm)).toBe(true);
    expect(isTopOverlay(drawer)).toBe(false);
    releaseConfirm();
    expect(isTopOverlay(drawer)).toBe(true);
    releaseDrawer();
  });

  it('asks before discarding unsaved edits and keeps the modal open when the operator declines', async () => {
    await TestBed.configureTestingModule({ imports: [ModalHost] }).compileComponents();
    const fixture = TestBed.createComponent(ModalHost);
    fixture.componentInstance.dirty.set(true);
    fixture.detectChanges();
    const confirm = TestBed.inject(AdminErpConfirmService);
    const close = () => (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[aria-label="Đóng"]')!.click();

    close();
    expect(confirm.pending()?.confirmLabel).toBe('Bỏ thay đổi');
    confirm.answer({ confirmed: false, reason: '' });
    await settle();
    expect(fixture.componentInstance.closed).toBe(0);

    close();
    confirm.answer({ confirmed: true, reason: '' });
    await settle();
    expect(fixture.componentInstance.closed).toBe(1);
  });

  it('closes a clean modal without asking', async () => {
    await TestBed.configureTestingModule({ imports: [ModalHost] }).compileComponents();
    const fixture = TestBed.createComponent(ModalHost);
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[aria-label="Đóng"]')!.click();
    await settle();
    expect(TestBed.inject(AdminErpConfirmService).pending()).toBeNull();
    expect(fixture.componentInstance.closed).toBe(1);
  });
});

/** close() awaits discardChanges() which awaits ask(): flush the whole microtask chain. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}
