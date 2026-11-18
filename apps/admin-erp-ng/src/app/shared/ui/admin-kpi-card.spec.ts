import { TestBed } from '@angular/core/testing';
import { AdminErpKpiCard } from './admin-kpi-card';

describe('AdminErpKpiCard', () => {
  async function boot() {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({ imports: [AdminErpKpiCard] }).compileComponents();
    return TestBed.createComponent(AdminErpKpiCard);
  }

  it('renders the real value when loaded', async () => {
    const fixture = await boot();
    fixture.componentRef.setInput('label', 'Đơn chờ xử lý');
    fixture.componentRef.setInput('value', '12');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Đơn chờ xử lý');
    expect(fixture.nativeElement.textContent).toContain('12');
  });

  it('renders a skeleton instead of a zero while loading', async () => {
    const fixture = await boot();
    fixture.componentRef.setInput('label', 'Doanh thu');
    fixture.componentRef.setInput('value', '999');
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.erp-skeleton')).not.toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('999');
  });

  it('emits selected on click and Enter when interactive mode is enabled', async () => {
    const fixture = await boot();
    const selected = vi.fn();
    fixture.componentInstance.selected.subscribe(selected);
    fixture.componentRef.setInput('label', 'Cần xử lý');
    fixture.componentRef.setInput('value', '5');
    fixture.componentRef.setInput('interactive', true);
    fixture.componentRef.setInput('active', true);
    fixture.detectChanges();

    const card = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.kpi')!;
    expect(card.getAttribute('role')).toBe('button');
    expect(card.classList).toContain('is-active');
    card.click();
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(selected).toHaveBeenCalledTimes(2);
  });
});
