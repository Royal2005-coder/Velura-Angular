import { Injectable, computed, effect, inject, signal, OnDestroy } from '@angular/core';
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

/** Loads member-only notifications, manages real-time updates and PWA web notifications. */
@Injectable({ providedIn: 'root' })
export class NotificationsService implements OnDestroy {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly rows = signal<MemberNotification[]>([]);
  private requestVersion = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly knownIds = new Set<string>();
  private initialLoadDone = false;

  readonly notifications = this.rows.asReadonly();
  readonly unreadCount = computed(() => this.rows().filter((item) => !item.is_read).length);
  /** Treat legacy sessions without a role as storefront members; explicit admins stay excluded. */
  readonly isMember = computed(() => {
    const session = this.auth.session();
    if (!session?.userId) return false;
    return session.role !== 'admin';
  });

  /** Checks if native browser Notification API is available in this environment. */
  readonly isPushSupported = typeof window !== 'undefined' && 'Notification' in window;

  constructor() {
    effect(() => {
      const member = this.isMember();
      if (member) {
        void this.refresh();
        this.startPolling();
      } else {
        this.rows.set([]);
        this.knownIds.clear();
        this.initialLoadDone = false;
        this.stopPolling();
      }
    });

    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  ngOnDestroy(): void {
    this.stopPolling();
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  private readonly onVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible' && this.isMember()) {
      void this.refresh();
    }
  };

  private startPolling(): void {
    if (this.pollTimer || typeof window === 'undefined') return;
    this.pollTimer = setInterval(() => {
      if (this.isMember()) void this.refresh();
    }, 45000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Requests permission for Browser Push Notifications as per PWA standards.
   */
  async requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
    if (!this.isPushSupported) return 'unsupported';
    try {
      return await Notification.requestPermission();
    } catch {
      return 'denied';
    }
  }

  /**
   * Dispatches a local browser notification for high-priority alerts (PWA compliant).
   */
  private triggerBrowserNotification(notif: MemberNotification): void {
    if (!this.isPushSupported || Notification.permission !== 'granted') return;
    try {
      const browserNotif = new Notification(notif.title, {
        body: notif.content,
        icon: '/favicon.ico',
        tag: `velura-notif-${notif.id}`,
        data: { link: notif.link }
      });
      browserNotif.onclick = () => {
        window.focus();
        if (notif.link) {
          window.location.href = notif.link;
        }
        browserNotif.close();
      };
    } catch (e) {
      console.warn('[PWA Notification] Failed to show browser notification:', e);
    }
  }

  /** Refreshes the current member inbox without exposing guest or admin data. */
  async refresh(): Promise<void> {
    if (!this.isMember()) return;
    const version = ++this.requestVersion;
    try {
      const response = await firstValueFrom(this.api.get<{ notifications?: MemberNotification[] }>('/api/user/notifications'));
      if (version === this.requestVersion) {
        const list = response.notifications || [];
        this.rows.set(list);

        // Detect new unread notifications arriving after initial load
        if (this.initialLoadDone) {
          for (const item of list) {
            if (!item.is_read && !this.knownIds.has(item.id)) {
              this.triggerBrowserNotification(item);
            }
          }
        }
        for (const item of list) {
          this.knownIds.add(item.id);
        }
        this.initialLoadDone = true;
      }
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

