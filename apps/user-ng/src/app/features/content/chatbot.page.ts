import { Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, catchError, exhaustMap, filter, timer } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { OrderAccountApiStore } from '../../core/services/order-account-api.store';
import {
  ChatAttachment,
  ChatBlog,
  ChatSendResponse,
  ChatMessage,
  ChatProduct,
  ChatSession,
  ChatbotService,
} from '../../core/services/chatbot.service';
import { CartStore } from '../../core/services/cart.store';
import { formatVnd, toPublicAsset } from '../../core/utils/money';
import { useBodyClass } from '../../core/utils/body-class';

function localGreeting(): ChatMessage {
  return {
    message_id: 'local-greeting',
    sender: 'bot',
    text: 'welcome',
    created_at: new Date().toISOString(),
    metadata: { local_greeting: true },
  };
}

@Component({
  selector: 'app-chatbot-page',
  imports: [RouterLink],
  host: { class: 'page-chatbot' },
  templateUrl: './chatbot.page.html',
})
export class ChatbotPage {
  private readonly chatbot = inject(ChatbotService);
  private readonly cart = inject(CartStore);
  private readonly route = inject(ActivatedRoute);
  private readonly messagesEl = viewChild<ElementRef<HTMLElement>>('messagesPane');
  private readonly destroy = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  readonly orderAccount = inject(OrderAccountApiStore);
  readonly selectedOrderId = signal('');
  readonly otpTarget = signal('');
  readonly otpCode = signal('');
  readonly otpSent = signal(false);
  readonly orderBusy = signal(false);
  readonly orderFeedback = signal('');
  readonly caseOutcome = signal('');
  readonly caseRating = signal<number | null>(null);
  readonly previousSessionId = signal('');
  readonly ratingDraft = signal(5);
  readonly lifecycleNote = signal('');
  private generation = 0;
  readonly handoffStatus = signal<'ai' | 'requested' | 'assigned' | 'closed'>('ai');
  readonly humanTakeover = computed(() => this.handoffStatus() === 'assigned');
  readonly chatError = signal('');
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  readonly draft = signal('');
  readonly loading = signal(false);
  readonly sessionId = signal('');
  readonly sidebarOpen = signal(false);
  readonly sessions = signal<ChatSession[]>([]);
  readonly productsById = signal<Record<string, ChatProduct>>({});
  readonly blogsById = signal<Record<string, ChatBlog>>({});
  readonly previewName = signal('');
  readonly previewUrl = signal('');
  readonly messages = signal<ChatMessage[]>([localGreeting()]);
  private attachment: ChatAttachment | null = null;

  constructor() {
    useBodyClass('page-chatbot');
    this.chatbot.clearSessionId();
    this.refreshSessions();
    const initialQuery = this.route.snapshot.queryParamMap.get('q');
    const initialSession = this.route.snapshot.queryParamMap.get('session');
    if (initialSession) this.openSession({ session_id: initialSession, handoff_status: this.chatbot.activeHandoff() });
    else if (initialQuery?.trim()) setTimeout(() => this.send(initialQuery.trim()), 100);
    let identity = this.auth.session();
    effect(() => { const session = this.auth.session(); if (session !== identity) { identity = session; untracked(() => { this.newChat(); this.sessions.set([]); this.refreshSessions(); }); } });
    timer(3000, 3000).pipe(
      filter(() => !!this.sessionId() && !this.loading()),
      exhaustMap(() => {
        const id = this.sessionId(), generation = this.generation;
        return this.chatbot.listMessages(id, this.chatbot.guestId()).pipe(
          filter(() => generation === this.generation && id === this.sessionId()),
          catchError(() => { if (generation === this.generation) this.chatError.set('Chưa cập nhật được hội thoại. Hệ thống sẽ tự thử lại.'); return EMPTY; }),
        );
      }),
      takeUntilDestroyed(this.destroy),
    ).subscribe({ next: data => { this.chatError.set(''); this.adoptTranscript(data); this.scrollToBottom(); } });
  }

