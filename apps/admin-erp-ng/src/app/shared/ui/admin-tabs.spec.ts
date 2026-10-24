import { TestBed } from '@angular/core/testing';
import { AdminErpTabs } from './admin-tabs';

describe('AdminErpTabs', () => {
  it('emits a change when another tab is selected', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({ imports: [AdminErpTabs] }).compileComponents();
    const fixture = TestBed.createComponent(AdminErpTabs);
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    fixture.componentRef.setInput('tabs', [
      { key: 'operations', label: 'Vận hành' },
      { key: 'business', label: 'Kinh doanh' },
    ]);
    fixture.componentRef.setInput('active', 'operations');
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const buttons = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons[1].click();

    expect(changed).toHaveBeenCalledWith('business');
  });
});
