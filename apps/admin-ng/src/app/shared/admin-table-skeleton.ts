import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Khung xương của một bảng đang tải.
 *
 * Trước đây khi `loading()` bật, cả thẻ `<table>` bị gỡ khỏi DOM và thay bằng một ô
 * trống cao 180px, nên lúc dữ liệu về thì cả trang nhảy một nhịp. Giữ đúng số cột và
 * số dòng của bảng thật thì chiều cao gần như không đổi, mắt người vận hành không bị
 * giật — và họ thấy ngay hệ thống đang làm việc chứ không phải treo.
 *
 * `rows` nên đặt bằng kích thước trang (mặc định 10) để khung xương cao xấp xỉ bảng thật.
 */
@Component({
  selector: 'app-admin-table-skeleton',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="admin-table-wrap" aria-hidden="true">
      <table class="admin-table admin-data-table">
        <thead>
          <tr>
            @for (header of headerList(); track $index) {
              <th>{{ header }}</th>
            }
          </tr>
        </thead>
        <tbody>
          @for (row of rowList(); track $index) {
            <tr class="admin-table-row-skeleton">
              @for (cell of headerList(); track $index) {
                <td><span class="skeleton-line skeleton-pulse" [class]="widthClass($index)"></span></td>
              }
            </tr>
          }
        </tbody>
      </table>
    </div>
    <p class="admin-note" role="status">Đang tải dữ liệu…</p>
  `,
})
export class AdminTableSkeleton {
  /** Tiêu đề cột của bảng thật, để khung xương trùng số cột. */
  readonly headers = input<readonly string[]>([]);

  /** Số dòng giả, nên bằng kích thước trang. */
  readonly rows = input(10);

  protected readonly headerList = computed(() => this.headers());
  protected readonly rowList = computed(() => Array.from({ length: Math.max(1, this.rows()) }));

  /**
   * Đổi bề rộng từng cột theo chu kỳ để khung xương trông như dữ liệu thật thay vì một
   * dãy vạch dài bằng nhau.
   */
  protected widthClass(index: number): string {
    const widths = ['skeleton-line--name', 'skeleton-line--email', 'skeleton-line--badge', 'skeleton-line--date', 'skeleton-line--role'];
    return widths[index % widths.length];
  }
}
