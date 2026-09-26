import { Component, computed, inject, input, output, signal } from '@angular/core';
import { AdminApiService, AdminPromotionRow } from '../../core/admin-api.service';
import { adminErrorMessage } from '../../core/admin-http';

/** Tên chiến dịch tối thiểu, khớp `PROMOTION_NAME_MIN` phía API và `NAME_MIN_8_CHARS` của RPC. */
const CAMPAIGN_NAME_MIN = 8;

/**
 * Form tạo và sửa một chiến dịch khuyến mãi.
 *
 * Trước đây trang khuyến mãi chỉ có hai nút Chạy/Tạm dừng, nghĩa là chiến dịch phải
 * được tạo thẳng trong cơ sở dữ liệu thì người vận hành mới có gì để bật. Form này
 * đóng nốt khoảng đó, kèm phần nội dung hiển thị cho khách trên trang Ưu đãi.
 *
 * Nhận `campaign` là null nghĩa là tạo mới. Loại chiến dịch chỉ đặt được lúc tạo vì
 * RPC sửa không nhận trường đó — đổi loại của một chiến dịch đang chạy sẽ làm lệch
 * cách tính của các mã đã phát ra.
 */
@Component({
  selector: 'app-campaign-form',
  templateUrl: './campaign-form.html',
})
export class CampaignForm {
  private readonly api = inject(AdminApiService);

  /** Chiến dịch đang sửa. Bỏ trống là tạo mới. */
  readonly campaign = input<AdminPromotionRow | null>(null);
  readonly canMutate = input(false);

