import { DOCUMENT } from '@angular/common';
import { DestroyRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AdminRefreshService } from './admin-refresh.service';

describe('AdminRefreshService', () => {
  afterEach(() => { vi.useRealTimers(); TestBed.resetTestingModule(); });

  it('refreshes visible workspaces and stops polling after their destruction', () => {
    vi.useFakeTimers();
    let destroy = () => {};
    const view = new EventTarget();
    const document = Object.assign(new EventTarget(), { hidden: false, defaultView: view });
    TestBed.configureTestingModule({ providers: [{ provide: DOCUMENT, useValue: document }] });
    const service = TestBed.inject(AdminRefreshService), refresh = vi.fn();
    service.register(refresh, { onDestroy: (callback: () => void) => { destroy = callback; return () => {}; } } as DestroyRef);
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    document.hidden = true;
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    destroy(); document.hidden = false;
    vi.advanceTimersByTime(30_000); view.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes on focus without issuing bursts of duplicate requests', () => {
    vi.useFakeTimers();
    let destroy = () => {};
    const view = new EventTarget();
    const document = Object.assign(new EventTarget(), { hidden: false, defaultView: view });
    TestBed.configureTestingModule({ providers: [{ provide: DOCUMENT, useValue: document }] });
    const service = TestBed.inject(AdminRefreshService), refresh = vi.fn();
    service.register(refresh, { onDestroy: (callback: () => void) => { destroy = callback; return () => {}; } } as DestroyRef);
    view.dispatchEvent(new Event('focus')); view.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_001); view.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(2);
    destroy();
  });
});
