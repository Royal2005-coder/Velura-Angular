import {
  buildOrderQrLink,
  buildReturnQrLink,
  buildShipmentQr,
  carrierLabel,
  demoShipmentFacts,
  demoTrackingCode,
  deriveTrackingUrl,
  findCarrier,
  parseScan,
} from './admin-erp-qr';

const ORDER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

describe('QR contracts for orders, shipments and returns', () => {
  it('round-trips a shipment payload with Vietnamese carrier name and a URL with query params', () => {
    const payload = buildShipmentQr({
      orderCode: 'VLR7F20D76F6',
      carrier: 'Giao Hàng Tiết Kiệm',
      trackingCode: 'GHTK-123456',
      trackingUrl: 'https://i.ghtk.vn/GHTK-123456?ref=erp',
    });
    const parsed = parseScan(payload);

    expect(parsed.kind).toBe('shipment');
    expect(parsed.orderCode).toBe('VLR7F20D76F6');
    expect(parsed.carrier).toBe('Giao Hàng Tiết Kiệm');
    expect(parsed.trackingCode).toBe('GHTK-123456');
    expect(parsed.trackingUrl).toBe('https://i.ghtk.vn/GHTK-123456?ref=erp');
  });

  it('reads a carrier label that only contains the tracking code', () => {
    const parsed = parseScan('GHN123456789');
    expect(parsed.kind).toBe('tracking');
    expect(parsed.trackingCode).toBe('GHN123456789');
  });

  it('reads the ERP order link printed on a label and refuses a different order', () => {
    const link = buildOrderQrLink('https://admin-erp.royalai.dev', ORDER_ID, 'VLR7F20D76F6');
    const same = parseScan(link, { orderId: ORDER_ID, orderCode: 'vlr7f20d76f6' });
    expect(same.kind).toBe('order');
    expect(same.orderId).toBe(ORDER_ID);
    expect(same.orderCode).toBe('VLR7F20D76F6');
    expect(same.mismatch).toBeUndefined();

    const wrongOrder = parseScan(link, { orderId: OTHER_ID, orderCode: 'VLR7F20D76F6' });
    expect(wrongOrder.mismatch).toBe('ORDER_MISMATCH');

    const wrongCode = parseScan(link, { orderId: ORDER_ID, orderCode: 'VLR000000001' });
    expect(wrongCode.mismatch).toBe('ORDER_MISMATCH');
  });

  it('reads the return link so the warehouse can open the right slip', () => {
    const link = buildReturnQrLink('https://admin-erp.royalai.dev', OTHER_ID);
    const parsed = parseScan(link);
    expect(parsed.kind).toBe('return');
    expect(parsed.returnId).toBe(OTHER_ID);
  });

  it('reads a JSON shipment label', () => {
    const parsed = parseScan(
      JSON.stringify({ kind: 'shipment', orderCode: 'VLR1', carrier: 'GHN', trackingCode: 'GHN999', trackingUrl: 'https://ghn.vn/' }),
    );
    expect(parsed.kind).toBe('shipment');
    expect(parsed.trackingCode).toBe('GHN999');
    expect(parsed.carrier).toBe('GHN');
  });

  it('rejects text that is not a code instead of filling garbage', () => {
    expect(parseScan('Khách hẹn giao lại vào chiều mai').kind).toBe('unknown');
    expect(parseScan('').kind).toBe('unknown');
    expect(parseScan('https://example.com/other?focus=x').kind).toBe('unknown');
  });

  it('derives the tracking URL from the carrier registry', () => {
    expect(deriveTrackingUrl('GHN', 'GHN123')).toBe('https://donhang.ghn.vn/?order_code=GHN123');
    expect(deriveTrackingUrl('Giao Hàng Tiết Kiệm', 'X1')).toBe('https://i.ghtk.vn/X1');
    expect(deriveTrackingUrl('Viettel Post', 'VT1')).toBe('https://viettelpost.com.vn/');
    expect(deriveTrackingUrl('ĐVVC khác', 'X1')).toBe('');
    expect(deriveTrackingUrl('GHN', '')).toBe('https://ghn.vn/');
  });

  it('normalises carrier input and labels', () => {
    expect(findCarrier('ghn')?.code).toBe('GHN');
    expect(findCarrier('Shopee Express')?.code).toBe('SPX');
    expect(findCarrier('')).toBeUndefined();
    expect(carrierLabel('jtx')).toBe('J&T Express');
    expect(carrierLabel('Nhà xe riêng')).toBe('Nhà xe riêng');
  });
});

describe('demo shipment payload', () => {
  it('derives a stable demo tracking code from the order code', () => {
    expect(demoTrackingCode('VLR7F20D76F6')).toBe('GHN7F20D76F6');
    expect(demoTrackingCode('vl-1001')).toBe('GHNVL1001');
    expect(demoTrackingCode('')).toBe('GHNDEMO00001');
  });

  it('prefers facts already stored on the order', () => {
    expect(demoShipmentFacts({ order_code: 'VLR7F20D76F6' })).toEqual({
      carrier: 'GHN',
      trackingCode: 'GHN7F20D76F6',
      trackingUrl: 'https://donhang.ghn.vn/?order_code=GHN7F20D76F6',
    });
    expect(demoShipmentFacts({ order_code: 'X', carrier: 'GHN', tracking_code: 'VN9-1' }).trackingCode).toBe('VN9-1');
  });
});
