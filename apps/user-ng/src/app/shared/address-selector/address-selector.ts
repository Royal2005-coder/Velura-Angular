import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import type { AddressGeographySelection, AddressGeographyValue, GeographyMode, GeographyUnit } from '../../core/models/address-geography';
import { AddressGeographyService } from '../../core/services/address-geography.service';

let nextId = 0;

/** Dependent address selection with an explicit compatibility mode for saved old addresses. */
@Component({
  selector: 'app-address-selector',
  templateUrl: './address-selector.html',
  styleUrl: './address-selector.scss',
})
export class AddressSelector {
  private readonly model = inject(AddressGeographyService);
  private readonly destroyRef = inject(DestroyRef);
  readonly value = input<AddressGeographyValue>({});
  readonly selectionChange = output<AddressGeographySelection>();
  readonly id = `delivery-geography-${++nextId}`;
  readonly mode = signal<GeographyMode>('current');
  readonly provinces = signal<GeographyUnit[]>([]);
  readonly provinceCode = signal('');
  readonly districtCode = signal('');
  readonly wardCode = signal('');
  readonly loading = signal(false);
  readonly error = signal('');
  readonly restoreNotice = signal('');
  readonly province = computed(() => this.provinces().find((unit) => String(unit.code) === this.provinceCode()));
  readonly districts = computed(() => this.mode() === 'legacy' ? this.province()?.districts ?? [] : []);
  readonly district = computed(() => this.districts().find((unit) => String(unit.code) === this.districtCode()));
  readonly wards = computed(() => this.mode() === 'legacy' ? this.district()?.wards ?? [] : this.province()?.wards ?? []);
  readonly ward = computed(() => this.wards().find((unit) => String(unit.code) === this.wardCode()));
  private signature = '';
  private request: Subscription | undefined;
  private generation = 0;
  private pending: AddressGeographyValue = {};

  constructor() {
    effect(() => {
      const value = this.value();
      const signature = JSON.stringify([value.province || '', value.district || '', value.ward || '']);
      if (signature === this.signature) return;
      this.signature = signature;
      this.pending = { ...value };
      const mode = value.district ? 'legacy' : 'current';
      // Only external address changes restore saved values; synchronous cached loads
      // must not subscribe this effect to the user's local selection signals.
      untracked(() => this.load(mode));
    });
  }

  /** Changing administrative schemes clears all incompatible selections. */
  changeMode(event: Event): void {
    const mode = (event.target as HTMLSelectElement).value === 'legacy' ? 'legacy' : 'current';
    this.pending = {};
    this.load(mode);
  }

  /** Changing a parent immediately clears its children before announcing the new value. */
  selectProvince(event: Event): void {
    this.provinceCode.set((event.target as HTMLSelectElement).value);
    this.districtCode.set('');
    this.wardCode.set('');
    this.restoreNotice.set('');
    this.publish();
  }

  /** A legacy district change invalidates the previously selected ward. */
  selectDistrict(event: Event): void {
    this.districtCode.set((event.target as HTMLSelectElement).value);
    this.wardCode.set('');
    this.publish();
  }

  /** Only a ward from the selected parent can complete the address. */
  selectWard(event: Event): void {
    this.wardCode.set((event.target as HTMLSelectElement).value);
    this.publish();
  }

  /** Retry the failed snapshot without changing the user's pending address. */
  retry(): void { this.load(this.mode()); }

  private load(mode: GeographyMode): void {
    this.request?.unsubscribe();
    const generation = ++this.generation;
    this.mode.set(mode);
    this.loading.set(true);
    this.error.set('');
    this.restoreNotice.set('');
    this.provinces.set([]);
    this.provinceCode.set('');
    this.districtCode.set('');
    this.wardCode.set('');
    this.signature = JSON.stringify([this.pending.province || '', this.pending.district || '', this.pending.ward || '']);
    this.selectionChange.emit({ province: this.pending.province || '', district: this.pending.district || '', ward: this.pending.ward || '', mode, valid: false });
    this.request = this.model.load(mode).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (dataset) => {
        if (generation !== this.generation) return;
        this.provinces.set(dataset.provinces);
        this.loading.set(false);
        this.restore();
      },
      error: () => {
        if (generation !== this.generation) return;
        this.loading.set(false);
        this.error.set('Chưa tải được danh sách địa chỉ. Vui lòng thử lại.');
      },
    });
  }

  private restore(): void {
    const find = (units: GeographyUnit[], name: string | undefined) => units.find((unit) => normalize(unit.name) === normalize(name || ''));
    const province = find(this.provinces(), this.pending.province);
    this.provinceCode.set(province ? String(province.code) : '');
    const district = find(this.districts(), this.pending.district);
    this.districtCode.set(district ? String(district.code) : '');
    const ward = find(this.wards(), this.pending.ward);
    this.wardCode.set(ward ? String(ward.code) : '');
    if ((this.pending.province && !province) || (this.pending.district && !district) || (this.pending.ward && !ward)) {
      this.restoreNotice.set('Địa chỉ đã lưu chưa khớp danh mục. Vui lòng chọn lại địa phương.');
    }
    this.publish();
  }

  private publish(): void {
    const selection: AddressGeographySelection = {
      province: this.province()?.name || '',
      district: this.mode() === 'legacy' ? this.district()?.name || '' : '',
      ward: this.ward()?.name || '',
      mode: this.mode(),
      valid: Boolean(this.province() && this.ward() && (this.mode() === 'current' || this.district())),
    };
    this.pending = selection;
    this.signature = JSON.stringify([selection.province, selection.district, selection.ward]);
    this.selectionChange.emit(selection);
  }
}

function normalize(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/^(thanh pho|tinh|tp\.?|quan|huyen|phuong|xa)\s+/i, '').trim();
}
