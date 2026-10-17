import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { OffersService } from './offers.service';
import type { OffersResponse } from '../models/offer.interface';

describe('OffersService identity cache', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('does not reuse another account or a previous login of the same account', () => {
    const session = signal<unknown>({ userId: 'A' });
    const get = vi.fn().mockReturnValue(of({ success: true }));
    TestBed.configureTestingModule({ providers: [
      { provide: ApiService, useValue: { get } },
      { provide: AuthService, useValue: { session } },
    ] });
    const model = TestBed.inject(OffersService);
    const first = model.load();
    expect(model.load()).toBe(first);
    session.set({ userId: 'B' });
    expect(model.load()).not.toBe(first);
    session.set({ userId: 'A' });
    expect(model.load()).not.toBe(first);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('does not invalidate a newer account cache when an old request fails', () => {
    const old = new Subject<OffersResponse>();
    const session = signal<unknown>({ userId: 'A' });
    const get = vi.fn().mockReturnValueOnce(old).mockReturnValue(of({ success: true }));
    TestBed.configureTestingModule({ providers: [
      { provide: ApiService, useValue: { get } },
      { provide: AuthService, useValue: { session } },
    ] });
    const model = TestBed.inject(OffersService);
    model.load().subscribe();
    session.set({ userId: 'B' });
    const current = model.load();
    current.subscribe();
    old.error(new Error('Old request failed'));
    expect(model.load()).toBe(current);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not publish personalized offers that arrive after the customer switches account', () => {
    const response = new Subject<OffersResponse>();
    const session = signal<unknown>({ userId: 'A' });
    TestBed.configureTestingModule({ providers: [
      { provide: ApiService, useValue: { get: () => response } },
      { provide: AuthService, useValue: { session } },
    ] });
    const received: OffersResponse[] = [];
    TestBed.inject(OffersService).load().subscribe((value) => received.push(value));
    session.set({ userId: 'B' });
    response.next({ success: true, is_member: true, generated_at: '', campaigns: [], featured: [], vouchers: [], birthday_prompt: { title: 'Private', description: '', action_label: '', action_route: '/account/profile' } });
    expect(received[0].is_member).toBe(false);
    expect(received[0].birthday_prompt).toBeNull();
  });
});
