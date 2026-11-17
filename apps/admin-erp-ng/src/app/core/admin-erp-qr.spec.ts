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
  /**
   * Expected values are the output of `createWaybill` (apps/api/src/carrier/carrier-gateway-simulator.ts)
   * for the same inputs, so the client sample label cannot drift from the label the server prints.
   */
  const SERVER_WAYBILLS: ReadonlyArray<{ orderCode: string; orderId?: string; trackingCode: string; qr: string }> = [
    {
      orderCode: 'VLR7F20D76F6',
      trackingCode: 'GHN7F20D76F6',
      qr: 'velura:shipment:1?order=VLR7F20D76F6&carrier=GHN&tracking=GHN7F20D76F6&url=https%3A%2F%2Fdonhang.ghn.vn%2F%3Forder_code%3DGHN7F20D76F6',
    },
    {
      orderCode: 'vl-1001',
      trackingCode: 'GHNVL1001',
      qr: 'velura:shipment:1?order=vl-1001&carrier=GHN&tracking=GHNVL1001&url=https%3A%2F%2Fdonhang.ghn.vn%2F%3Forder_code%3DGHNVL1001',
    },
    {
      orderCode: 'AB',
      trackingCode: 'GHNAB000',
      qr: 'velura:shipment:1?order=AB&carrier=GHN&tracking=GHNAB000&url=https%3A%2F%2Fdonhang.ghn.vn%2F%3Forder_code%3DGHNAB000',
    },
    {
      orderCode: 'X',
      trackingCode: 'GHNX000',
      qr: 'velura:shipment:1?order=X&carrier=GHN&tracking=GHNX000&url=https%3A%2F%2Fdonhang.ghn.vn%2F%3Forder_code%3DGHNX000',
    },
    {
      orderCode: '  vlr 12-ab  ',
      trackingCode: 'GHNVLR12AB',
      qr: 'velura:shipment:1?order=vlr+12-ab&carrier=GHN&tracking=GHNVLR12AB&url=https%3A%2F%2Fdonhang.ghn.vn%2F%3Forder_code%3DGHNVLR12AB',
    },
    {
      orderCode: '',
      trackingCode: 'GHN000',
      qr: 'velura:shipment:1?carrier=GHN&tracking=GHN000&url=https%3A%2F%2Fdonhang.ghn.vn%2F%3Forder_code%3DGHN000',
    },
    {
      orderCode: '',
      orderId: '11111111-2222-4333-8444-555555555555',
      trackingCode: 'GHN555555555',
      qr: 'velura:shipment:1?carrier=GHN&tracking=GHN555555555&url=https%3A%2F%2Fdonhang.ghn.vn%2F%3Forder_code%3DGHN555555555',
    },
  ];

  it('derives the same tracking code, url and label QR as the server waybill', () => {
    for (const sample of SERVER_WAYBILLS) {
      const facts = demoShipmentFacts({ order_code: sample.orderCode, order_id: sample.orderId });
      expect(demoTrackingCode(sample.orderCode, sample.orderId)).toBe(sample.trackingCode);
      expect(facts.trackingCode).toBe(sample.trackingCode);
      expect(facts.trackingUrl).toBe(`https://donhang.ghn.vn/?order_code=${sample.trackingCode}`);
      expect(
        buildShipmentQr({
          orderCode: sample.orderCode || undefined,
          carrier: facts.carrier,
          trackingCode: facts.trackingCode,
          trackingUrl: facts.trackingUrl,
        }),
      ).toBe(sample.qr);
    }
  });

  it('prefers facts already stored on the order and never invents a shipper', () => {
    const facts = demoShipmentFacts({ order_code: 'VLR7F20D76F6' });
    expect(facts).toEqual({
      carrier: 'GHN',
      trackingCode: 'GHN7F20D76F6',
      trackingUrl: 'https://donhang.ghn.vn/?order_code=GHN7F20D76F6',
    });
    expect(demoShipmentFacts({ order_code: 'X', carrier: 'GHN', tracking_code: 'VN9-1' }).trackingCode).toBe('VN9-1');
  });

  it('carries the carrier shipper on a shipment QR round-trip', () => {
    const qr = buildShipmentQr({
      orderCode: 'VLR-1',
      carrier: 'GHN',
      trackingCode: 'GHN42',
      trackingUrl: 'https://donhang.ghn.vn/?order_code=GHN42',
      shipperName: 'Trần Giao',
      shipperPhone: '0909000111',
    });
    const parsed = parseScan(qr);
    expect(parsed.kind).toBe('shipment');
    expect(parsed.shipperName).toBe('Trần Giao');
    expect(parsed.shipperPhone).toBe('0909000111');
  });
});
