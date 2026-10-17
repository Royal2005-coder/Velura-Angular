import { ProductSummary } from '../../core/models/product.interface';
import { createStorefrontPage } from '../../../testing/storefront-testing';
import { ProductDetailPage } from './product-detail.page';

describe('ProductDetailPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(ProductDetailPage);
    expect(page).toBeTruthy();
  });

  it('hydrates the product signal from CatalogService.getProduct', async () => {
    const page = await createStorefrontPage(ProductDetailPage);
    expect(page.loading()).toBe(false);
    expect(page.product()?.product_id).toBe('p1');
    expect(page.quantity()).toBe(1);
  });

  it('marks a reserved-out variant unavailable and never invents reviews', async () => {
    const page = await createStorefrontPage(ProductDetailPage);
    const product = page.product();
    expect(product).toBeTruthy();
    page.product.set({ ...product!, variants: [{ variant_id: 'reserved', color: 'Black', size: 'M', stock_quantity: 2, reserved_quantity: 2 }], reviews: [] });
    page.selectedColor.set('Black');
    page.selectedSize.set('M');
    expect(page.isOutOfStock()).toBe(true);
    expect(page.stockLabel()).toBe('Hết hàng');
    expect(page.addToCart()).toBe(false);
    expect(page.averageRating()).toBe(0);
  });

  it('manages combo set quantity stepper and scales line items and summary accordingly', async () => {
    const page = await createStorefrontPage(ProductDetailPage);
    const comboProduct = {
      product_id: 'combo-1',
      name: 'Set Áo Linen và Quần Tây',
      slug: 'set-ao-quan',
      base_price: 900000,
      sale_price: 750000,
      is_combo: true,
      combo_components: [
        {
          product_id: 'comp-1',
          name: 'Áo Linen',
          slug: 'ao-linen',
          base_price: 500000,
          quantity: 1,
          variants: [{ variant_id: 'cv1', color: 'Trắng', size: 'M', stock_quantity: 20 }],
        },
        {
          product_id: 'comp-2',
          name: 'Quần Tây',
          slug: 'quan-tay',
          base_price: 400000,
          quantity: 1,
          variants: [{ variant_id: 'cv2', color: 'Đen', size: 'L', stock_quantity: 15 }],
        },
      ],
    };
    page.product.set(comboProduct as unknown as ProductSummary);
    page.comboPicks.set([
      { productId: 'comp-1', color: 'Trắng', size: 'M' },
      { productId: 'comp-2', color: 'Đen', size: 'L' },
    ]);

    expect(page.isCombo()).toBe(true);
    expect(page.quantity()).toBe(1);

    // Summary for quantity 1
    const summary1 = page.comboSummary();
    expect(summary1.setPriceLabel).toContain('750.000');
    expect(summary1.retailLabel).toContain('900.000');

    // Increment combo quantity to 2
    page.increment();
    expect(page.quantity()).toBe(2);

    // Summary for quantity 2
    const summary2 = page.comboSummary();
    expect(summary2.setPriceLabel).toContain('1.500.000');
    expect(summary2.retailLabel).toContain('1.800.000');

    // Decrement combo quantity back to 1
    page.decrement();
    expect(page.quantity()).toBe(1);
  });

  it('locks purchase actions and marks combo out-of-stock when any component has zero stock', async () => {
    const page = await createStorefrontPage(ProductDetailPage);
    const comboProduct = {
      product_id: 'combo-out',
      name: 'Set Áo và Chân Váy Hè',
      slug: 'set-ao-vay',
      base_price: 800000,
      sale_price: 650000,
      is_combo: true,
      combo_components: [
        {
          product_id: 'comp-1',
          name: 'Áo Phông Basic',
          slug: 'ao-phong',
          base_price: 350000,
          quantity: 1,
          variants: [{ variant_id: 'cv1', color: 'Trắng', size: 'M', stock_quantity: 10, reserved_quantity: 0 }],
        },
        {
          product_id: 'comp-2',
          name: 'Chân Váy Xòe',
          slug: 'chan-vay',
          base_price: 450000,
          quantity: 1,
          variants: [{ variant_id: 'cv2', color: 'Be', size: 'S', stock_quantity: 0, reserved_quantity: 0 }],
        },
      ],
    };
    page.product.set(comboProduct as unknown as ProductSummary);
    page.comboPicks.set([
      { productId: 'comp-1', color: 'Trắng', size: 'M' },
      { productId: 'comp-2', color: 'Be', size: 'S' },
    ]);

    expect(page.isCombo()).toBe(true);
    expect(page.comboStock(0)).toBe(10);
    expect(page.comboStock(1)).toBe(0);
    expect(page.comboMaxStock()).toBe(0);
    expect(page.isOutOfStock()).toBe(true);
    expect(page.stockLabel()).toBe('Hết hàng');

    // Attempting to increment should be locked
    const prevQty = page.quantity();
    page.increment();
    expect(page.quantity()).toBe(prevQty);

    // Attempting to buy or add to cart combo should be blocked
    page.addComboToCart();
    page.buyComboNow();
  });

  it('caps combo quantity to maximum available component sets', async () => {
    const page = await createStorefrontPage(ProductDetailPage);
    const comboProduct = {
      product_id: 'combo-limited',
      name: 'Set Đồ Giới Hạn',
      slug: 'set-gioi-han',
      base_price: 1000000,
      is_combo: true,
      combo_components: [
        {
          product_id: 'comp-1',
          name: 'Món 1',
          quantity: 1,
          variants: [{ variant_id: 'cv1', color: 'Đỏ', size: 'F', stock_quantity: 3, reserved_quantity: 0 }],
        },
        {
          product_id: 'comp-2',
          name: 'Món 2',
          quantity: 1,
          variants: [{ variant_id: 'cv2', color: 'Xanh', size: 'F', stock_quantity: 5, reserved_quantity: 0 }],
        },
      ],
    };
    page.product.set(comboProduct as unknown as ProductSummary);
    page.comboPicks.set([
      { productId: 'comp-1', color: 'Đỏ', size: 'F' },
      { productId: 'comp-2', color: 'Xanh', size: 'F' },
    ]);

    expect(page.comboMaxStock()).toBe(3);
    expect(page.maxAvailableStock()).toBe(3);
    expect(page.isOutOfStock()).toBe(false);

    page.increment(); // 2
    page.increment(); // 3
    page.increment(); // should not exceed 3
    expect(page.quantity()).toBe(3);
  });

  it('correctly disables purchase when selecting out-of-stock variant and enables when selecting in-stock variant (TC-ADMIN-02)', async () => {
    const page = await createStorefrontPage(ProductDetailPage);
    const product = {
      product_id: 'dam-da-hoi-lua',
      name: 'Đầm Dạ Hội Lụa Hoàng Gia Velura',
      slug: 'dam-da-hoi-lua-hoang-gia-velura',
      base_price: 1500000,
      sale_price: 1250000,
      variants: [
        {
          variant_id: 'var-red-s',
          color: 'Đỏ Ruby',
          size: 'S',
          stock_quantity: 0,
          reserved_quantity: 0,
        },
        {
          variant_id: 'var-red-m',
          color: 'Đỏ Ruby',
          size: 'M',
          stock_quantity: 15,
          reserved_quantity: 0,
        },
      ],
      reviews: [],
    };
    page.product.set(product as unknown as ProductSummary);

    // 1. Khi chọn Đỏ Ruby - Size S (Tồn kho = 0)
    page.selectColor('Đỏ Ruby');
    page.selectSize('S');

    expect(page.selectedColor()).toBe('Đỏ Ruby');
    expect(page.selectedSize()).toBe('S');
    expect(page.isOutOfStock()).toBe(true);
    expect(page.stockLabel()).toBe('Hết hàng');
    expect(page.addToCart()).toBe(false);

    // 2. Khi chọn Đỏ Ruby - Size M (Tồn kho = 15)
    page.selectSize('M');

    expect(page.selectedSize()).toBe('M');
    expect(page.isOutOfStock()).toBe(false);
    expect(page.stockLabel()).toBe('Còn 15 sản phẩm');
    expect(page.maxAvailableStock()).toBe(15);
    expect(page.addToCart()).toBe(true);
  });

  it('sorts sizes logically from smallest to largest (TC-CART-02)', async () => {
    const page = await createStorefrontPage(ProductDetailPage);
    const product = {
      product_id: 'silk-shirt',
      name: 'Áo Sơ Mi Lụa Cao Cấp',
      variants: [
        { variant_id: 'v-m', color: 'Burgundy Wine', size: 'M', stock_quantity: 20, reserved_quantity: 0 },
        { variant_id: 'v-l', color: 'Burgundy Wine', size: 'L', stock_quantity: 20, reserved_quantity: 0 },
        { variant_id: 'v-xl', color: 'Burgundy Wine', size: 'XL', stock_quantity: 20, reserved_quantity: 0 },
        { variant_id: 'v-xxl', color: 'Burgundy Wine', size: 'XXL', stock_quantity: 20, reserved_quantity: 0 },
        { variant_id: 'v-xs', color: 'Burgundy Wine', size: 'XS', stock_quantity: 20, reserved_quantity: 0 },
        { variant_id: 'v-s', color: 'Burgundy Wine', size: 'S', stock_quantity: 20, reserved_quantity: 0 },
      ],
      images: ['/images/burgundy.jpg'],
      reviews: [],
    };
    page.product.set(product as unknown as ProductSummary);
    page.selectColor('Burgundy Wine');

    expect(page.sizes()).toEqual(['XS', 'S', 'M', 'L', 'XL', 'XXL']);
  });

  it('formats freesize variants as FREE SIZE (TC-CART-04)', async () => {
    const page = await createStorefrontPage(ProductDetailPage);
    expect(page.displaySize('F')).toBe('FREE SIZE');
    expect(page.displaySize('Free')).toBe('FREE SIZE');
    expect(page.displaySize('FREESIZE')).toBe('FREE SIZE');
    expect(page.displaySize('M')).toBe('M');
  });

  it('clicking a thumbnail switches active image without scrambling selected color (TC-CART-02)', async () => {
    const page = await createStorefrontPage(ProductDetailPage);
    const product = {
      product_id: 'shirt-multi',
      name: 'Áo Sơ Mi',
      variants: [
        { variant_id: 'v1', color: 'Trắng', size: 'S', stock_quantity: 10, reserved_quantity: 0 },
        { variant_id: 'v2', color: 'Đen', size: 'S', stock_quantity: 10, reserved_quantity: 0 },
        { variant_id: 'v3', color: 'Be', size: 'S', stock_quantity: 10, reserved_quantity: 0 },
      ],
      images: ['/images/beige-1.jpg', '/images/beige-2.jpg'],
      reviews: [],
    };
    page.product.set(product as unknown as ProductSummary);
    page.selectColor('Be');
    page.selectSize('S');

    expect(page.selectedColor()).toBe('Be');
    expect(page.selectedSize()).toBe('S');

    page.selectImage(1);
    expect(page.activeImage()).toBe(1);
    expect(page.selectedColor()).toBe('Be');
    expect(page.selectedSize()).toBe('S');
  });

  it('provides interactive zoom controls for inspecting fabric details (TC-CART-03)', async () => {
    const page = await createStorefrontPage(ProductDetailPage);
    expect(page.isZoomOpen()).toBe(false);

    page.openImageZoom();
    expect(page.isZoomOpen()).toBe(true);
    expect(page.zoomScale()).toBe(1);

    page.zoomIn();
    expect(page.zoomScale()).toBe(1.5);

    page.zoomIn();
    expect(page.zoomScale()).toBe(2);

    page.zoomOut();
    expect(page.zoomScale()).toBe(1.5);

    page.resetZoom();
    expect(page.zoomScale()).toBe(1);

    page.toggleZoom();
    expect(page.zoomScale()).toBe(2);

    page.closeImageZoom();
    expect(page.isZoomOpen()).toBe(false);
    expect(page.zoomScale()).toBe(1);
  });

  it('blocks purchase and displays out-of-stock when selecting variant with 0 stock (TC-CART-04)', async () => {
    const page = await createStorefrontPage(ProductDetailPage);
    const product = {
      product_id: 'shirt-stock-test',
      name: 'Áo Sơ Mi Lụa Cao Cấp (SP-001)',
      variants: [
        { variant_id: 'v-black-s', color: 'Đen', size: 'S', stock_quantity: 10, reserved_quantity: 0 },
        { variant_id: 'v-black-xl', color: 'Đen', size: 'XL', stock_quantity: 0, reserved_quantity: 0 },
      ],
      reviews: [],
    };
    page.product.set(product as unknown as ProductSummary);
    page.selectColor('Đen');
    page.selectSize('XL');

    expect(page.isOutOfStock()).toBe(true);
    expect(page.stockLabel()).toBe('Hết hàng');
    expect(page.addToCart()).toBe(false);
    expect(page.isSizeOutOfStock('XL')).toBe(true);
    expect(page.isSizeOutOfStock('S')).toBe(false);
  });
});
