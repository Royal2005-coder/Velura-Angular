import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { AdminApiService, AdminCategoryRow, AdminPromotionRow, AdminVoucherRow } from '../../core/admin-api.service';
import { VoucherForm, flattenCategoryTree } from './voucher-form';

interface ApiCalls {
  create: Record<string, unknown>[];
  update: { voucherId: string; body: Record<string, unknown> }[];
}

function stubApi(calls: ApiCalls, fail = false): AdminApiService {
  return {
    createVoucher: (body: Record<string, unknown>) => {
      calls.create.push(body);
      return fail
        ? throwError(() => ({ error: { error: { message: 'Mã này đã tồn tại. Chọn một mã khác.' } } }))
        : of({});
    },
    updateVoucher: (voucherId: string, body: Record<string, unknown>) => {
      calls.update.push({ voucherId, body });
      return of({} as AdminVoucherRow);
    },
  } as unknown as AdminApiService;
}

/** Dựng một form thật với đúng các trường mà component đọc. */
function buildForm(values: Record<string, string>): HTMLFormElement {
  const form = document.createElement('form');
  for (const [name, value] of Object.entries(values)) {
    const input = document.createElement('input');
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  return form;
}

function submitWith(component: VoucherForm, values: Record<string, string>): void {
  const form = buildForm(values);
  component.submit({ preventDefault: () => undefined, target: form } as unknown as Event);
}

const VALID = {
  code: 'giam50k',
  name: 'Giảm 50.000đ',
  value: '50000',
  minOrderValue: '500000',
  maxUses: '100',
  maxPerUser: '1',
  startDate: '2026-10-01T08:00',
  endDate: '2026-10-31T23:00',
  applicableUserGroup: 'all_users',
};

const CAMPAIGNS: AdminPromotionRow[] = [
  { promo_id: 'p-full', promo_name: 'Sale 10.10', max_vouchers_allowed: 2, voucher_count: 2 },
  { promo_id: 'p-open', promo_name: 'Sale cuối năm', max_vouchers_allowed: 5, voucher_count: 3 },
];

const CATEGORIES: AdminCategoryRow[] = [
  { category_id: 'c-ao-thun', name: 'Áo thun', parent_id: 'c-ao' },
  { category_id: 'c-quan', name: 'Quần', parent_id: null },
  { category_id: 'c-ao', name: 'Áo', parent_id: null },
];

describe('VoucherForm', () => {
  let calls: ApiCalls;
  let fixture: ComponentFixture<VoucherForm>;

  async function create(voucher: AdminVoucherRow | null, options: { fail?: boolean } = {}): Promise<VoucherForm> {
    calls = { create: [], update: [] };
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [VoucherForm],
      providers: [{ provide: AdminApiService, useValue: stubApi(calls, options.fail) }],
    }).compileComponents();
    fixture = TestBed.createComponent(VoucherForm);
    fixture.componentRef.setInput('voucher', voucher);
    fixture.componentRef.setInput('campaigns', CAMPAIGNS);
    fixture.componentRef.setInput('categories', CATEGORIES);
    fixture.componentRef.setInput('canMutate', true);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  it('tạo mã gửi mã viết hoa, không danh mục thì để trống hẳn', async () => {
    const component = await create(null);
    submitWith(component, VALID);
    expect(calls.create.length).toBe(1);
    const body = calls.create[0];
    expect(body['code']).toBe('GIAM50K');
    expect(body['type']).toBe('fixed_amount');
    expect(body['value']).toBe(50000);
    expect(body['maxUses']).toBe(100);
    expect(body['applicableCategories']).toBeNull();
    expect(body['promoId']).toBeNull();
  });

  it('mã có dấu hoặc khoảng trắng bị chặn trước khi gọi API', async () => {
    const component = await create(null);
    submitWith(component, { ...VALID, code: 'giảm 50' });
    expect(calls.create.length).toBe(0);
    expect(component.saveError()).toContain('3 đến 30 ký tự');
  });

  it('phần trăm trên 100 bị chặn ngay trên form', async () => {
    const component = await create(null);
    component.discountType.set('percentage');
    submitWith(component, { ...VALID, value: '120' });
    expect(calls.create.length).toBe(0);
    expect(component.saveError()).toContain('100%');
  });

  it('ô giảm tối đa chỉ hiện với mã phần trăm', async () => {
    const component = await create(null);
    expect(fixture.nativeElement.querySelector('input[name="maxDiscount"]')).toBeNull();
    component.discountType.set('percentage');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('input[name="maxDiscount"]')).not.toBeNull();
  });

  it('chọn chiến dịch cha thì thấy trước còn phát được bao nhiêu mã', async () => {
    const component = await create(null);
    component.promoId.set('p-open');
    expect(component.campaignCapacity()).toContain('còn phát được 2 mã');
    component.promoId.set('p-full');
    expect(component.campaignFull()).toBe(true);
    submitWith(component, VALID);
    expect(calls.create.length).toBe(0);
    expect(component.saveError()).toContain('đủ số mã tối đa');
  });

  it('sửa mã gửi đúng phiên bản, không gửi lại mã, và gửi cờ xoá khi bỏ trống tổng lượt', async () => {
    const component = await create({
      voucher_id: 'v1',
      code: 'GIAM50K',
      discount_type: 'fixed_amount',
      discount_value: 50000,
      usage_limit_total: 100,
      used_count: 3,
      promo_id: 'p-open',
      applicable_categories: ['c-ao'],
      version: 4,
    });
    submitWith(component, { ...VALID, maxUses: '' });
    expect(calls.update.length).toBe(1);
    const { voucherId, body } = calls.update[0];
    expect(voucherId).toBe('v1');
    expect(body['expectedVersion']).toBe(4);
    expect(body['code']).toBeUndefined();
    expect(body['clearMaxUses']).toBe(true);
    expect(body['applicableCategories']).toEqual(['c-ao']);
    expect(body['clearPromo']).toBe(false);
  });

  it('không cho hạ tổng lượt xuống dưới số lượt đã dùng', async () => {
    const component = await create({ voucher_id: 'v1', code: 'X', discount_type: 'fixed_amount', used_count: 12, version: 1 });
    submitWith(component, { ...VALID, maxUses: '10' });
    expect(calls.update.length).toBe(0);
    expect(component.saveError()).toContain('12 lượt');
  });

  it('lỗi từ API hiện nguyên câu báo, form không đóng', async () => {
    let saved = false;
    const component = await create(null, { fail: true });
    component.saved.subscribe(() => (saved = true));
    submitWith(component, VALID);
    expect(saved).toBe(false);
    expect(component.saving()).toBe(false);
    expect(component.saveError()).toBeTruthy();
  });

  it('cây danh mục xếp cha trước con và thụt lề theo độ sâu', () => {
    const options = flattenCategoryTree(CATEGORIES);
    expect(options.map((option) => [option.name, option.depth])).toEqual([
      ['Áo', 0],
      ['Áo thun', 1],
      ['Quần', 0],
    ]);
  });
});
