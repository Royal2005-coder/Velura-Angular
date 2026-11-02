/**
 * Official Vietnamese commercial banks and digital payment providers
 * for standardized NAPAS / VietQR payout reconciliation.
 */
export interface VietnamBank {
  code: string;
  shortName: string;
  name: string;
}

export const VIETNAM_BANKS: readonly VietnamBank[] = [
  { code: 'VCB', shortName: 'Vietcombank', name: 'Ngân hàng TMCP Ngoại Thương Việt Nam' },
  { code: 'BIDV', shortName: 'BIDV', name: 'Ngân hàng TMCP Đầu tư và Phát triển Việt Nam' },
  { code: 'CTG', shortName: 'VietinBank', name: 'Ngân hàng TMCP Công Thương Việt Nam' },
  { code: 'VBA', shortName: 'Agribank', name: 'Ngân hàng Nông nghiệp và Phát triển Nông thôn VN' },
  { code: 'MB', shortName: 'MBBank', name: 'Ngân hàng TMCP Quân đội' },
  { code: 'TCB', shortName: 'Techcombank', name: 'Ngân hàng TMCP Kỹ Thương Việt Nam' },
  { code: 'ACB', shortName: 'ACB', name: 'Ngân hàng TMCP Á Châu' },
  { code: 'VPB', shortName: 'VPBank', name: 'Ngân hàng TMCP Việt Nam Thịnh Vượng' },
  { code: 'TPB', shortName: 'TPBank', name: 'Ngân hàng TMCP Tiên Phong' },
  { code: 'STB', shortName: 'Sacombank', name: 'Ngân hàng TMCP Sài Gòn Thương Tín' },
  { code: 'VIB', shortName: 'VIB', name: 'Ngân hàng TMCP Quốc tế Việt Nam' },
  { code: 'HDB', shortName: 'HDBank', name: 'Ngân hàng TMCP Phát triển TP.HCM' },
  { code: 'SHB', shortName: 'SHB', name: 'Ngân hàng TMCP Sài Gòn - Hà Nội' },
  { code: 'MSB', shortName: 'MSB', name: 'Ngân hàng TMCP Hàng Hải Việt Nam' },
  { code: 'OCB', shortName: 'OCB', name: 'Ngân hàng TMCP Phương Đông' },
  { code: 'LPB', shortName: 'LPBank', name: 'Ngân hàng TMCP Lộc Phát Việt Nam (Bưu Điện Liên Việt)' },
  { code: 'SEAB', shortName: 'SeABank', name: 'Ngân hàng TMCP Đông Nam Á' },
  { code: 'EIB', shortName: 'Eximbank', name: 'Ngân hàng TMCP Xuất Nhập Khẩu Việt Nam' },
  { code: 'BAB', shortName: 'BacABank', name: 'Ngân hàng TMCP Bắc Á' },
  { code: 'NAB', shortName: 'NamABank', name: 'Ngân hàng TMCP Nam Á' },
  { code: 'KLB', shortName: 'Kienlongbank', name: 'Ngân hàng TMCP Kiên Long' },
  { code: 'BVB', shortName: 'BaoVietBank', name: 'Ngân hàng TMCP Bảo Việt' },
  { code: 'PVC', shortName: 'PVcomBank', name: 'Ngân hàng TMCP Đại Chúng Việt Nam' },
  { code: 'SAIGONBANK', shortName: 'Saigonbank', name: 'Ngân hàng TMCP Sài Gòn Công Thương' },
  { code: 'VIETBANK', shortName: 'VietBank', name: 'Ngân hàng TMCP Việt Nam Thương Tín' },
  { code: 'ABB', shortName: 'ABBANK', name: 'Ngân hàng TMCP An Bình' },
  { code: 'NCB', shortName: 'NCB', name: 'Ngân hàng TMCP Quốc Dân' },
  { code: 'PGB', shortName: 'PGBank', name: 'Ngân hàng TMCP Thịnh vượng và Phát triển' },
  { code: 'CAKE', shortName: 'Cake', name: 'Ngân hàng số Cake by VPBank' },
  { code: 'TIMO', shortName: 'Timo', name: 'Ngân hàng số Timo by BVBank' },
  { code: 'VIETTELMONEY', shortName: 'ViettelMoney', name: 'Viettel Money' },
  { code: 'VNPTPAY', shortName: 'VNPTMoney', name: 'VNPT Money' },
  { code: 'MOMO', shortName: 'MoMo', name: 'Ví điện tử MoMo' },
  { code: 'ZALOPAY', shortName: 'ZaloPay', name: 'Ví điện tử ZaloPay' },
];
