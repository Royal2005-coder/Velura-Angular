import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { CheckoutStore, type CreatedOrder } from '../../core/services/checkout.store';
import { CheckoutConfirmPage } from './checkout-confirm.page';

describe('Checkout confirmation business gate with mocked Model', () => {
  const verification = new Subject<{ paid?: boolean; payment_status?: string }>();
  async function create(order: CreatedOrder | null, stripeReturn = false) {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [CheckoutConfirmPage],
      providers: [provideRouter([]),
        { provide: CheckoutStore, useValue: { readCreatedOrder: () => order } },
        { provide: ApiService, useValue: { post: () => verification } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(stripeReturn ? { stripe: 'success' } : {}) } } },
      ],
    }).compileComponents();
    return TestBed.createComponent(CheckoutConfirmPage);
  }
  it('allows thanks after an actual COD order identity was created', async () => {
    const fixture = await create({ order_id: 'cod-order', payment_method: 'COD' });
    expect(fixture.componentInstance.canThankCustomer()).toBe(true);
  });
  it('does not thank a direct visitor without a created order', async () => {
    const fixture = await create(null);
    expect(fixture.componentInstance.canThankCustomer()).toBe(false);
  });
  it('ignores the success query until the backend verifies payment', async () => {
    const fixture = await create({ order_id: 'online-order', payment_method: 'STRIPE' }, true);
    expect(fixture.componentInstance.canThankCustomer()).toBe(false);
    verification.next({ paid: false });
    expect(fixture.componentInstance.canThankCustomer()).toBe(false);
    verification.next({ paid: true });
    expect(fixture.componentInstance.canThankCustomer()).toBe(true);
  });
});
