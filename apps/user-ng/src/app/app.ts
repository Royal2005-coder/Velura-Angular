import { Component, DestroyRef, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SessionSyncService } from './core/services/session-sync.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
})
export class App {
  private readonly sessionSync = inject(SessionSyncService);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    this.sessionSync.start(this.destroyRef);
    void this.sessionSync.syncNow(true);
  }
}