  readonly saved = output<void>();
  readonly closed = output<void>();

  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);
  readonly uploading = signal(false);
  /** Đường dẫn ảnh banner đang chọn, giữ riêng để xem trước ngay khi tải xong. */
  readonly bannerUrl = signal<string>('');
  readonly labelLength = signal(0);

  readonly isEdit = computed(() => !!this.campaign());
  readonly title = computed(() => (this.isEdit() ? 'Sửa chiến dịch' : 'Tạo chiến dịch'));

  readonly promoTypes = [
    { value: 'product_discount', label: 'Giảm giá sản phẩm' },
    { value: 'flash_sale', label: 'Flash Sale' },
    { value: 'combo_discount', label: 'Giảm giá Combo' },
    { value: 'seasonal_sale', label: 'Giảm giá theo mùa' },
  ];

  /**
   * Đọc sau khi đầu vào đã gắn: ảnh sẵn có của chiến dịch đang sửa phải hiện ngay, nếu
   * không người vận hành sẽ tưởng chiến dịch chưa có banner và tải đè lên ảnh khác.
   */
  ngOnInit(): void {
    this.bannerUrl.set(this.campaign()?.banner_image_url || '');
    this.labelLength.set((this.campaign()?.highlight_label || '').length);
  }

  /** Số tiền đã giảm cho khách — mốc sàn khi hạ ngân sách. */
  readonly issued = computed(() => Number(this.campaign()?.total_discount_issued || 0));

  /** Chuyển ISO sang giá trị mà input datetime-local đọc được (giờ địa phương). */
  toLocalInput(value: string | undefined | null): string {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    const offsetMs = parsed.getTimezoneOffset() * 60_000;
    return new Date(parsed.getTime() - offsetMs).toISOString().slice(0, 16);
  }

  /** Đếm ký tự nhãn nổi bật để người vận hành thấy trước khi chạm trần 60. */
  onLabelInput(event: Event): void {
    this.labelLength.set((event.target as HTMLInputElement).value.length);
  }

  /** Gỡ ảnh banner. Lưu lại sẽ gửi chuỗi rỗng, tức lệnh xoá. */
  clearBanner(): void {
    this.bannerUrl.set('');
  }

  /** Cập nhật URL banner khi nhập tay. */
  onBannerUrlInput(event: Event): void {
    this.bannerUrl.set((event.target as HTMLInputElement).value.trim());
  }

  /** Tải ảnh banner lên kho và điền đường dẫn trả về, tự động tối ưu dung lượng ảnh tránh lỗi 413. */
  async uploadBanner(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const rawFile = input.files?.[0];
    if (!rawFile) return;
    this.uploading.set(true);
    this.saveError.set(null);

    const file = await compressImageForBanner(rawFile);
    this.api.uploadPromotionBanner(file).subscribe({
      next: (result) => {
        this.uploading.set(false);
        this.bannerUrl.set(result.url);
        input.value = '';
      },
      error: (error: unknown) => {
        this.uploading.set(false);
        this.saveError.set(adminErrorMessage(error, 'Không tải được ảnh banner.'));
        input.value = '';
      },
    });
  }

  /** Đóng form. */
  close(): void {
    this.closed.emit();
  }

  /**
   * Lưu chiến dịch.
   *
   * Lúc tạo, chiến dịch luôn ở trạng thái tạm dừng — API đặt is_active = false — nên
   * người vận hành phải bấm Chạy riêng. Lưu nhầm thì không có gì lên sóng.
   */
  submit(event: Event): void {
    event.preventDefault();
    if (!this.canMutate()) {
      this.saveError.set('Vai trò hiện tại không được sửa khuyến mãi.');
      return;
    }
    const form = event.target as HTMLFormElement;
    const read = (field: string): string =>
      ((form.elements.namedItem(field) as HTMLInputElement | null)?.value || '').trim();

    const name = read('name');
    const startLocal = read('startDate');
    const endLocal = read('endDate');
    // Cùng mốc với API và RPC. Chỉ xét lúc tạo: chiến dịch cũ có tên ngắn vẫn phải sửa
    // được các trường khác mà không bị bắt đổi tên.
    if (!this.isEdit() && name.length < CAMPAIGN_NAME_MIN) {
      this.saveError.set(`Tên chiến dịch cần tối thiểu ${CAMPAIGN_NAME_MIN} ký tự.`);
      return;
    }
    if (name.length < 2) {
      this.saveError.set('Tên chiến dịch phải từ 2 ký tự.');
      return;
    }
    if (!startLocal || !endLocal) {
      this.saveError.set('Phải có cả ngày bắt đầu và ngày kết thúc.');
      return;
    }
    const startDate = new Date(startLocal);
    const endDate = new Date(endLocal);
    if (endDate <= startDate) {
      this.saveError.set('Ngày kết thúc phải sau ngày bắt đầu.');
      return;
    }
    const budgetLimit = Number(read('budgetLimit') || 0);
    if (!Number.isFinite(budgetLimit) || budgetLimit < 0) {
      this.saveError.set('Ngân sách phải là số không âm.');
      return;
    }
    // Hạ trần xuống dưới phần đã phát sẽ khiến bộ đếm tạm dừng chiến dịch ngay lần
    // dùng mã kế tiếp. Nói trước ở đây thay vì để người vận hành nhận lỗi từ máy chủ.
    if (this.isEdit() && budgetLimit > 0 && budgetLimit < this.issued()) {
      this.saveError.set(
        `Ngân sách mới thấp hơn ${this.issued().toLocaleString('vi-VN')}₫ đã giảm cho khách. Hãy đặt bằng hoặc cao hơn.`,
      );
      return;
    }

    const payload: Record<string, unknown> = {
      name,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      budgetLimit,
      description: read('description'),
      bannerImageUrl: this.bannerUrl(),
      highlightLabel: read('highlightLabel'),
      displayOrder: Number(read('displayOrder') || 0),
      isFeatured: (form.elements.namedItem('isFeatured') as HTMLInputElement | null)?.checked === true,
    };

    this.saving.set(true);
    this.saveError.set(null);
    const current = this.campaign();
    const promoId = current?.promo_id || current?.promotion_id;
    const request$ =
      current && promoId
        ? this.api.updatePromotion(promoId, { ...payload, expectedVersion: current.version })
        : this.api.createPromotion({ ...payload, type: read('type') || 'product_discount' });

    request$.subscribe({
      next: () => {
        this.saving.set(false);
        this.saved.emit();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.saveError.set(adminErrorMessage(error, 'Không lưu được chiến dịch.'));
      },
    });
  }
}

/** Tối ưu kích thước và dung lượng ảnh banner phía client trước khi upload. */
async function compressImageForBanner(file: File): Promise<File> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return file;
  if (file.size <= 400 * 1024) return file; // Dưới 400KB giữ nguyên

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const maxWidth = 1600;
        const maxHeight = 900;
        let width = img.width;
        let height = img.height;

        if (width > maxWidth || height > maxHeight) {
          if (width / maxWidth > height / maxHeight) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          } else {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(file);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (!blob || blob.size >= file.size) {
              resolve(file);
            } else {
              const compressed = new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), {
                type: 'image/jpeg',
                lastModified: Date.now(),
              });
              resolve(compressed);
            }
          },
          'image/jpeg',
          0.85
        );
      };
      img.onerror = () => resolve(file);
      img.src = e.target?.result as string;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