  /**
   * Sends a user turn through the original chat API.
   */
  send(text = this.draft()): void {
    const message = text.trim();
    if ((!message && !this.attachment) || this.loading() || this.handoffStatus() === 'closed') {
      return;
    }
    this.draft.set('');
    const payloadText = message || 'Gửi hình ảnh đính kèm';
    const userMessage: ChatMessage = {
      message_id: `tmp-user-${Date.now()}`,
      sender: 'user',
      text: 'Đang gửi và kiểm tra nội dung…',
      created_at: new Date().toISOString(),
      moderation_status: 'pending',
    };
    const typing: ChatMessage = {
      message_id: 'typing',
      sender: 'bot',
      text: 'Velura Stylist đang chọn gợi ý phù hợp...',
      created_at: new Date().toISOString(),
      metadata: { typing: true },
    };
    this.messages.update((rows) => [...rows.filter((row) => !row.metadata?.local_greeting), userMessage, ...(this.humanTakeover() ? [] : [typing])]);
    this.loading.set(true);
    this.scrollToBottom();
    const generation = this.generation;
    const attachment = this.attachment;
    this.clearPreview();
    this.chatbot
      .sendMessage({
        sessionId: this.sessionId() || undefined,
        guestId: this.chatbot.guestId(),
        mode: localStorage.getItem('velura_token') ? 'user' : 'guest',
        message: payloadText,
        attachment,
        orderId: this.selectedOrderId() || undefined,
        guestAccessToken: this.orderAccount.guestAccessToken() || undefined,
      })
      .subscribe({
        next: (data) => {
          if (generation !== this.generation) return;
          if (data.session?.session_id) {
            this.sessionId.set(data.session.session_id);
            this.chatbot.saveSessionId(data.session.session_id);
          }
          this.adoptTranscript(data);
          this.loading.set(false);
          this.refreshSessions();
          this.scrollToBottom();
        },
        error: () => {
          if (generation !== this.generation) return;
          this.messages.update(rows => rows.filter(row => row.message_id !== 'typing' && row.message_id !== userMessage.message_id));
          this.draft.set(message);
          this.chatError.set('Chưa gửi được tin nhắn. Vui lòng thử lại hoặc liên hệ CSKH.');
          this.loading.set(false);
          this.scrollToBottom();
        },
      });
  }

  /**
   * Submits the original chat form.
   */
  onSubmit(event: Event): void {
    event.preventDefault();
    this.send();
  }

