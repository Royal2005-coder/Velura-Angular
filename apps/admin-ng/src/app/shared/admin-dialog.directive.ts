import { DOCUMENT } from '@angular/common';
import { AfterViewInit, DestroyRef, Directive, ElementRef, inject, output } from '@angular/core';

const dialogs: HTMLElement[] = [];
let previousOverflow = '';

/** Contains overlay focus and restores the initiating control after dismissal. */
@Directive({ selector: '[appAdminDialog]', host: { role: 'dialog', 'aria-modal': 'true', tabindex: '-1' } })
export class AdminDialogDirective implements AfterViewInit {
  readonly appAdminDialogClose = output<void>();
  private readonly document = inject(DOCUMENT);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly returnFocus = this.document.activeElement;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      const index = dialogs.indexOf(this.element);
      if (index !== -1) dialogs.splice(index, 1);
      this.document.removeEventListener('keydown', this.onKeydown);
      if (!dialogs.length) this.document.body.style.overflow = previousOverflow;
      if (this.returnFocus instanceof HTMLElement && this.returnFocus.isConnected) this.returnFocus.focus();
    });
  }

  /** Focuses the first usable control when the dialog opens. */
  ngAfterViewInit(): void {
    if (!dialogs.length) { previousOverflow = this.document.body.style.overflow; this.document.body.style.overflow = 'hidden'; }
    dialogs.push(this.element);
    this.document.addEventListener('keydown', this.onKeydown);
    (this.controls()[0] ?? this.element).focus();
  }

  private controls(): HTMLElement[] {
    return Array.from(this.element.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'))
      .filter((element) => !element.closest('[hidden]') && element.getAttribute('aria-hidden') !== 'true');
  }

  private readonly onKeydown = (event: KeyboardEvent) => {
    if (dialogs.at(-1) !== this.element) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.appAdminDialogClose.emit(); }
    else if (event.key === 'Tab') {
      const controls = this.controls(), first = controls[0] ?? this.element, last = controls.at(-1) ?? this.element;
      if (event.shiftKey && (this.document.activeElement === first || this.document.activeElement === this.element)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (this.document.activeElement === last || !controls.length)) { event.preventDefault(); first.focus(); }
    }
  };
}
