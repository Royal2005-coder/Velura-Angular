import { InjectionToken, Signal, WritableSignal, inject } from '@angular/core';
import {
  DemoOrder,
  DemoOrderLine,
  DemoReturn,
  DemoReturnLine,
  PurchaseDemoStore,
} from './purchase-demo.store';
import { isPreviewMode } from '../utils/preview-mode';
import { OrderAccountApiStore } from './order-account-api.store';
import { OrderAccountPreviewAdapter } from './order-account-preview.adapter';

/** A replacement variant comes from the original product's current inventory. */
export interface ReplacementChoice { id: string; label: string; stock?: number; }

/** Optional customer reason classification; warehouse inspection remains a separate mandatory proof. */
export type ReturnReasonCode = 'size' | 'color' | 'error' | 'mismatch' | 'damaged' | 'mind_change' | 'other';

/**
 * The Model contract `OrderFlowPage` (KAN-31 presentation) programs against. Two
 * implementations satisfy it: `PurchaseDemoStore` (wrapped by `OrderAccountPreviewAdapter`,
 * `?preview=1` only) and `OrderAccountApiStore` (real API, production). Every mutating member
 * returns a `Promise` so the page calls either Model the same way.
 */
export interface OrderAccountModel {
  readonly orders: Signal<DemoOrder[]>;
  readonly requests: Signal<DemoReturn[]>;
  readonly member: Signal<boolean>;
  readonly userId: Signal<string | null>;
  /** Also doubles as "verified guest contact" for the real Model's `canAccess`. */
  readonly verifiedPhone: WritableSignal<string>;
  /** Return-request stage at and after which self-service cancel (U2-24) is no longer offered. */
  readonly cancellableBeforeStage: number;
  /** Whether the COD refund bank-details step has anywhere real to persist to. */
  readonly supportsBankInfo: boolean;
  /** Real guest lookup requires a verified short-lived phone session. */
  readonly guestOtpRequired?: boolean;
  /** Distinguish unavailable data from a successfully loaded empty list. */
  readonly loading?: Signal<boolean>;
  /** A retryable network or authorization error. */
  readonly error?: Signal<string>;
  /** Fetching current replacement inventory must not be presented as available stock. */
  readonly replacementsLoading?: Signal<boolean>;
  /** A replacement inventory failure is retryable. */
  readonly replacementsError?: Signal<string>;
  /** Refresh persisted data without reloading the browser. */
  refresh?(): Promise<void>;

  canAccess(order: DemoOrder): boolean;
  sendOtp(value: string, mode?: 'phone' | 'code'): Promise<void>;
  verifyOtp(code: string): Promise<void>;
  /**
   * Load a particular guest order using the already verified phone session.
   * Contact alone never authorizes a production lookup or mutation.
   */
  lookupGuest?(code: string, contact: string): Promise<void>;
  cancel(orderId: string, reason: string): Promise<void>;
  /**
   * `evidence` carries the raw `File` alongside its display name so a real Model can upload
   * it; the preview adapter only ever reads `.name` (the demo never uploads anything).
   */
  createReturn(
    orderId: string,
    kind: DemoReturn['kind'],
    items: DemoReturnLine[],
    reason: string,
    evidence: Array<{ name: string; file?: File }>,
    reasonCode?: ReturnReasonCode,
  ): Promise<DemoReturn>;
  cancelRequest(id: string): Promise<void>;
  saveBank(id: string, name: string, account: string, holder: string): Promise<void>;
  replaceUnavailable(id: string, variantId: string, replacement: string): Promise<void>;
  replacements(line: DemoOrderLine): string[];
  /** Load current variants for products belonging to one authorized order. */
  loadReplacementChoices?(orderId: string): Promise<void>;
  /** Present real current variant identities for the selected original line. */
  replacementChoices?(line: DemoOrderLine): ReplacementChoice[];
  timeline(kind: DemoReturn['kind']): string[];
  /** Upserts one order into `orders()` by id/code — real Model only, for cold direct links. */
  ensureOrderLoaded?(id: string): Promise<void>;

  /** Reviewer/QA-only fast-forward tools. No real equivalent; absent outside preview. */
  scenario?(id: string, status: DemoOrder['status'], days?: number): void;
  replacementConflict?(id: string, refund?: boolean): void;
}

/**
 * Selects the order-account Model at the DI boundary: explicit previews use the isolated
 * KAN-31 fixtures, while normal routes use the real KAN-28/KAN-32 HTTP contract.
 */
export const ORDER_ACCOUNT_MODEL = new InjectionToken<OrderAccountModel>('ORDER_ACCOUNT_MODEL', {
  providedIn: 'root',
  factory: () =>
    isPreviewMode()
      ? new OrderAccountPreviewAdapter(inject(PurchaseDemoStore))
      : inject(OrderAccountApiStore),
});
