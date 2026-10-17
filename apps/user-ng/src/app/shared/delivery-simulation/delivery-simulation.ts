import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';

/** A labeled visual demonstration; only the order API can establish actual delivery. */
@Component({
  selector: 'app-delivery-simulation',
  templateUrl: './delivery-simulation.html',
  styleUrl: './delivery-simulation.css',
})
export class DeliverySimulation {
  readonly orderCode = input.required<string>();
  readonly destination = input('Địa chỉ nhận hàng');
  readonly delivered = input(false);
  readonly running = signal(false);
  readonly progress = signal(15);
  readonly displayedProgress = computed(() => this.delivered() ? 100 : this.progress());
  readonly position = computed(() => {
    const points = [[42, 152], [132, 152], [132, 86], [250, 86], [250, 152], [350, 152]];
    const distance = this.displayedProgress() / 100 * (points.length - 1);
    const index = Math.min(points.length - 2, Math.floor(distance));
    const fraction = distance - index;
    return `translate(${points[index][0] + (points[index + 1][0] - points[index][0]) * fraction},${points[index][1] + (points[index + 1][1] - points[index][1]) * fraction})`;
  });
  private timer?: ReturnType<typeof setInterval>;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearInterval(this.timer));
  }

  /** Plays or pauses a local route animation without changing order or shipment records. */
  toggle(): void {
    if (this.delivered()) return;
    if (this.running()) { clearInterval(this.timer); this.running.set(false); return; }
    if (this.progress() >= 95) this.progress.set(15);
    this.running.set(true);
    this.timer = setInterval(() => {
      if (this.delivered() || this.progress() >= 95) { clearInterval(this.timer); this.running.set(false); return; }
      this.progress.update(value => Math.min(95, value + 2));
    }, 500);
  }
}
