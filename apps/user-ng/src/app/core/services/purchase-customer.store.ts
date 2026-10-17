import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import type { DemoAddress, DemoOrder } from './purchase-demo.store';

/** Account address identity survives editing and profile reloads. */
interface SavedAddress extends DemoAddress { id: string; }

/** Actual account address book; production checkout never reads preview account fixtures. */
@Injectable({ providedIn: 'root' })
export class PurchaseCustomerStore {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  readonly userId = computed(() => this.auth.session()?.userId || null);
  readonly member = computed(() => this.userId() !== null);
  readonly addresses = signal<SavedAddress[]>([]);
  readonly orders = signal<DemoOrder[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  private generation = 0;
  private readVersion = 0;
  private writing = false;

  constructor() {
    effect(() => {
      const userId = this.auth.session()?.userId || null;
      untracked(() => {
        this.generation++;
        this.addresses.set([]);
        this.orders.set([]);
        this.error.set('');
        this.loading.set(false);
        if (userId) void this.loadAddresses();
      });
    });
  }

  /** Load the current account only; previous requests cannot repopulate a changed session. */
  async loadAddresses(): Promise<void> {
    const userId = this.userId();
    if (!userId) return;
    const generation = this.generation;
    const session = this.auth.session();
    const version = ++this.readVersion;
    const current = () => generation === this.generation && userId === this.userId() && session === this.auth.session() && version === this.readVersion;
    this.loading.set(true);
    this.error.set('');
    try {
      const data = await firstValueFrom(this.api.get<{ saved_addresses?: Record<string, unknown>[] }>('/api/user/profile'));
      if (!current()) return;
      this.addresses.set((data.saved_addresses || []).map((row) => ({
        id: String(row['id'] || crypto.randomUUID()), name: String(row['name'] || row['recipient_name'] || ''),
        phone: String(row['phone'] || row['recipient_phone'] || ''), email: String(row['email'] || ''),
        province: String(row['province'] || ''), district: String(row['district'] || ''), ward: String(row['ward'] || ''),
        detail: String(row['detail'] || row['street'] || row['address'] || ''), isDefault: row['is_default'] === true,
      })));
    } catch (error) {
      if (current()) this.error.set(error instanceof Error ? error.message : 'Không tải được sổ địa chỉ.');
    } finally { if (current()) this.loading.set(false); }
  }

  /** Presentation ownership is account-scoped; API authorization remains authoritative. */
  ownsOrder(order: DemoOrder): boolean { return this.member() && order.userId === this.userId(); }

  /** A member may resume only their own persisted order. */
  canAccess(order: DemoOrder): boolean { return this.ownsOrder(order); }

  /** Persist an address before presenting it as saved, retaining its original identity. */
  async saveAddress(address: DemoAddress, index = -1): Promise<number> {
    const rows = this.addresses();
    const editing = index >= 0 && index < rows.length;
    const next: SavedAddress = { ...address, id: editing ? rows[index].id : crypto.randomUUID(), isDefault: address.isDefault || !rows.length };
    const updated = rows.map((row, position) => editing && position === index ? next : { ...row, isDefault: next.isDefault ? false : row.isDefault });
    if (!editing) updated.push(next);
    if (!updated.some((row) => row.isDefault)) updated[0] = { ...updated[0], isDefault: true };
    await this.persist(updated);
    return editing ? index : updated.length - 1;
  }

  /** Removing an address cannot mutate historical delivery snapshots. */
  async removeAddress(index: number): Promise<void> {
    const updated = this.addresses().filter((_, position) => position !== index);
    if (updated.length && !updated.some((row) => row.isDefault)) updated[0] = { ...updated[0], isDefault: true };
    await this.persist(updated);
  }

  private async persist(addresses: SavedAddress[]): Promise<void> {
    const userId = this.userId();
    const generation = this.generation;
    const session = this.auth.session();
    if (!userId) throw new Error('Vui lòng đăng nhập để lưu địa chỉ.');
    if (this.writing) throw new Error('Đang lưu sổ địa chỉ. Vui lòng chờ hoàn tất.');
    this.writing = true;
    this.readVersion++;
    try {
      await firstValueFrom(this.api.patch('/api/user/addresses', { addresses: addresses.map((row) => ({
        id: row.id, name: row.name, phone: row.phone, email: row.email, province: row.province,
        district: row.district, ward: row.ward, detail: row.detail,
        address: [row.detail, row.ward, row.district, row.province].filter(Boolean).join(', '), is_default: row.isDefault === true,
      })) }));
      if (generation !== this.generation || userId !== this.userId() || session !== this.auth.session()) throw new Error('Tài khoản đã thay đổi. Vui lòng mở lại sổ địa chỉ.');
      this.addresses.set(addresses);
    } finally { this.writing = false; }
  }
}
