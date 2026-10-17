import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AdminDialogDirective } from './admin-dialog.directive';

@Component({ imports: [AdminDialogDirective], template: '<button id="trigger" (click)="open.set(true)">Open</button>@if(open()) {<section appAdminDialog (appAdminDialogClose)="open.set(false)"><button id="first">First</button><button id="last">Last</button></section>}' })
class DialogTestHost { readonly open = signal(false); }

describe('AdminDialogDirective', () => {
  it('contains keyboard focus, dismisses on Escape and restores the initiating control', async () => {
    await TestBed.configureTestingModule({ imports: [DialogTestHost] }).compileComponents();
    const fixture = TestBed.createComponent(DialogTestHost);
    document.body.append(fixture.nativeElement); fixture.detectChanges();
    const trigger = document.getElementById('trigger')!;
    trigger.focus(); trigger.click(); fixture.detectChanges();
    expect(document.activeElement?.id).toBe('first');
    document.getElementById('last')!.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
    expect(document.activeElement?.id).toBe('first');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })); fixture.detectChanges();
    expect(fixture.componentInstance.open()).toBe(false);
    expect(document.activeElement).toBe(trigger);
    fixture.destroy(); fixture.nativeElement.remove();
  });
});
