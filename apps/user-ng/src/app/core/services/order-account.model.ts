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

  canAccess(order: DemoOrder): boolean;
  sendOtp(phone: string): Promise<void>;
  verifyOtp(code: string): Promise<void>;
  /**
   * Real guest lookup is one request (code + contact), no challenge step — there is no OTP
   * endpoint to send/verify against for order lookup. When present, the page calls this
   * instead of `sendOtp`/`verifyOtp` and skips the `'otp'` view entirely.
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
  ): Promise<DemoReturn>;
  cancelRequest(id: string): Promise<void>;
  saveBank(id: string, name: string, account: string, holder: string): Promise<void>;
  replaceUnavailable(id: string, variantId: string, replacement: string): Promise<void>;
  replacements(line: DemoOrderLine): string[];
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
