import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ProductSummary } from '../../core/models/product.interface';
import { ApiService } from '../../core/services/api.service';
import { CartStore } from '../../core/services/cart.store';
import { CheckoutStore } from '../../core/services/checkout.store';
import { ProductCard } from './product-card';

const product: ProductSummary = {
  product_id: 'p1',
  name: 'Áo linen',
  base_price: 200000,
  sale_price: 150000,
  thumbnail_url: '/assets/images/placeholder.jpg',
  variants: [
    { variant_id: 'v1', color: 'Đen', size: 'M', stock_quantity: 10, reserved_quantity: 0 },
  ],
};

const outOfStockProduct: ProductSummary = {
  product_id: 'p2',
  name: 'Váy hết hàng',
  base_price: 300000,
  status: 'out_of_stock',
  variants: [
    { variant_id: 'v2', color: 'Trắng', size: 'S', stock_quantity: 0, reserved_quantity: 0 },
  ],
};

describe('ProductCard', () => {
  let router: Router;
  let cart: CartStore;
  let checkout: CheckoutStore;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ProductCard],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get: () => of({ items: [] }), post: () => of({}), delete: () => of({}) } },
      ],
    }).compileComponents();

    router = TestBed.inject(Router);
    cart = TestBed.inject(CartStore);
    checkout = TestBed.inject(CheckoutStore);
  });

  it('derives price labels from the product input (presentational)', () => {
    const fixture = TestBed.createComponent(ProductCard);
    fixture.componentRef.setInput('product', product);
    fixture.detectChanges();
    expect(fixture.componentInstance.price()).toBe(150000);
    expect(fixture.componentInstance.oldPrice()).toBe(200000);
    expect(fixture.componentInstance.discountPercent()).toBeGreaterThan(0);
    expect(fixture.componentInstance.isOutOfStock()).toBe(false);
  });

  it('quick adds product to cart without navigating away', async () => {
    const navigateSpy = vi.spyOn(router, 'navigateByUrl');
    const addItemSpy = vi.spyOn(cart, 'addItem');

    const fixture = TestBed.createComponent(ProductCard);
    fixture.componentRef.setInput('product', product);
    fixture.detectChanges();

    const dummyEvent = new MouseEvent('click');
    await fixture.componentInstance.addToCart(dummyEvent);

    expect(addItemSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        product_id: 'p1',
        variant_id: 'v1',
        quantity: 1,
        unit_price: 150000,
      }),
    );
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('initiates instant checkout and navigates immediately to /checkout/shipping', async () => {
    const navigateSpy = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    const setCheckoutSpy = vi.spyOn(checkout, 'setCheckoutItems');

    const fixture = TestBed.createComponent(ProductCard);
    fixture.componentRef.setInput('product', product);
    fixture.detectChanges();

    const dummyEvent = new MouseEvent('click');
    await fixture.componentInstance.buyNow(dummyEvent);

    expect(setCheckoutSpy).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          product_id: 'p1',
          variant_id: 'v1',
          quantity: 1,
          unit_price: 150000,
        }),
      ],
      'buy_now',
    );
    expect(navigateSpy).toHaveBeenCalledWith('/checkout/shipping');
  });

  it('detects out of stock product and prevents purchase actions', async () => {
    const addItemSpy = vi.spyOn(cart, 'addItem');
    const setCheckoutSpy = vi.spyOn(checkout, 'setCheckoutItems');

    const fixture = TestBed.createComponent(ProductCard);
    fixture.componentRef.setInput('product', outOfStockProduct);
    fixture.detectChanges();

    expect(fixture.componentInstance.isOutOfStock()).toBe(true);

    const dummyEvent = new MouseEvent('click');
    await fixture.componentInstance.addToCart(dummyEvent);
    expect(addItemSpy).not.toHaveBeenCalled();

    await fixture.componentInstance.buyNow(dummyEvent);
    expect(setCheckoutSpy).not.toHaveBeenCalled();
  });
});
