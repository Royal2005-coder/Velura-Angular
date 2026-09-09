import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ProductSummary } from '../../core/models/product.interface';
import { ApiService } from '../../core/services/api.service';
import { ProductCard } from './product-card';

const product: ProductSummary = {
  product_id: 'p1',
  name: 'Áo linen',
  base_price: 200000,
  sale_price: 150000,
  thumbnail_url: '/assets/images/placeholder.jpg',
};

describe('ProductCard', () => {
  it('derives price labels from the product input (presentational)', async () => {
    await TestBed.configureTestingModule({
      imports: [ProductCard],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get: () => of({ items: [] }), post: () => of({}), delete: () => of({}) } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ProductCard);
    fixture.componentRef.setInput('product', product);
    fixture.detectChanges();
    expect(fixture.componentInstance.price()).toBe(150000);
    expect(fixture.componentInstance.oldPrice()).toBe(200000);
    expect(fixture.componentInstance.discountPercent()).toBeGreaterThan(0);
  });
});
