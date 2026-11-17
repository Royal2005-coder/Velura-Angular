import { TestBed } from '@angular/core/testing';
import { AdminErpGradientPicker, expandHex } from './admin-gradient-picker';

describe('AdminErpGradientPicker', () => {
  it('expands 3-digit hex safely for color inputs without mutating value on mount', () => {
    expect(expandHex('#fff')).toBe('#ffffff');
    expect(expandHex('#EEE')).toBe('#eeeeee');

    TestBed.configureTestingModule({ imports: [AdminErpGradientPicker] });
    const fixture = TestBed.createComponent(AdminErpGradientPicker);
    fixture.componentRef.setInput('value', 'linear-gradient(115deg, #fff 0%, #eee 100%)');

    const emitted: string[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => emitted.push(v));
    fixture.detectChanges();

    // Must NEVER emit on mount
    expect(emitted.length).toBe(0);

    const root = fixture.nativeElement as HTMLElement;
    const startInput = root.querySelector<HTMLInputElement>('[data-testid="grad-color-start"]')!;
    const endInput = root.querySelector<HTMLInputElement>('[data-testid="grad-color-end"]')!;
    expect(startInput.value).toBe('#ffffff');
    expect(endInput.value).toBe('#eeeeee');

    // Selecting a curated swatch emits valid linear-gradient(...)
    root.querySelector<HTMLButtonElement>('[data-testid="grad-swatch-midnight-slate"]')?.click();
    expect(emitted.at(-1)).toMatch(/^linear-gradient\(115deg, #2D2F36 0%, #3D414B 48%, #525866 100%\)$/);
  });

  it('collapses into a compact lót nền bar when deemphasized (cover mode) until expanded', () => {
    TestBed.configureTestingModule({ imports: [AdminErpGradientPicker] });
    const fixture = TestBed.createComponent(AdminErpGradientPicker);
    fixture.componentRef.setInput('deemphasized', true);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.grad-swatches')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-testid="grad-expand-cover"]')?.click();
    fixture.detectChanges();
    expect(root.querySelector('.grad-swatches')).not.toBeNull();
  });
});
