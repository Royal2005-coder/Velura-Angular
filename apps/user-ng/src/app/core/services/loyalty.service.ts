import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

/** Append-only points movement returned by the authenticated wallet endpoint. */
export interface LoyaltyEntry { entry_id: string; kind: string; points: number; order_id: string | null; expires_at: string | null; created_at: string; }
/** Issuance, consumption and reversal history are server-owned. */
export interface ReferralReward { voucher_id: string; code: string; state: 'issued' | 'used' | 'revoked'; reward_kind: 'referred_registration' | 'referrer_delivery'; expires_at: string; history: Array<{ history_id: string; action: string; created_at: string }>; }
/** Snapshot is informational; checkout locks and reprices the wallet independently. */
export interface LoyaltyWallet {
  balance_points: number; available_points: number; amount_vnd: number; referral_code: string;
  policy: { spending_enabled: boolean; policy_approved_at: string | null; used_reward_reversal_policy: string; used_reward_reversal_approved: boolean };
  expiries: Array<{ points: number; expires_at: string }>;
  history: LoyaltyEntry[];
  referrals: Array<{ attribution_id: string; state: 'pending' | 'qualified' | 'reversed'; created_at: string }>;
  reward_vouchers: ReferralReward[];
}
/** Read-only member Model never awards points or changes referral attribution. */
@Injectable({ providedIn: 'root' })
export class LoyaltyService {
  private readonly api = inject(ApiService);
  /** Load the current actor's snapshot and optionally older entries by the last ledger UUID. */
  wallet(before?: string): Observable<{ success: boolean; wallet: LoyaltyWallet }> {
    return this.api.get<{ success: boolean; wallet: LoyaltyWallet }>(`/api/user/loyalty${before ? `?before=${encodeURIComponent(before)}` : ''}`);
  }
}