  /**
   * Binds the original chat input to ViewModel state.
   */
  onDraftInput(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  /**
   * Starts a fresh conversation with the original greeting card.
   */
  newChat(): void {
    this.generation++;
    this.loading.set(false);
    this.handoffStatus.set('ai');
    this.chatbot.activeHandoff.set('ai');
    this.chatbot.activeSession.set('');
    this.chatError.set('');
    this.sessionId.set('');
    this.chatbot.clearSessionId();
    this.draft.set('');
    this.clearPreview();
    this.messages.set([localGreeting()]);
    this.productsById.set({}); this.blogsById.set({});
    this.caseOutcome.set(''); this.caseRating.set(null); this.lifecycleNote.set('');
    this.previousSessionId.set('');
    this.selectedOrderId.set(''); this.otpSent.set(false); this.otpCode.set(''); this.otpTarget.set(''); this.orderFeedback.set(''); this.orderBusy.set(false);
    this.sidebarOpen.set(false);
  }

  /**
   * Toggles the original history sidebar on mobile.
   */
  toggleSidebar(): void {
    this.sidebarOpen.update((open) => !open);
  }

  /**
   * Opens a stored session from the original history list.
   */
  openSession(session: ChatSession): void {
    this.generation++;
    const generation = this.generation;
    this.handoffStatus.set(session.handoff_status || 'ai');
    this.chatbot.activeHandoff.set(this.handoffStatus());
    this.chatbot.activeSession.set(session.session_id);
    this.sessionId.set(session.session_id);
    this.chatbot.saveSessionId(session.session_id);
    this.sidebarOpen.set(false);
    this.loading.set(true);
    this.chatbot.listMessages(session.session_id, this.chatbot.guestId()).subscribe({
      next: (data) => {
        if (generation !== this.generation) return;
        this.adoptTranscript(data);
        this.loading.set(false);
        this.scrollToBottom();
      },
      error: () => {
        if (generation !== this.generation) return;
        this.loading.set(false);
        this.chatError.set('Chưa tải được hội thoại. Hệ thống sẽ tự thử lại.');
      },
    });
  }

  /** Human escalation uses the normal customer-turn API; the backend decides ticket creation. */
  requestHuman(): void { if (!this.humanTakeover()) this.send('Tôi muốn gặp nhân viên CSKH.'); }

  /** Reload authoritative messages and routing without generating an AI turn. */
  refreshMessages(): void {
    const id = this.sessionId(), generation = this.generation;
    if (!id || this.loading()) return;
    this.chatError.set('');
    this.chatbot.listMessages(id, this.chatbot.guestId()).pipe(takeUntilDestroyed(this.destroy)).subscribe({
      next: data => { if (generation === this.generation) this.adoptTranscript(data); },
      error: () => { if (generation === this.generation) this.chatError.set('Chưa tải được tin nhắn CSKH.'); },
    });
  }

  private adoptTranscript(data: ChatSendResponse): void {
    const status = data.session?.handoff_status || data.handoff?.status || this.handoffStatus();
    this.handoffStatus.set(status);
    this.chatbot.activeHandoff.set(status);
    this.chatbot.activeSession.set(this.sessionId());
    this.caseOutcome.set(data.session?.metadata?.outcome?.resolution || '');
    this.caseRating.set(data.session?.metadata?.outcome?.rating ?? data.session?.metadata?.rating ?? null);
    this.previousSessionId.set(data.session?.metadata?.previous_session_id || '');
    this.rememberProducts(data.products || []);
    this.rememberBlogs(data.blogs || []);
    const rows = data.messages || [];
    this.messages.set(rows.length ? rows : status === 'ai' ? [localGreeting()] : []);
  }

  /** Loads only owned orders from the existing account Model. */
  async loadChatOrders(): Promise<void> { await this.orderAccount.refresh(); }

  /** Selects an owned order; unverified or expired guest proof cannot be forwarded. */
  selectChatOrder(event: Event): void {
    const id = (event.target as HTMLSelectElement).value;
    const order = this.orderAccount.orders().find(row => row.orderId === id);
    this.selectedOrderId.set(order && this.orderAccount.canAccess(order) ? id : '');
  }

  /** Updates an OTP or lifecycle draft without persisting sensitive data to chat history. */
  setCaseInput(field: 'otpTarget' | 'otpCode' | 'lifecycleNote', event: Event): void {
    this[field].set((event.target as HTMLInputElement).value);
  }

  /** Requests a real order-code OTP through the existing order-account API. */
  async sendOrderOtp(): Promise<void> {
    if (this.orderBusy() || !this.otpTarget().trim()) return;
    this.orderBusy.set(true); this.orderFeedback.set('');
    const generation = this.generation;
    try { await this.orderAccount.sendOtp(this.otpTarget(), 'code'); if (generation !== this.generation) return; this.otpSent.set(true); this.orderFeedback.set('Đã gửi mã xác thực qua kênh liên hệ của đơn hàng.'); }
    catch (error) { if (generation === this.generation) this.orderFeedback.set(error instanceof Error ? error.message : 'Không gửi được mã xác thực.'); }
    finally { if (generation === this.generation) this.orderBusy.set(false); }
  }

  /** Verifies guest ownership before loading selectable orders; OTP never becomes a chat turn. */
  async verifyOrderOtp(): Promise<void> {
    if (this.orderBusy() || !this.otpCode().trim()) return;
    this.orderBusy.set(true); this.orderFeedback.set('');
    const generation = this.generation;
    try { await this.orderAccount.verifyOtp(this.otpCode()); if (generation !== this.generation) return; this.otpCode.set(''); this.orderFeedback.set('Đã xác thực. Chọn đơn hàng để trao đổi.'); }
    catch (error) { if (generation === this.generation) this.orderFeedback.set(error instanceof Error ? error.message : 'Không xác thực được đơn hàng.'); }
    finally { if (generation === this.generation) this.orderBusy.set(false); }
  }

  /** Selects a bounded customer satisfaction score. */
  setRating(event: Event): void { const rating = Number((event.target as HTMLSelectElement).value); if (rating >= 1 && rating <= 5) this.ratingDraft.set(rating); }

  /** Reopens the same owned case or submits a real rating after closure. */
  updateLifecycle(action: 'reopen' | 'rating'): void {
    const id = this.sessionId(), generation = this.generation;
    if (!id || this.loading() || this.handoffStatus() !== 'closed') return;
    this.loading.set(true); this.chatError.set('');
    this.chatbot.lifecycle(id, { guestId: this.chatbot.guestId(), action, text: this.lifecycleNote().trim(), ...(action === 'rating' ? { rating: this.ratingDraft() } : {}) }).pipe(takeUntilDestroyed(this.destroy)).subscribe({
      next: data => {
        if (generation !== this.generation) return;
        if (data.session?.session_id) { this.sessionId.set(data.session.session_id); this.chatbot.saveSessionId(data.session.session_id); }
        this.loading.set(false); this.adoptTranscript(data); this.refreshSessions();
      },
      error: () => { if (generation !== this.generation) return; this.loading.set(false); this.chatError.set('Chưa lưu được thao tác. Vui lòng thử lại.'); },
    });
  }

  /**
   * Deletes a stored session using the original DELETE contract.
   */
  deleteSession(session: ChatSession, event: Event): void {
    event.stopPropagation();
    this.chatbot.deleteSession(session.session_id, this.chatbot.guestId()).subscribe({
      next: () => {
        this.sessions.update((rows) => rows.filter((row) => row.session_id !== session.session_id));
        if (this.sessionId() === session.session_id) {
          this.newChat();
        }
      },
    });
  }

  /**
   * Opens the original image attachment picker.
   */
  pickImage(): void {
    this.fileInput()?.nativeElement.click();
  }

  /**
   * Reads a selected image as the original attachment payload.
   */
  onFileChange(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result || '');
      this.attachment = {
        type: 'image',
        data,
        filename: file.name.replace(/\.[^/.]+$/, '') + '.jpg',
        mimeType: file.type || 'image/jpeg',
      };
      this.previewName.set(file.name);
      this.previewUrl.set(data);
    };
    reader.readAsDataURL(file);
  }

  /**
   * Clears the pending image attachment.
   */
  clearPreview(): void {
    this.attachment = null;
    this.previewName.set('');
    this.previewUrl.set('');
    const input = this.fileInput()?.nativeElement;
    if (input) {
      input.value = '';
    }
  }

  /**
   * Escapes then lightly formats bot markdown like vanilla `formatBotText`.
   */
  formatBotText(text: string): string {
    const escaped = String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  }

  /**
   * Formats a chat timestamp for the original message footer.
   */
  formatTime(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  }

  /**
   * Formats a session date for the original history list.
   */
  formatSessionDate(value?: string): string {
    if (!value) {
      return '';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return date.toLocaleDateString('vi-VN');
  }

  /**
   * Resolves product cards attached to a bot message.
   */
  productsFor(message: ChatMessage): ChatProduct[] {
    const ids = Array.from(new Set([...(message.product_ids || []), ...(message.metadata?.product_ids || [])]));
    return ids.map((id) => this.productsById()[id]).filter((product): product is ChatProduct => Boolean(product));
  }

  /**
   * Resolves blog cards attached to a bot message.
   */
  blogsFor(message: ChatMessage): ChatBlog[] {
    const ids = message.metadata?.blog_ids || [];
    return ids.map((id) => this.blogsById()[id]).filter(Boolean);
  }

  /**
   * Public product image helper for chat cards.
   */
  productImage(product: ChatProduct): string {
    return toPublicAsset(product.image_url, '/assets/images/placeholder.jpg');
  }

  /**
   * Public blog image helper for chat cards.
   */
  blogImage(blog: ChatBlog): string {
    return toPublicAsset(blog.image_url, '/assets/images/placeholder.jpg');
  }

  /**
   * Public product price helper for chat cards.
   */
  productPrice(product: ChatProduct): string {
    return formatVnd(product.sale_price || product.price || product.base_price);
  }

  /**
   * Adds a recommended chat product to the original cart payload.
   */
  addProduct(product: ChatProduct): void {
    const variantId = product.variant?.variant_id;
    const price = product.sale_price ?? product.price ?? product.base_price;
    if (!variantId || this.isOutOfStock(product) || price == null || !Number.isFinite(price) || price <= 0) return;
    this.cart.addItem({
      variant_id: variantId,
      product_id: product.product_id,
      product_name: product.name,
      product_image: this.productImage(product),
      quantity: 1,
      unit_price: price,
      color: product.variant?.color,
      size: product.variant?.size,
    });
  }

  /**
   * Returns whether a chat product is currently in stock.
   */
  isOutOfStock(product: ChatProduct): boolean {
    return !product.variant?.variant_id || (product.variant.stock_quantity ?? 0) <= 0;
  }

  private rememberProducts(products: ChatProduct[]): void {
    this.productsById.set(Object.fromEntries(products.filter(product => product.product_id).map(product => [product.product_id, product])));
  }

  private rememberBlogs(blogs: ChatBlog[]): void {
    this.blogsById.set(Object.fromEntries(blogs.filter(blog => blog.blog_id).map(blog => [blog.blog_id, blog])));
  }

  private refreshSessions(): void {
    const identity = this.auth.session();
    this.chatbot.listSessions(this.chatbot.guestId()).pipe(takeUntilDestroyed(this.destroy)).subscribe({
      next: (data) => { if (identity === this.auth.session()) this.sessions.set(data.rows || []); },
      error: () => undefined,
    });
  }

  private scrollToBottom(): void {
    queueMicrotask(() => {
      const el = this.messagesEl()?.nativeElement;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }
}
