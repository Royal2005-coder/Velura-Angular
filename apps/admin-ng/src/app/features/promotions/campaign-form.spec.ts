import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { AdminApiService, AdminPromotionRow } from '../../core/admin-api.service';
import { CampaignForm } from './campaign-form';

/** Ghi lại lệnh gọi API để khẳng định form có gửi đi hay không. */
interface ApiCalls {
  create: Record<string, unknown>[];
  update: { promoId: string; body: Record<string, unknown> }[];
}

function stubApi(calls: ApiCalls): AdminApiService {
  return {
    createPromotion: (body: Record<string, unknown>) => {
      calls.create.push(body);
      return of({} as AdminPromotionRow);
    },
    updatePromotion: (promoId: string, body: Record<string, unknown>) => {
      calls.update.push({ promoId, body });
      return of({} as AdminPromotionRow);
    },
    uploadPromotionBanner: () => of({ url: 'https://cdn.velura.vn/a.png' }),
  } as unknown as AdminApiService;
}

/** Dựng một form thật với đúng các trường mà component đọc. */
function buildForm(values: Record<string, string>, isFeatured = false): HTMLFormElement {
  const form = document.createElement('form');
  for (const [name, value] of Object.entries(values)) {
    const input = document.createElement('input');
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.name = 'isFeatured';
  checkbox.checked = isFeatured;
  form.appendChild(checkbox);
  return form;
}

const VALID = {
  name: 'Sale cuối tuần',
  startDate: '2026-10-01T08:00',
  endDate: '2026-10-05T23:00',
  budgetLimit: '10000000',
  description: 'Giảm đến 30%',
  highlightLabel: 'Chỉ còn 2 ngày',
  displayOrder: '1',
  type: 'flash_sale',
};

describe('CampaignForm', () => {
  let calls: ApiCalls;
  let fixture: ComponentFixture<CampaignForm>;

  async function create(campaign: AdminPromotionRow | null, canMutate = true): Promise<CampaignForm> {
    calls = { create: [], update: [] };
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [CampaignForm],
      providers: [{ provide: AdminApiService, useValue: stubApi(calls) }],
    }).compileComponents();
    fixture = TestBed.createComponent(CampaignForm);
    fixture.componentRef.setInput('campaign', campaign);
    fixture.componentRef.setInput('canMutate', canMutate);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  function submit(form: CampaignForm, element: HTMLFormElement): void {
    form.submit({ preventDefault: () => undefined, target: element } as unknown as Event);
  }

  it('bắt đầu ở chế độ tạo khi không có chiến dịch', async () => {
    const form = await create(null);
    expect(form.isEdit()).toBe(false);
    expect(form.title()).toBe('Tạo chiến dịch');
  });

  it('nạp sẵn ảnh banner của chiến dịch đang sửa', async () => {
    // Không nạp thì người vận hành tưởng chiến dịch chưa có ảnh và tải đè lên ảnh khác.
    const form = await create({ promo_id: 'p1', banner_image_url: 'https://cdn.velura.vn/cu.png', version: 3 });
    expect(form.isEdit()).toBe(true);
    expect(form.bannerUrl()).toBe('https://cdn.velura.vn/cu.png');
  });

  it('gửi tạo mới kèm loại chiến dịch', async () => {
    const form = await create(null);
    submit(form, buildForm(VALID, true));
    expect(calls.create.length).toBe(1);
    expect(calls.update.length).toBe(0);
    const body = calls.create[0];
    expect(body['name']).toBe('Sale cuối tuần');
    expect(body['type']).toBe('flash_sale');
    expect(body['isFeatured']).toBe(true);
    expect(body['displayOrder']).toBe(1);
    // Giờ địa phương trong input phải thành ISO trước khi rời trình duyệt.
    expect(String(body['startDate'])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('gửi sửa kèm phiên bản kỳ vọng để chặn ghi đè', async () => {
    const form = await create({ promo_id: 'p1', version: 7 });
    submit(form, buildForm(VALID));
    expect(calls.update.length).toBe(1);
    expect(calls.update[0].promoId).toBe('p1');
    expect(calls.update[0].body['expectedVersion']).toBe(7);
    // Sửa thì không gửi loại: RPC không nhận, và đổi loại sẽ làm lệch các mã đã phát.
    expect(calls.update[0].body['type']).toBeUndefined();
  });

  it('chặn ngày kết thúc không sau ngày bắt đầu', async () => {
    const form = await create(null);
    submit(form, buildForm({ ...VALID, endDate: '2026-10-01T08:00' }));
    expect(calls.create.length).toBe(0);
    expect(form.saveError()).toContain('sau ngày bắt đầu');
  });

  it('chặn tên quá ngắn và ngày để trống', async () => {
    const form = await create(null);
    // Mốc 8 ký tự khớp API và RPC; trước đây form cho qua tên 2 ký tự rồi máy chủ từ chối.
    submit(form, buildForm({ ...VALID, name: 'Sale 9' }));
    expect(calls.create.length).toBe(0);
    expect(form.saveError()).toContain('8 ký tự');

    submit(form, buildForm({ ...VALID, startDate: '' }));
    expect(calls.create.length).toBe(0);
    expect(form.saveError()).toContain('ngày bắt đầu');
  });

  it('chặn hạ ngân sách xuống dưới số tiền đã giảm cho khách', async () => {
    // Trần thấp hơn phần đã phát sẽ khiến bộ đếm tạm dừng chiến dịch ngay lần dùng mã
    // kế tiếp — báo trước còn hơn để người vận hành lưu xong mới thấy chiến dịch tắt.
    const form = await create({ promo_id: 'p1', version: 2, total_discount_issued: 4_000_000 });
    submit(form, buildForm({ ...VALID, budgetLimit: '1000000' }));
    expect(calls.update.length).toBe(0);
    expect(form.saveError()).toContain('4.000.000');

    submit(form, buildForm({ ...VALID, budgetLimit: '4000000' }));
    expect(calls.update.length).toBe(1);
  });

  it('không gửi gì khi vai trò không được ghi', async () => {
    const form = await create(null, false);
    submit(form, buildForm(VALID));
    expect(calls.create.length).toBe(0);
    expect(form.saveError()).toContain('không được sửa');
  });

  it('gỡ ảnh để trống đường dẫn, tức lệnh xoá khi lưu', async () => {
    const form = await create({ promo_id: 'p1', version: 1, banner_image_url: 'https://cdn.velura.vn/cu.png' });
    form.clearBanner();
    expect(form.bannerUrl()).toBe('');
    submit(form, buildForm(VALID));
    expect(calls.update[0].body['bannerImageUrl']).toBe('');
  });

  it('chuyển ISO sang giá trị mà input datetime-local đọc được', async () => {
    const form = await create(null);
    expect(form.toLocalInput(null)).toBe('');
    expect(form.toLocalInput('không phải ngày')).toBe('');
    expect(form.toLocalInput('2026-10-01T08:00:00.000Z')).toMatch(/^2026-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});
