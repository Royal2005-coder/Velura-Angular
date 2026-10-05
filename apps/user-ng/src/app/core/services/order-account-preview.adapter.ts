import { signal } from '@angular/core';
import { ComboComponentItem, DemoOrder, DemoOrderLine, DemoReturn, DemoReturnLine, PurchaseDemoStore } from './purchase-demo.store';
import type { OrderAccountModel } from './order-account.model';

/**
 * Wraps `PurchaseDemoStore` to satisfy the Promise-based `OrderAccountModel` interface,
 * without changing the store itself — its synchronous throw-on-error methods are adapted
 * here, one call at a time, so `purchase-demo.store.spec.ts` stays exactly as it was.
 */
export class OrderAccountPreviewAdapter implements OrderAccountModel {
  readonly orders;
  readonly requests;
  readonly member;
  readonly userId;
  readonly verifiedPhone;
  readonly maskedEmail = signal('');
  readonly cancellableBeforeStage;
  readonly supportsBankInfo;

  constructor(private readonly demo: PurchaseDemoStore) {
    this.orders = demo.orders;
    this.requests = demo.requests;
    this.member = demo.member;
    this.userId = demo.userId;
    this.verifiedPhone = demo.verifiedPhone;
    this.cancellableBeforeStage = demo.cancellableBeforeStage;
    this.supportsBankInfo = demo.supportsBankInfo;
  }

  /** Delegates preview ownership checks to the isolated fixture store. */
  canAccess(order: DemoOrder): boolean {
    return this.demo.canAccess(order);
  }

  /** Adapts synchronous preview OTP delivery to the asynchronous Model contract. */
  sendOtp(phone: string): Promise<void> {
    return this.settle(() => this.demo.sendOtp(phone));
  }

  /** Adapts synchronous preview OTP verification to the asynchronous Model contract. */
  verifyOtp(code: string): Promise<void> {
    return this.settle(() => this.demo.verifyOtp(code));
  }

  /** Adapts preview order cancellation without touching the real API. */
  cancel(orderId: string, reason: string): Promise<void> {
    return this.settle(() => this.demo.cancel(orderId, reason));
  }

  /** Creates a fixture-only return while preserving the shared page contract. */
  createReturn(
    orderId: string,
    kind: DemoReturn['kind'],
    items: DemoReturnLine[],
    reason: string,
    evidence: Array<{ name: string; file?: File }>,
  ): Promise<DemoReturn> {
    return this.settle(() =>
      this.demo.createReturn(orderId, kind, items, reason, evidence.map((item) => item.name)),
    );
  }

  /** Cancels a fixture-only return request. */
  cancelRequest(id: string): Promise<void> {
    return this.settle(() => this.demo.cancelRequest(id));
  }

  /** Stores masked fixture bank details for preview demonstrations only. */
  saveBank(id: string, name: string, account: string, holder: string): Promise<void> {
    return this.settle(() => this.demo.saveBank(id, name, account, holder));
  }

  /** Changes a fixture replacement choice for preview demonstrations only. */
  replaceUnavailable(id: string, variantId: string, replacement: string): Promise<void> {
    return this.settle(() => this.demo.replaceUnavailable(id, variantId, replacement));
  }

  /** Lists fixture replacement choices. */
  replacements(line: DemoOrderLine): string[] {
    return this.demo.replacements(line);
  }

  /** Lists fixture combo component choices. */
  comboComponents(line: DemoOrderLine): ComboComponentItem[] {
    return this.demo.comboComponents(line);
  }

  /** Lists the richer fixture timeline without claiming it is persisted. */
  timeline(kind: DemoReturn['kind']): string[] {
    return this.demo.timeline(kind);
  }

  /** Moves a preview order between fixture scenarios for reviewer testing. */
  scenario(id: string, status: DemoOrder['status'], days = 0): void {
    this.demo.scenario(id, status, days);
  }

  /** Simulates a fixture replacement-stock conflict for reviewer testing. */
  replacementConflict(id: string, refund = false): void {
    this.demo.replacementConflict(id, refund);
  }

  /** `PurchaseDemoStore` methods throw synchronously on failure; turn that into a rejected Promise. */
  private settle<T>(run: () => T): Promise<T> {
    try {
      return Promise.resolve(run());
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
