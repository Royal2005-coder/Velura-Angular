import { TestBed } from '@angular/core/testing';
import { AdminErpPagination } from './admin-pagination';

describe('AdminErpPagination', () => {
  async function boot() {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({ imports: [AdminErpPagination] }).compileComponents();
    return TestBed.createComponent(AdminErpPagination);
  }

  it('emits the selected page', async () => {
    const fixture = await boot();
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    fixture.componentRef.setInput('page', 1);
    fixture.componentRef.setInput('pageCount', 10);
    fixture.componentRef.setInput('label', 'Hiển thị 1 - 10 / 100 nhật ký');
    fixture.detectChanges();

    const buttons = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.pagination__btn'));
    const pageTwo = buttons.find((button) => button.textContent?.trim() === '2');
    pageTwo?.click();

    expect(changed).toHaveBeenCalledWith(2);
  });

  it('does not emit when the current page is selected again', async () => {
    const fixture = await boot();
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    fixture.componentRef.setInput('page', 2);
    fixture.componentRef.setInput('pageCount', 3);
    fixture.detectChanges();

    const active = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.is-active');
    active?.click();

    expect(changed).not.toHaveBeenCalled();
  });
});
