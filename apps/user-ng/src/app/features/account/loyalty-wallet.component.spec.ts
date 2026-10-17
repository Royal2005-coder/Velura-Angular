import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, Subject } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { LoyaltyService, type LoyaltyWallet } from '../../core/services/loyalty.service';
import { LoyaltyWalletComponent } from './loyalty-wallet.component';

const wallet: LoyaltyWallet = { balance_points: 10.5, available_points: 10, amount_vnd: 10500, referral_code: 'VLR0123456789ABCDEF', policy: { spending_enabled: false, policy_approved_at: null, used_reward_reversal_policy: 'manual_review', used_reward_reversal_approved: true }, expiries: [], history: [], referrals: [], reward_vouchers: [] };
describe('LoyaltyWalletComponent', () => {
  it('discards a wallet response after identity changes and keeps no previous referral link', () => {
    const session = signal({ userId: 'first' });
    const old = new Subject<{ success: boolean; wallet: LoyaltyWallet }>();
    const load = vi.fn().mockReturnValueOnce(old).mockReturnValue(of({ success: true, wallet: { ...wallet, referral_code: 'second-code', balance_points: -2, available_points: 0 } }));
    TestBed.configureTestingModule({ imports: [LoyaltyWalletComponent], providers: [provideRouter([]), { provide: LoyaltyService, useValue: { wallet: load } }, { provide: AuthService, useValue: { session, isLoggedIn: () => true } }] });
    const fixture = TestBed.createComponent(LoyaltyWalletComponent);
    fixture.detectChanges();
    session.set({ userId: 'second' }); fixture.detectChanges();
    old.next({ success: true, wallet });
    expect(fixture.componentInstance.wallet()?.referral_code).toBe('second-code');
    expect(fixture.componentInstance.referralLink()).not.toContain(wallet.referral_code);
    expect(fixture.componentInstance.wallet()?.balance_points).toBe(-2);
  });
  it('uses the last ledger entry UUID as the history cursor without inventing a new balance', () => {
    const history = Array.from({ length: 50 }, (_, index) => ({ entry_id: `ledger-${index}`, kind: 'earned', points: 1, order_id: null, expires_at: null, created_at: '2026-10-01T00:00:00Z' }));
    const load = vi.fn().mockReturnValueOnce(of({ success: true, wallet: { ...wallet, history } })).mockReturnValueOnce(of({ success: true, wallet }));
    TestBed.configureTestingModule({ imports: [LoyaltyWalletComponent], providers: [provideRouter([]), { provide: LoyaltyService, useValue: { wallet: load } }, { provide: AuthService, useValue: { session: signal(null), isLoggedIn: () => true } }] });
    const fixture = TestBed.createComponent(LoyaltyWalletComponent); fixture.detectChanges();
    fixture.componentInstance.older();
    expect(load).toHaveBeenLastCalledWith('ledger-49');
    expect(fixture.componentInstance.wallet()?.balance_points).toBe(10.5);
    expect(fixture.componentInstance.wallet()?.history.length).toBe(50);
    expect(fixture.componentInstance.hasOlder()).toBe(false);
  });
});
