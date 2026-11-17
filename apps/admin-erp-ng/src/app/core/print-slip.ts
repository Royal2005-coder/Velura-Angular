import { toDataURL } from 'qrcode';

/** Nội dung một phiếu in: tiêu đề, QR, bảng thông tin và ghi chú cuối phiếu. */
export interface PrintSlipSpec {
  /** Tiêu đề cửa sổ in. */
  readonly documentTitle: string;
  /** Tiêu đề lớn trên phiếu. */
  readonly title: string;
  /** Dòng hướng dẫn ngay dưới tiêu đề. */
  readonly intro: string;
  /** Mã chữ đậm phía trên QR (mã đơn, mã phiếu). */
  readonly code: string;
  /** Chuỗi được mã hóa trong QR. */
  readonly qrPayload: string;
  /** Mô tả ảnh QR cho trình đọc màn hình. */
  readonly qrAlt: string;
  /** Các dòng tên - giá trị của bảng thông tin. */
  readonly rows: readonly (readonly [label: string, value: unknown])[];
  /** Ghi chú in cuối phiếu. */
  readonly note: string;
  /** Thông báo khi không tạo được QR. */
  readonly qrErrorMessage: string;
}

/** Kết quả in: `null` khi cửa sổ in đã mở, ngược lại là thông báo lỗi tiếng Việt cho toán tử. */
export type PrintSlipResult = string | null;

const POPUP_BLOCKED_MESSAGE = 'Trình duyệt đang chặn cửa sổ in. Cho phép popup rồi thử lại.';

const SLIP_STYLE = `
  body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;margin:24px;color:#2A1A1D}
  .slip{border:2px solid #2A1A1D;border-radius:12px;padding:20px;max-width:440px}
  h1{font-size:18px;margin:0 0 4px} .muted{color:#7A5A62;font-size:12px}
  .code{font-family:ui-monospace,"SFMono-Regular",Consolas,monospace;font-size:15px;font-weight:700;margin:12px 0 4px}
  .qr{display:block;margin:14px auto;width:240px;height:240px}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}
  td{padding:5px 0;vertical-align:top} td:first-child{color:#7A5A62;width:38%}
  .note{margin-top:14px;font-size:12px;line-height:1.5}`;

/**
 * Mở cửa sổ in cho một phiếu có QR (nhãn vận đơn, phiếu gửi hoàn). Mọi nội dung được gán bằng
 * `textContent`, nên dữ liệu khách hàng không thể chèn HTML vào cửa sổ in.
 *
 * @returns `null` khi đã mở cửa sổ in; chuỗi thông báo lỗi khi không tạo được QR hoặc popup bị chặn.
 */
export async function printSlip(spec: PrintSlipSpec): Promise<PrintSlipResult> {
  const qr = await toDataURL(spec.qrPayload, { width: 640, margin: 2, errorCorrectionLevel: 'M' }).catch(() => '');
  if (!qr) return spec.qrErrorMessage;
  const windowRef = window.open('', '_blank', 'width=560,height=780');
  if (!windowRef) return POPUP_BLOCKED_MESSAGE;

  const doc = windowRef.document;
  doc.title = spec.documentTitle;
  const style = doc.createElement('style');
  style.textContent = SLIP_STYLE;
  doc.head.appendChild(style);

  const text = (tag: string, className: string | null, value: string): HTMLElement => {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    element.textContent = value;
    return element;
  };
  const image = doc.createElement('img');
  image.className = 'qr';
  image.src = qr;
  image.alt = spec.qrAlt;

  const table = doc.createElement('table');
  for (const [label, value] of spec.rows) {
    const row = doc.createElement('tr');
    row.append(text('td', null, label), text('td', null, String(value ?? '')));
    table.appendChild(row);
  }

  const slip = doc.createElement('section');
  slip.className = 'slip';
  slip.append(
    text('h1', null, spec.title),
    text('div', 'muted', spec.intro),
    text('div', 'code', spec.code),
    image,
    table,
    text('div', 'note', spec.note),
  );
  doc.body.appendChild(slip);
  windowRef.focus();
  windowRef.setTimeout(() => windowRef.print(), 100);
  return null;
}
