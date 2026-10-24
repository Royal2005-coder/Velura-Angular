import { TestBed } from '@angular/core/testing';
import { AdminErpDataTable, AdminTableColumn } from './admin-data-table';

const columns: readonly AdminTableColumn[] = [
  { key: 'name', label: 'Tên', value: (row) => String((row as { name: string }).name) },
  {
    key: 'status',
    label: 'Trạng thái',
    value: () => '',
    badge: (row) => ({ label: String((row as { status: string }).status), tone: 'success' }),
  },
];

describe('AdminErpDataTable', () => {
  async function boot() {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({ imports: [AdminErpDataTable] }).compileComponents();
    return TestBed.createComponent(AdminErpDataTable);
  }

  it('renders text and badge cells', async () => {
    const fixture = await boot();
    fixture.componentRef.setInput('columns', columns);
    fixture.componentRef.setInput('rows', [{ name: 'Lụa Hà Nội', status: 'Đã duyệt' }]);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Lụa Hà Nội');
    expect(text).toContain('Đã duyệt');
  });

  it('shows an empty state when there are no rows', async () => {
    const fixture = await boot();
    fixture.componentRef.setInput('columns', columns);
    fixture.componentRef.setInput('rows', []);
    fixture.componentRef.setInput('emptyTitle', 'Chưa có dữ liệu');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Chưa có dữ liệu');
  });

  it('emits a row only when clickable', async () => {
    const fixture = await boot();
    const selected = vi.fn();
    fixture.componentInstance.rowSelected.subscribe(selected);
    fixture.componentRef.setInput('columns', columns);
    fixture.componentRef.setInput('rows', [{ name: 'A', status: 'OK' }]);
    fixture.componentRef.setInput('clickable', false);
    fixture.detectChanges();

    (fixture.nativeElement as HTMLElement).querySelector('tbody tr')?.dispatchEvent(new Event('click'));
    expect(selected).not.toHaveBeenCalled();

    fixture.componentRef.setInput('clickable', true);
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector('tbody tr')?.dispatchEvent(new Event('click'));
    expect(selected).toHaveBeenCalledTimes(1);
  });
});
