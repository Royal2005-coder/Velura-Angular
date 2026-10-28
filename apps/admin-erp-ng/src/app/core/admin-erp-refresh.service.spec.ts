import { TestBed } from '@angular/core/testing';
import { AdminErpRefreshService } from './admin-erp-refresh.service';

describe('AdminErpRefreshService', () => {
  it('emits one refresh request per call', () => {
    TestBed.resetTestingModule();
    const service = TestBed.inject(AdminErpRefreshService);
    const reload = vi.fn();
    const subscription = service.requests$.subscribe(reload);

    service.request();
    service.request();

    expect(reload).toHaveBeenCalledTimes(2);
    subscription.unsubscribe();
  });
});
