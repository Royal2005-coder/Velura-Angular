import { TestBed } from '@angular/core/testing';
import { ORDER_ACCOUNT_MODEL, type ReturnTrackingDetail } from '../../core/services/order-account.model';
import { ReturnTrackingComponent } from './return-tracking.component';

const detail: ReturnTrackingDetail = {
  returnId: 'r1',
  returnCode: 'RETABC123',
  orderCode: 'VLR-001',
  status: 'WAITING_RETURN',
  statusLabel: 'Chờ khách gửi hàng',
  typeLabel: 'Hoàn tiền',
  canCancel: true,
  canUploadPacking: true,
  customerName: 'Nguyễn A',
  customerPhone: '0900000001',
  customerAddress: '1 Nguyễn Huệ',
  timeline: [
    { eventType: 'shipment', label: 'Đã tạo vận đơn hoàn', at: '2026-10-27T00:00:00Z', carrier: 'GHN', trackingCode: 'GHN123456789' },
  ],
  shipment: {
    carrier: 'GHN',
    trackingCode: 'GHN123456789',
    trackingUrl: 'https://donhang.ghn.vn/?order_code=GHN123456789',
    status: 'label_ready',
    pickupPhotoUrls: [],
  },
  exchangeShipment: null,
  exchangeOrder: null,
  evidence: [],
  instructions: ['Quay video đóng gói.', 'Dán nhãn vận đơn hoàn.'],
};

describe('ReturnTrackingComponent', () => {
  function boot(overrides: Partial<ReturnTrackingDetail> = {}, uploads: string[] = []) {
    const model = {
      member: () => false,
      getReturnTracking: async (_id: string) => ({ ...detail, ...overrides }),
      uploadReturnEvidence: async (_id: string, file: File, kind: string) => {
        uploads.push(`${kind}:${file.name}`);
        return { evidenceId: 'e1', kind, url: 'https://signed.test/evidence.jpg' };
      },
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ReturnTrackingComponent],
      providers: [{ provide: ORDER_ACCOUNT_MODEL, useValue: model }],
    });
    const fixture = TestBed.createComponent(ReturnTrackingComponent);
    fixture.componentRef.setInput('returnId', 'r1');
    fixture.detectChanges();
    return { fixture, component: fixture.componentInstance, model };
  }

  it('renders the real timeline, carrier AWB and return slip code', async () => {
    const { fixture, component } = boot();
    await component.load('r1');
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent || '';

    expect(text).toContain('Chờ khách gửi hàng');
    expect(text).toContain('Đã tạo vận đơn hoàn');
    expect(text).toContain('GHN123456789');
    expect(text).toContain('RETABC123');
    expect(text).toContain('In phiếu gửi hoàn');
  });

  it('uploads packing photos/video to the model and reloads the detail', async () => {
    const uploads: string[] = [];
    const { fixture, component } = boot({}, uploads);
    await fixture.whenStable();

    await component.onPhotos({
      target: { files: [{ name: 'packed.jpg', type: 'image/jpeg', size: 100 }], value: '' },
    } as unknown as Event);
    await component.onVideo({
      target: { files: [{ name: 'packing.mp4', type: 'video/mp4', size: 100 }], value: '' },
    } as unknown as Event);

    expect(uploads).toEqual(['packing_photo:packed.jpg', 'packing_video:packing.mp4']);
    expect(component.uploadNote()).toContain('Đã lưu');
  });

  it('hides the upload block once the carrier has taken the parcel', async () => {
    const { fixture, component } = boot({ status: 'RETURN_IN_TRANSIT', canUploadPacking: false });
    await component.load('r1');
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent || '';

    expect(text).toContain('Bằng chứng đóng gói đã khóa');
    expect(text).not.toContain('Video đóng gói (MP4/WebM');
  });
});
