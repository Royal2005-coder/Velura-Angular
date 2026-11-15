import { AfterViewInit, Directive, ElementRef, OnDestroy, signal } from '@angular/core';

@Directive({
  selector: '[chartBox]',
  standalone: true,
  exportAs: 'chartBox',
})
export class ChartBoxDirective implements AfterViewInit, OnDestroy {
  readonly size = signal({ w: 500, h: 240 });
  private ro?: ResizeObserver;

  constructor(private el: ElementRef<HTMLElement>) {}

  ngAfterViewInit(): void {
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(([e]) => {
        if (!e) return;
        const width = Math.round(e.contentRect.width);
        const height = Math.round(e.contentRect.height);
        if (width > 0 && height > 0) {
          this.size.set({ w: width, h: height });
        }
      });
      this.ro.observe(this.el.nativeElement);
    }

    // Initial check from client bounding box if available
    const rect = this.el.nativeElement.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.size.set({ w: Math.round(rect.width), h: Math.round(rect.height) });
    }
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
  }
}
