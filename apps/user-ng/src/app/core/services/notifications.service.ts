import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';

/** A persisted member notification shown in the storefront header. */
export interface MemberNotification {
  id: string;
  type: string;
  title: string;
  content: string;
  link: string | null;
  is_read: boolean;
  created_at: string;
}

/** Loads member-only notifications and owns their read state. */
@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly rows = signal<MemberNotification[]>([]);
  private requestVersion = 0;

  readonly notifications = this.rows.asReadonly();
  readonly unreadCount = computed(() => this.rows().filter((item) => !item.is_read).length);
  /** Treat legacy sessions without a role as storefront members; explicit admins stay excluded. */
  readonly isMember = computed(() => {
    const session = this.auth.session();
    if (!session?.userId) return false;
    return session.role !== 'admin';
  });

  constructor() {
    effect(() => {
      const member = this.isMember();
      if (member) void this.refresh();
      else this.rows.set([]);
    });
  }

  /** Refreshes the current member inbox without exposing guest or admin data. */
  async refresh(): Promise<void> {
    if (!this.isMember()) return;
    const version = ++this.requestVersion;
    try {
      const response = await firstValueFrom(this.api.get<{ notifications?: MemberNotification[] }>('/api/user/notifications'));
      if (version === this.requestVersion) this.rows.set(response.notifications || []);
    } catch {
      if (version === this.requestVersion) this.rows.set([]);
    }
  }

  /** Marks one notification read and keeps the badge consistent immediately. */
  async markRead(notification: MemberNotification): Promise<void> {
    if (notification.is_read) return;
    this.rows.update((items) => items.map((item) => item.id === notification.id ? { ...item, is_read: true } : item));
    try { await firstValueFrom(this.api.post(`/api/user/notifications/${encodeURIComponent(notification.id)}/read`, {})); } catch { /* best effort */ }
  }

  /** Marks every visible notification read after the member opens the inbox. */
  async markAllRead(): Promise<void> {
    if (!this.unreadCount()) return;
    this.rows.update((items) => items.map((item) => ({ ...item, is_read: true })));
    try { await firstValueFrom(this.api.post('/api/user/notifications/read-all', {})); } catch { /* best effort */ }
  }
}
