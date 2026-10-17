import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import type { GeographyDataset, GeographyMode } from '../../core/models/address-geography';
import { AddressGeographyService } from '../../core/services/address-geography.service';
import { AddressSelector } from './address-selector';

const current: GeographyDataset = { mode: 'current', source: 'fixture', retrieved_at: '', provinces: [
  { code: 1, name: 'Thành phố Hà Nội', wards: [{ code: 4, name: 'Phường Ba Đình' }] },
  { code: 79, name: 'Thành phố Hồ Chí Minh', wards: [{ code: 26728, name: 'Xã Châu Pha' }] },
] };
const legacy: GeographyDataset = { mode: 'legacy', source: 'fixture', retrieved_at: '', provinces: [
  { code: 1, name: 'Thành phố Hà Nội', districts: [{ code: 1, name: 'Quận Ba Đình', wards: [{ code: 1, name: 'Phường Phúc Xá' }] }] },
] };

describe('AddressSelector with mocked geography Model', () => {
  const load = vi.fn((mode: GeographyMode) => of(mode === 'current' ? current : legacy));
  beforeEach(async () => {
    load.mockReset();
    load.mockImplementation((mode: GeographyMode) => of(mode === 'current' ? current : legacy));
    await TestBed.configureTestingModule({ imports: [AddressSelector], providers: [
      { provide: AddressGeographyService, useValue: { load } },
    ] }).compileComponents();
  });

  it('restores a current address without inventing a district', () => {
    const fixture = TestBed.createComponent(AddressSelector);
    const receive = vi.fn();
    fixture.componentInstance.selectionChange.subscribe(receive);
    fixture.componentRef.setInput('value', { province: 'Hà Nội', ward: 'Ba Đình', district: '' });
    fixture.detectChanges();
    expect(receive).toHaveBeenLastCalledWith({ province: 'Thành phố Hà Nội', ward: 'Phường Ba Đình', district: '', mode: 'current', valid: true });
    expect(fixture.nativeElement.querySelector('[autocomplete="address-level3"]')).toBeNull();
  });

  it('clears the old ward immediately when its province changes', () => {
    const fixture = TestBed.createComponent(AddressSelector);
    fixture.componentRef.setInput('value', { province: 'Hà Nội', ward: 'Ba Đình' });
    fixture.detectChanges();
    const receive = vi.fn();
    fixture.componentInstance.selectionChange.subscribe(receive);
    const select: HTMLSelectElement = fixture.nativeElement.querySelector('[autocomplete="address-level1"]');
    select.value = '79'; select.dispatchEvent(new Event('change')); fixture.detectChanges();
    expect(fixture.componentInstance.wardCode()).toBe('');
    expect(receive).toHaveBeenLastCalledWith({ province: 'Thành phố Hồ Chí Minh', ward: '', district: '', mode: 'current', valid: false });
    expect(fixture.componentInstance.wards()[0].name).toBe('Xã Châu Pha');
  });

  it('restores legacy children only under their actual parents', () => {
    const fixture = TestBed.createComponent(AddressSelector);
    fixture.componentRef.setInput('value', { province: 'Hà Nội', district: 'Ba Đình', ward: 'Phúc Xá' });
    fixture.detectChanges();
    expect(fixture.componentInstance.mode()).toBe('legacy');
    expect(fixture.componentInstance.ward()?.name).toBe('Phường Phúc Xá');
    fixture.componentRef.setInput('value', { province: 'Hà Nội', district: '', ward: 'Ba Đình' });
    fixture.detectChanges();
    expect(fixture.componentInstance.mode()).toBe('current');
    expect(fixture.componentInstance.districtCode()).toBe('');
  });

  it('ignores a late old dataset after switching schemes', () => {
    const delayed = new Subject<GeographyDataset>();
    load.mockImplementationOnce(() => delayed);
    const fixture = TestBed.createComponent(AddressSelector);
    fixture.detectChanges();
    fixture.componentInstance.changeMode({ target: { value: 'legacy' } } as unknown as Event);
    delayed.next(current);
    expect(fixture.componentInstance.mode()).toBe('legacy');
    expect(fixture.componentInstance.provinces()[0].districts?.length).toBe(1);
  });

  it('offers retry after a load failure and restores the pending saved address', () => {
    const delayed = new Subject<GeographyDataset>();
    load.mockImplementationOnce(() => delayed);
    const fixture = TestBed.createComponent(AddressSelector);
    fixture.componentRef.setInput('value', { province: 'Hà Nội', ward: 'Ba Đình' });
    fixture.detectChanges();
    delayed.error(new Error('offline'));
    expect(fixture.componentInstance.error()).toContain('Thử lại'.toLowerCase());
    fixture.componentInstance.retry();
    expect(fixture.componentInstance.error()).toBe('');
    expect(fixture.componentInstance.ward()?.name).toBe('Phường Ba Đình');
  });
});
