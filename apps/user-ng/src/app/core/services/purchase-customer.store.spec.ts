import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Observable, Subject, of } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { PurchaseCustomerStore } from './purchase-customer.store';

const address = { name: 'Nguyễn Văn A', phone: '0901234567', email: '', province: 'Thành phố Hồ Chí Minh', district: '', ward: 'Phường An Khánh', detail: '12 Nguyễn Hoàng' };

describe('PurchaseCustomerStore persistence and session isolation', () => {
  const session = signal<{ userId: string } | null>({ userId: 'A' });
  const get = vi.fn<() => Observable<Record<string, unknown>>>();
  const patch = vi.fn<(path: string, body: unknown) => Observable<Record<string, unknown>>>();
  beforeEach(() => {
    session.set({ userId: 'A' }); get.mockReset(); patch.mockReset();
    get.mockReturnValue(of({ saved_addresses: [] })); patch.mockReturnValue(of({ success: true }));
    TestBed.configureTestingModule({ providers: [PurchaseCustomerStore,
      { provide: AuthService, useValue: { session } }, { provide: ApiService, useValue: { get, patch } },
    ] });
  });
  afterEach(() => TestBed.resetTestingModule());

  async function create(): Promise<PurchaseCustomerStore> {
    const model = TestBed.inject(PurchaseCustomerStore);
    TestBed.tick(); await Promise.resolve(); return model;
  }

  it('does not restore account A addresses after switching to account B', async () => {
    const model = await create(); const pending = new Subject<Record<string, unknown>>();
    get.mockReturnValueOnce(pending); const load = model.loadAddresses();
    session.set({ userId: 'B' }); TestBed.tick();
    pending.next({ saved_addresses: [{ ...address, id: 'address-A' }] }); await load;
    expect(model.addresses()).toEqual([]);
  });

  it('waits for persisted success and ignores an older profile read after saving', async () => {
    const model = await create(); const pendingRead = new Subject<Record<string, unknown>>();
    get.mockReturnValueOnce(pendingRead); const load = model.loadAddresses();
    const pendingSave = new Subject<Record<string, unknown>>(); patch.mockReturnValueOnce(pendingSave);
    const saving = model.saveAddress(address);
    expect(model.addresses()).toEqual([]);
    pendingSave.next({ success: true }); await saving;
    pendingRead.next({ saved_addresses: [] }); await load;
    expect(model.addresses()[0]).toMatchObject({ ...address, isDefault: true });
    expect(patch).toHaveBeenCalledWith('/api/user/addresses', expect.objectContaining({ addresses: [expect.objectContaining({ ward: address.ward, district: '', detail: address.detail })] }));
  });

  it('rejects a late save from the previous login and prevents overlapping full-book writes', async () => {
    const model = await create(); const pending = new Subject<Record<string, unknown>>(); patch.mockReturnValueOnce(pending);
    const saving = model.saveAddress(address);
    await expect(model.saveAddress({ ...address, detail: 'Other' })).rejects.toThrow('Đang lưu');
    session.set(null); TestBed.tick(); session.set({ userId: 'A' }); TestBed.tick();
    pending.next({ success: true }); await expect(saving).rejects.toThrow('Tài khoản đã thay đổi');
    expect(model.addresses()).toEqual([]);
  });
});
