import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  ChatAttachment,
  ChatBlog,
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
  private readonly messagesEl = viewChild<ElementRef<HTMLElement>>('messagesPane');
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
  }

  /**
   * Sends a user turn through the original chat API.
   */
  send(text = this.draft()): void {
    const message = text.trim();
    if ((!message && !this.attachment) || this.loading()) {
      return;
    }
    this.draft.set('');
    const payloadText = message || 'Gửi hình ảnh đính kèm';
    const userMessage: ChatMessage = {
      message_id: `tmp-user-${Date.now()}`,
      sender: 'user',
      text: payloadText,
      created_at: new Date().toISOString(),
      metadata: { attachment: this.attachment },
    };
    const typing: ChatMessage = {
      message_id: 'typing',
      sender: 'bot',
      text: 'Velura Stylist đang chọn gợi ý phù hợp...',
      created_at: new Date().toISOString(),
      metadata: { typing: true },
    };
    this.messages.update((rows) => [...rows.filter((row) => !row.metadata?.local_greeting), userMessage, typing]);
    this.loading.set(true);
    this.scrollToBottom();
    const attachment = this.attachment;
    this.clearPreview();
    this.chatbot
      .sendMessage({
        sessionId: this.sessionId() || undefined,
        guestId: this.chatbot.guestId(),
        mode: localStorage.getItem('velura_token') ? 'user' : 'guest',
        message: payloadText,
        attachment,
      })
      .subscribe({
        next: (data) => {
          if (data.session?.session_id) {
            this.sessionId.set(data.session.session_id);
            this.chatbot.saveSessionId(data.session.session_id);
          }
          this.rememberProducts(data.products || []);
          this.rememberBlogs(data.blogs || []);
          this.messages.update((rows) =>
            rows
              .filter((row) => row.message_id !== userMessage.message_id && row.message_id !== 'typing')
              .concat(data.messages || []),
          );
          this.loading.set(false);
          this.refreshSessions();
          this.scrollToBottom();
        },
        error: () => {
          this.messages.update((rows) =>
            rows.filter((row) => row.message_id !== 'typing').concat({
              message_id: `err-${Date.now()}`,
              sender: 'bot',
              text: 'Hiện mình chưa kết nối được hệ thống tư vấn sản phẩm của Velura. Bạn thử lại sau hoặc liên hệ CSKH nhé.',
              created_at: new Date().toISOString(),
              metadata: { error: true },
            }),
          );
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
    this.sessionId.set('');
    this.chatbot.clearSessionId();
    this.draft.set('');
    this.clearPreview();
    this.messages.set([localGreeting()]);
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
    this.sessionId.set(session.session_id);
    this.chatbot.saveSessionId(session.session_id);
    this.sidebarOpen.set(false);
    this.loading.set(true);
    this.chatbot.listMessages(session.session_id, this.chatbot.guestId()).subscribe({
      next: (data) => {
        this.rememberProducts(data.products || []);
        this.rememberBlogs(data.blogs || []);
        const rows = data.messages || [];
        this.messages.set(rows.length ? rows : [localGreeting()]);
        this.loading.set(false);
        this.scrollToBottom();
      },
      error: () => {
        this.loading.set(false);
      },
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
    this.cart.addItem({
      variant_id: product.variant?.variant_id || product.product_id,
      product_id: product.product_id,
      product_name: product.name,
      product_image: this.productImage(product),
      quantity: 1,
      unit_price: product.sale_price || product.price || product.base_price || 0,
      color: product.variant?.color,
      size: product.variant?.size,
    });
  }

  /**
   * Returns whether a chat product is currently in stock.
   */
  isOutOfStock(product: ChatProduct): boolean {
    return Boolean(product.variant && (product.variant.stock_quantity || 0) <= 0);
  }

  private rememberProducts(products: ChatProduct[]): void {
    if (!products.length) {
      return;
    }
    this.productsById.update((current) => {
      const next = { ...current };
      for (const product of products) {
        if (product.product_id) {
          next[product.product_id] = product;
        }
      }
      return next;
    });
  }

  private rememberBlogs(blogs: ChatBlog[]): void {
    if (!blogs.length) {
      return;
    }
    this.blogsById.update((current) => {
      const next = { ...current };
      for (const blog of blogs) {
        if (blog.blog_id) {
          next[blog.blog_id] = blog;
        }
      }
      return next;
    });
  }

  private refreshSessions(): void {
    this.chatbot.listSessions(this.chatbot.guestId()).subscribe({
      next: (data) => this.sessions.set(data.rows || []),
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
